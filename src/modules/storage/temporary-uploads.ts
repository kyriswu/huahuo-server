import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { AppConfig } from '../../config/config.js';
import { DomainError } from '../../lib/domain-error.js';
import type { ObjectMetadata } from './port.js';

export const TEMPORARY_UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface TemporaryUploadInput {
  userId: string;
  bindingId?: string;
  recordingKey?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageDriver: 'aliyun-oss';
  storageBucket: string;
}

export interface TemporaryUpload extends TemporaryUploadInput {
  /** Also used as the resource ID if a later business operation claims this file. */
  id: string;
  createdAt: number;
  expiresAt: number;
  status: 'initiated' | 'completed' | 'cancelled';
  remoteUploadId?: string;
  completionStartedAt?: number;
  object?: ObjectMetadata;
  /** Internal digests only. The caller's idempotency key is never stored. */
  idempotencyHash: string;
  requestHash: string;
}

export interface TemporaryUploadStore {
  admit(input: TemporaryUploadInput, key: string): Promise<TemporaryUpload>;
  get(id: string): Promise<TemporaryUpload | undefined>;
  save(record: TemporaryUpload): Promise<void>;
  forget(id: string): Promise<void>;
  defer(id: string, delayMs: number): Promise<void>;
  due(limit?: number): Promise<string[]>;
  close(): Promise<void>;
}

// Records deliberately have no Redis TTL. Expiry ends client admission, while the
// due index retains the cleanup work until OSS and any PG claim have been checked.
const admitScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local input = cjson.decode(ARGV[1])
local existing = redis.call('GET', KEYS[1])
if existing then
  local raw = redis.call('GET', ARGV[3] .. existing)
  if not raw then return {-2} end
  local record = cjson.decode(raw)
  if record.requestHash ~= input.requestHash then return {-1} end
  if record.expiresAt <= now then return {-3} end
  return {1, raw}
end
input.createdAt = now
input.expiresAt = now + tonumber(ARGV[2])
local raw = cjson.encode(input)
redis.call('SET', KEYS[3], raw)
redis.call('SET', KEYS[1], input.id)
redis.call('ZADD', KEYS[2], input.expiresAt, input.id)
return {1, raw}
`;

const saveScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {-1} end
local previous = cjson.decode(raw)
local next = cjson.decode(ARGV[1])
local immutable = {'id','userId','fileName','mimeType','sizeBytes','storageDriver','storageBucket','createdAt','expiresAt','idempotencyHash','requestHash','bindingId','recordingKey'}
for _, field in ipairs(immutable) do
  if previous[field] ~= next[field] then return {-2} end
end
if previous.status == 'cancelled' and next.status ~= 'cancelled' then return {-3} end
if previous.status == 'completed' and next.status == 'initiated' then return {-3} end
local score = next.expiresAt
if next.status == 'cancelled' then
  local time = redis.call('TIME')
  score = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], score, next.id)
return {1}
`;

const forgetScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  redis.call('ZREM', KEYS[2], ARGV[1])
  return {1}
end
local record = cjson.decode(raw)
local idempotencyKey = ARGV[2] .. record.idempotencyHash
if redis.call('GET', idempotencyKey) == record.id then redis.call('DEL', idempotencyKey) end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], record.id)
return {1}
`;

const dueScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
return redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, ARGV[1])
`;

