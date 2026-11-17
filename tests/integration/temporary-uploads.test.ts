import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisTemporaryUploads, TEMPORARY_UPLOAD_LIFETIME_MS, type TemporaryUploadInput } from '../../src/modules/storage/temporary-uploads.js';

const redisUrl = process.env.REDIS_CACHE_URL;
if (!redisUrl || new URL(redisUrl).hostname !== '127.0.0.1' || Number(new URL(redisUrl).pathname.slice(1)) < 10) throw new Error('ISOLATED_REDIS_REQUIRED');
const prefix = `temporary_upload_test_${randomUUID().replaceAll('-', '')}`;
const client = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 1500, commandTimeout: 2000, retryStrategy: () => null });
client.on('error', () => undefined);
const stores: RedisTemporaryUploads[] = [];
function store(namespace = randomUUID()) {
  const queuePrefix = `${prefix}:${namespace}`;
  const uploads = new RedisTemporaryUploads({ redisCacheUrl: redisUrl!, queuePrefix });
  stores.push(uploads);
  return { uploads, config: { redisCacheUrl: redisUrl!, queuePrefix }, base: `${queuePrefix}:storage:temporary:` };
}
function input(overrides: Partial<TemporaryUploadInput> = {}): TemporaryUploadInput {
  return { userId: randomUUID(), workspaceId: randomUUID(), fileName: '任意文件.bin', mimeType: 'application/octet-stream', sizeBytes: 10, storageDriver: 'aliyun-oss', storageBucket: 'isolated-fixture', ...overrides };
}
async function redisTime() { const [seconds, microseconds] = await client.time(); return Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000); }
async function ownKeys() {
  let cursor = '0'; const keys: string[] = [];
  do { const [next, page] = await client.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100); cursor = next; keys.push(...page); } while (cursor !== '0');
  return keys;
}
beforeAll(async () => { await client.connect(); });
afterAll(async () => {
  await Promise.all(stores.map(value => value.close()));
  const keys = await ownKeys();
  for (let offset = 0; offset < keys.length; offset += 100) await client.del(...keys.slice(offset, offset + 100));
  client.disconnect();
});