const deferScript = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[2]), ARGV[1])
return 1
`;

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function validId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) throw new DomainError(400, 'UPLOAD_ID_INVALID');
}
function response(value: unknown): [number, unknown?] {
  if (!Array.isArray(value) || typeof value[0] !== 'number') throw new DomainError(503, 'UPLOAD_STORE_CORRUPT');
  return [value[0], value[1]];
}
function safeHeader(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 1100) return false;
  for (const char of value) if (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) return false;
  return true;
}
function recordFrom(value: unknown): TemporaryUpload {
  try {
    if (typeof value !== 'string') throw new Error('UPLOAD_RECORD_INVALID');
    const record = JSON.parse(value) as TemporaryUpload;
    if (!record || typeof record.id !== 'string' || typeof record.userId !== 'string'
      || typeof record.fileName !== 'string' || typeof record.mimeType !== 'string' || record.storageDriver !== 'aliyun-oss'
      || typeof record.storageBucket !== 'string' || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 1
      || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= record.createdAt
      || !['initiated', 'completed', 'cancelled'].includes(record.status)
      || !/^[a-f0-9]{64}$/u.test(record.idempotencyHash) || !/^[a-f0-9]{64}$/u.test(record.requestHash)) throw new Error('UPLOAD_RECORD_INVALID');
    if(record.bindingId !== undefined || record.recordingKey !== undefined) {
      if(typeof record.bindingId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(record.bindingId)
        || typeof record.recordingKey !== 'string' || !record.recordingKey.trim() || Buffer.byteLength(record.recordingKey)>256) throw new Error('UPLOAD_RECORD_INVALID');
    }
    validId(record.id);
    if (record.status === 'completed' && !record.object) throw new Error('UPLOAD_COMPLETED_OBJECT_MISSING');
    if (record.object && (!Number.isSafeInteger(record.object.bytes) || record.object.bytes < 0
      || !safeHeader(record.object.contentType)
      || !safeHeader(record.object.version) || !/^(?:oss-version:|etag:).+/u.test(record.object.version)
      || !safeHeader(record.object.etag) || record.object.uploadSessionId !== record.id)) throw new Error('UPLOAD_OBJECT_INVALID');
    if (record.status === 'completed' && (record.object!.bytes !== record.sizeBytes
      || record.object!.contentType.split(';', 1)[0]!.trim().toLowerCase() !== record.mimeType.toLowerCase())) throw new Error('UPLOAD_OBJECT_INVALID');
    return record;
  } catch (cause) { throw new DomainError(503, 'UPLOAD_STORE_CORRUPT', false, { cause }); }
}

/** Shared by API and cleanup. Requires Redis persistence/no-eviction for retained upload ownership. */
export class RedisTemporaryUploads implements TemporaryUploadStore {
  private readonly redis: Redis;
  private readonly prefix: string;
  private connecting?: Promise<void>;
  private closed = false;

  constructor(config: Pick<AppConfig, 'redisCacheUrl' | 'queuePrefix'>, client?: Redis) {
    this.prefix = `${config.queuePrefix}:storage:temporary:`;
    this.redis = client ?? new Redis(config.redisCacheUrl, {
      lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0,
      connectTimeout: 1500, commandTimeout: 2000, retryStrategy: () => null,
    });
    this.redis.on('error', () => undefined);
  }

  private async ready(): Promise<void> {
    if (this.closed) throw new DomainError(503, 'UPLOAD_STORE_UNAVAILABLE');
    if (this.redis.status === 'ready') return;
    if (!this.connecting) {
      this.connecting = (async () => {
        if (this.redis.status === 'wait' || this.redis.status === 'end') { await this.redis.connect(); return; }
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); this.redis.off('ready', success); this.redis.off('error', failure); this.redis.off('end', ended); };
          const success = () => { cleanup(); resolve(); };
          const failure = (error: Error) => { cleanup(); reject(error); };
          const ended = () => failure(new Error('REDIS_CONNECTION_ENDED'));
          const timer = setTimeout(() => failure(new Error('REDIS_CONNECT_TIMEOUT')), 2000);
          this.redis.once('ready', success); this.redis.once('error', failure); this.redis.once('end', ended);
        });
      })().catch(cause => { throw new DomainError(503, 'UPLOAD_STORE_UNAVAILABLE', false, { cause }); }).finally(() => { this.connecting = undefined; });
    }
    await this.connecting;
    if (this.closed) throw new DomainError(503, 'UPLOAD_STORE_UNAVAILABLE');
  }

  private async execute(script: string, keys: string[], args: Array<string | number> = []): Promise<unknown> {
    await this.ready();
    try { return await this.redis.eval(script, keys.length, ...keys, ...args); }
    catch (cause) { throw new DomainError(503, 'UPLOAD_STORE_UNAVAILABLE', false, { cause }); }
  }

  async admit(input: TemporaryUploadInput, key: string): Promise<TemporaryUpload> {
    if (!key || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.storageDriver !== 'aliyun-oss') throw new DomainError(400, 'UPLOAD_METADATA_INVALID');
    const fields: TemporaryUploadInput = {
      userId: input.userId, fileName: input.fileName, mimeType: input.mimeType,
      sizeBytes: input.sizeBytes, storageDriver: input.storageDriver, storageBucket: input.storageBucket,
      ...(input.bindingId ? { bindingId: input.bindingId, recordingKey: input.recordingKey } : {}),
    };
    const idempotencyHash = hash(JSON.stringify([input.userId, key]));
    const record = { ...fields, id: randomUUID(), status: 'initiated', idempotencyHash, requestHash: hash(JSON.stringify(fields)) };
    const [code, value] = response(await this.execute(admitScript, [
      `${this.prefix}idem:${idempotencyHash}`, `${this.prefix}due`, `${this.prefix}record:${record.id}`,
    ], [JSON.stringify(record), TEMPORARY_UPLOAD_LIFETIME_MS, `${this.prefix}record:`]));
    if (code === -1) throw new DomainError(409, 'IDEMPOTENCY_CONFLICT');
    if (code === -2) throw new DomainError(503, 'UPLOAD_STORE_CORRUPT');
    if (code === -3) throw new DomainError(410, 'UPLOAD_TOKEN_EXPIRED');
    if (code !== 1) throw new DomainError(503, 'UPLOAD_STORE_CORRUPT');
    return recordFrom(value);
  }

  async get(id: string): Promise<TemporaryUpload | undefined> {
    validId(id); await this.ready();
    let raw: string | null;
    try { raw = await this.redis.get(`${this.prefix}record:${id}`); }
    catch (cause) { throw new DomainError(503, 'UPLOAD_STORE_UNAVAILABLE', false, { cause }); }
    if (raw === null) return undefined;
    const record = recordFrom(raw);
    if (record.id !== id) throw new DomainError(503, 'UPLOAD_STORE_CORRUPT');
    return record;
  }

  async save(record: TemporaryUpload): Promise<void> {
    validId(record.id);
    const raw = JSON.stringify(record);
    recordFrom(raw);
    const [code] = response(await this.execute(saveScript, [`${this.prefix}record:${record.id}`, `${this.prefix}due`], [raw]));
    if (code === -1) throw new DomainError(410, 'UPLOAD_TOKEN_EXPIRED');
    if (code === -2) throw new DomainError(409, 'UPLOAD_RECORD_CONFLICT');
    if (code === -3) throw new DomainError(409, 'UPLOAD_STATE_CONFLICT');
    if (code !== 1) throw new DomainError(503, 'UPLOAD_STORE_CORRUPT');
  }

  async forget(id: string): Promise<void> {
    validId(id);
    const [code] = response(await this.execute(forgetScript, [`${this.prefix}record:${id}`, `${this.prefix}due`], [id, `${this.prefix}idem:`]));
    if (code !== 1) throw new DomainError(503, 'UPLOAD_STORE_CORRUPT');
  }

  async due(limit = 20): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new DomainError(400, 'UPLOAD_SCAN_LIMIT_INVALID');
    const result = await this.execute(dueScript, [`${this.prefix}due`], [limit]);
    if (!Array.isArray(result) || result.some(value => typeof value !== 'string')) throw new DomainError(503, 'UPLOAD_STORE_CORRUPT');
    return result as string[];
  }

  /** Retry timing only; the receipt's 24-hour client validity never changes. */
  async defer(id: string, delayMs: number): Promise<void> {
    validId(id);
    if (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > TEMPORARY_UPLOAD_LIFETIME_MS) throw new DomainError(400, 'UPLOAD_RETRY_DELAY_INVALID');
    const result = await this.execute(deferScript, [`${this.prefix}record:${id}`, `${this.prefix}due`], [id, delayMs]);
    if (result !== 0 && result !== 1) throw new DomainError(503, 'UPLOAD_STORE_CORRUPT');
  }

  async close(): Promise<void> { this.closed = true; this.redis.disconnect(); }
}