describe('temporary uploads: real isolated Redis, no PostgreSQL or OSS calls', () => {
  it('uses Redis time for a 24-hour validity window and retains records/indexes without automatic TTL', async () => {
    const { uploads, base } = store(); const data = input();
    const before = await redisTime();
    const record = await uploads.admit(data, 'private-idempotency-key');
    const after = await redisTime();
    expect(record).toMatchObject({ ...data, status: 'initiated' });
    expect(record.createdAt).toBeGreaterThanOrEqual(before); expect(record.createdAt).toBeLessThanOrEqual(after);
    expect(record.expiresAt - record.createdAt).toBe(24 * 60 * 60 * 1000);
    expect(await client.zscore(`${base}due`, record.id)).toBe(String(record.expiresAt));
    const expectedKeys = [`${base}record:${record.id}`, `${base}due`, `${base}idem:${record.idempotencyHash}`];
    for (const key of expectedKeys) expect(await client.ttl(key)).toBe(-1);
    expect((await ownKeys()).filter(key => key.startsWith(base)).sort()).toEqual(expectedKeys.sort());
    expect(JSON.stringify(record)).not.toContain('private-idempotency-key');
    expect((await ownKeys()).some(key => key.includes('private-idempotency-key'))).toBe(false);
    expect(await uploads.due()).toEqual([]);
  });

  it('shares atomic idempotency across instances without creating duplicate receipts', async () => {
    const { uploads, config, base } = store(); const other = new RedisTemporaryUploads(config); stores.push(other);
    const data = input();
    const records = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? uploads : other).admit(data, 'same-request')));
    expect(new Set(records.map(record => record.id)).size).toBe(1);
    expect(await client.zcard(`${base}due`)).toBe(1);
    expect((await ownKeys()).filter(key => key.startsWith(base))).toHaveLength(3);
    await expect(uploads.admit({ ...data, fileName: 'changed.bin' }, 'same-request')).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(await uploads.admit(data, 'same-request')).toEqual(records[0]);
  });

  it('registers independent uploads across instances without aggregate space, count or rate accounting', async () => {
    const { uploads, config, base } = store(); const other = new RedisTemporaryUploads(config); stores.push(other);
    const data = input({ sizeBytes: 2 * 1024 * 1024 * 1024 });
    const records = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? uploads : other).admit(data, `request-${index}`)));
    expect(new Set(records.map(record => record.id)).size).toBe(20);
    const next = await uploads.admit(data, 'after-concurrent-burst');
    expect(await uploads.get(next.id)).toEqual(next);
    expect(await client.zcard(`${base}due`)).toBe(21);
    // Only receipts, idempotency mappings and the cleanup index are persisted.
    expect((await ownKeys()).filter(key => key.startsWith(base))).toHaveLength(21 * 2 + 1);
  });

  it('scopes idempotency to the user while accepting distinct requests independently', async () => {
    const { uploads, base } = store(); const a = input(), b = input();
    const first = await uploads.admit(a, 'same-key'), second = await uploads.admit(b, 'same-key');
    expect(first.id).not.toBe(second.id); expect(first.idempotencyHash).not.toBe(second.idempotencyHash);
    const next = await uploads.admit(a, 'next-key');
    expect(next.id).not.toBe(first.id);
    expect(await client.zcard(`${base}due`)).toBe(3);
  });

  it('preserves temporary state across service instances and retains ownership after completion', async () => {
    const { uploads, config, base } = store(); const record = await uploads.admit(input(), randomUUID());
    record.remoteUploadId = 'remote-fixture-id'; record.completionStartedAt = record.createdAt + 1;
    await uploads.save(record);
    record.status = 'completed'; record.object = { bytes: 10, contentType: record.mimeType, version: 'oss-version:fixture', etag: '"fixture-etag"', uploadSessionId: record.id };
    await uploads.save(record); await uploads.close();
    const reopened = new RedisTemporaryUploads(config); stores.push(reopened);
    expect(await reopened.get(record.id)).toEqual(record);
    expect(await client.zscore(`${base}due`, record.id)).toBe(String(record.expiresAt));
  });

  it('rejects changes to ownership, size, expiry and idempotency identity', async () => {
    const { uploads } = store(); const record = await uploads.admit(input(), randomUUID());
    for (const changed of [
      { userId: randomUUID() }, { workspaceId: randomUUID() }, { sizeBytes: 11 }, { fileName: 'other.bin' },
      { expiresAt: record.expiresAt + 1 }, { idempotencyHash: 'a'.repeat(64) }, { requestHash: 'b'.repeat(64) },
    ]) await expect(uploads.save({ ...record, ...changed })).rejects.toMatchObject({ code: 'UPLOAD_RECORD_CONFLICT' });
    expect(await uploads.get(record.id)).toEqual(record);
  });

  it('queues cancellation immediately, keeps cleanup retryable and prevents terminal regression', async () => {
    const { uploads } = store(); const record = await uploads.admit(input(), randomUUID());
    const object = { bytes: 10, contentType: record.mimeType, version: 'etag:"fixture"', etag: '"fixture"', uploadSessionId: record.id };
    await uploads.save({ ...record, status: 'completed', object });
    await expect(uploads.save(record)).rejects.toMatchObject({ code: 'UPLOAD_STATE_CONFLICT' });
    await uploads.save({ ...record, status: 'cancelled' });
    expect(await uploads.due()).toEqual([record.id]); expect(await uploads.due()).toEqual([record.id]);
    await expect(uploads.save({ ...record, status: 'completed', object })).rejects.toMatchObject({ code: 'UPLOAD_STATE_CONFLICT' });
  });

  it('returns a bounded due page without consuming records and retains expired ownership until forget', async () => {
    const { uploads, base } = store(); const data = input(); const ids: string[] = [];
    const now = await redisTime();
    for (let index = 0; index < 5; index++) {
      const record = await uploads.admit(data, `expiry-${index}`);
      record.createdAt = now - TEMPORARY_UPLOAD_LIFETIME_MS - 10000; record.expiresAt = now - 10000 + index;
      await client.set(`${base}record:${record.id}`, JSON.stringify(record)); await client.zadd(`${base}due`, record.expiresAt, record.id);
      ids.push(record.id);
    }
    expect(await uploads.due(2)).toEqual(ids.slice(0, 2)); expect(await uploads.due(2)).toEqual(ids.slice(0, 2));
    expect((await uploads.get(ids[0]!))?.id).toBe(ids[0]);
    await expect(uploads.admit(data, 'expiry-0')).rejects.toMatchObject({ statusCode: 410, code: 'UPLOAD_TOKEN_EXPIRED' });
    expect(await client.zcard(`${base}due`)).toBe(5);
  });

  it('forgets atomically and idempotently without resurrecting a late save', async () => {
    const { uploads, base } = store(); const data = input(); const record = await uploads.admit(data, 'reusable-after-cleanup');
    await uploads.forget(record.id); await uploads.forget(record.id);
    expect(await uploads.get(record.id)).toBeUndefined();
    expect(await client.zcard(`${base}due`)).toBe(0);
    expect(await client.get(`${base}idem:${record.idempotencyHash}`)).toBeNull();
    await expect(uploads.save({ ...record, status: 'completed', object: { bytes: 10, contentType: record.mimeType, version: 'etag:"fixture"', etag: '"fixture"', uploadSessionId: record.id } })).rejects.toMatchObject({ statusCode: 410, code: 'UPLOAD_TOKEN_EXPIRED' });
    expect(await client.zcard(`${base}due`)).toBe(0);
    const next = await uploads.admit(data, 'reusable-after-cleanup');
    expect(next.id).not.toBe(record.id);
  });

  it('does not change another receipt or its idempotency mapping when forgetting one resource', async () => {
    const { uploads, base } = store(); const data = input();
    const a = await uploads.admit(data, 'a'), b = await uploads.admit(data, 'b');
    await uploads.forget(a.id); await uploads.forget(a.id);
    expect(await uploads.get(b.id)).toEqual(b);
    expect(await uploads.admit(data, 'b')).toEqual(b);
    expect(await client.zscore(`${base}due`, b.id)).toBe(String(b.expiresAt));
    const c = await uploads.admit(data, 'c');
    expect(c.id).not.toBe(b.id);
  });

  it('keeps records and idempotency separate between application prefixes', async () => {
    const a = store(), b = store(); const data = input();
    const first = await a.uploads.admit(data, 'same-key'), second = await b.uploads.admit(data, 'same-key');
    expect(await b.uploads.get(first.id)).toBeUndefined(); expect(await a.uploads.get(second.id)).toBeUndefined();
    await a.uploads.forget(first.id);
    expect(await b.uploads.get(second.id)).toEqual(second);
    expect(await b.uploads.admit(data, 'same-key')).toEqual(second);
  });

  it('fails closed on a dangling idempotency pointer instead of silently allocating another upload', async () => {
    const { uploads, base } = store(); const data = input(); const record = await uploads.admit(data, 'dangling');
    await client.del(`${base}record:${record.id}`);
    await expect(uploads.admit(data, 'dangling')).rejects.toMatchObject({ statusCode: 503, code: 'UPLOAD_STORE_CORRUPT' });
    expect(await client.zcard(`${base}due`)).toBe(1);
  });

  it('rejects a corrupt completed receipt before it can reach business resource claims', async () => {
    const { uploads, base } = store(); const record = await uploads.admit(input(), randomUUID());
    const object = { bytes: 10, contentType: record.mimeType, version: 'etag:"fixture"', etag: '"fixture"', uploadSessionId: record.id };
    for (const malformed of [undefined, { ...object, version: '' }, { ...object, contentType: null }, { ...object, bytes: 11 }, { ...object, uploadSessionId: randomUUID() }]) {
      await client.set(`${base}record:${record.id}`, JSON.stringify({ ...record, status: 'completed', object: malformed }));
      await expect(uploads.get(record.id)).rejects.toMatchObject({ statusCode: 503, code: 'UPLOAD_STORE_CORRUPT' });
    }
  });

  it('allows a cancelled cleanup receipt to remember actual metadata of an invalid-size upload', async () => {
    const { uploads } = store(); const record = await uploads.admit(input(), randomUUID());
    const cancelled = { ...record, status: 'cancelled' as const, object: { bytes: 11, contentType: 'text/plain', version: 'oss-version:invalid-size-fixture', etag: '"fixture"', uploadSessionId: record.id } };
    await uploads.save(cancelled);
    expect(await uploads.get(record.id)).toEqual(cancelled);
  });

  it('defers a failed cleanup so later due records can run without extending upload validity', async () => {
    const { uploads, base } = store(); const data = input();
    const first = await uploads.admit(data, 'cleanup-first'), second = await uploads.admit(data, 'cleanup-next');
    await uploads.save({ ...first, status: 'cancelled' }); await uploads.save({ ...second, status: 'cancelled' });
    const before = await redisTime();
    await client.zadd(`${base}due`, before - 2, first.id, before - 1, second.id);
    expect(await uploads.due(1)).toEqual([first.id]);
    const original = await client.get(`${base}record:${first.id}`);
    await uploads.defer(first.id, 60000);
    const after = await redisTime();
    const score = Number(await client.zscore(`${base}due`, first.id));
    expect(score).toBeGreaterThanOrEqual(before + 60000); expect(score).toBeLessThanOrEqual(after + 60000);
    expect(await client.get(`${base}record:${first.id}`)).toBe(original);
    expect(await uploads.due(1)).toEqual([second.id]);
  });

  it('does not recreate a forgotten receipt or due entry when a delayed failure arrives', async () => {
    const { uploads, base } = store(); const record = await uploads.admit(input(), 'forgotten-before-defer');
    await uploads.forget(record.id);
    await uploads.defer(record.id, 60000);
    expect(await uploads.get(record.id)).toBeUndefined();
    expect(await client.zscore(`${base}due`, record.id)).toBeNull();
  });

  it('rejects invalid scan limits, malformed file sizes and operations after close', async () => {
    const { uploads } = store(); const data = input();
    for (const limit of [0, -1, 1.5, 1001]) await expect(uploads.due(limit)).rejects.toMatchObject({ code: 'UPLOAD_SCAN_LIMIT_INVALID' });
    for (const sizeBytes of [-1, 0, 0.5, Number.NaN]) await expect(uploads.admit({ ...data, sizeBytes }, 'bad-metadata')).rejects.toMatchObject({ code: 'UPLOAD_METADATA_INVALID' });
    await uploads.close();
    await expect(uploads.get(randomUUID())).rejects.toMatchObject({ statusCode: 503, code: 'UPLOAD_STORE_UNAVAILABLE' });
  });
});
