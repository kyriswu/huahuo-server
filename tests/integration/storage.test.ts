import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { access, rm } from 'node:fs/promises';
import { Redis } from 'ioredis';
import OSS from 'ali-oss';
import { loadTestConfig as loadConfig } from '../sms-fixture.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { migrate } from '../../src/db/migrate.js';
import { StorageService } from '../../src/modules/storage/service.js';
import { StorageJobs } from '../../src/modules/storage/jobs.js';
import { TaskEngine } from '../../src/modules/tasks/engine.js';
import { ResourceClaims } from '../../src/modules/storage/resource-claims.js';
import { TemporaryUploadCleaner } from '../../src/modules/storage/temporary-upload-cleaner.js';
import { RedisTemporaryUploads } from '../../src/modules/storage/temporary-uploads.js';
import { AliyunOssStorageAdapter } from '../../src/integrations/object-storage/aliyun-oss.js';
import { MockOssStorageAdapter, mockOssUploadConfig } from '../support/oss-upload.js';
import { attachResource,replaceResourceRefs } from '../../src/modules/storage/references.js';
import { transaction } from '../../src/modules/identity/store.js';
import { buildApiServer } from '../../src/apps/api-server.js';
import { insertFixtureUser, insertFixtureSession, testJwtEnv, fixtureScopeHeaders } from './jwt-fixture.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL;
const redisUrl = process.env.REDIS_CACHE_URL;
if (!migrationUrl || !/^huahuo_test_/.test(new URL(migrationUrl).pathname.slice(1))
  || !redisUrl || !['127.0.0.1', 'localhost'].includes(new URL(redisUrl).hostname)
  || Number(new URL(redisUrl).pathname.slice(1)) < 10) throw new Error('ISOLATED_REAL_DEPENDENCIES_REQUIRED');
const prefix = `generic_upload_${randomUUID().replaceAll('-', '')}`;
const directory = `/tmp/huahuo-generic-upload-${randomUUID()}`;
const config = mockOssUploadConfig(loadConfig('api-server', {
  ...process.env, ...testJwtEnv, APP_ENV: 'test', LOG_LEVEL: 'silent', APP_TOKEN_SECRET: 'test-'.repeat(12),
  APP_PUBLIC_BASE_URL: 'http://storage.test', DATABASE_URL: process.env.TEST_DATABASE_API_URL,
  STORAGE_LOCAL_ROOT: directory, REDIS_KEY_PREFIX: prefix,
}));
config.maxUploadBytes = 1024;
const migrator = loadConfig('migrate', { ...process.env, APP_ENV: 'test', DATABASE_URL: migrationUrl });
const root = poolFor(migrator), pool = poolFor(config);
const worker = poolFor({ ...config, role: 'worker', databaseUrl: process.env.TEST_DATABASE_WORKER_URL! });
const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false });
redis.on('error', () => undefined);
const uploads = new RedisTemporaryUploads(config, redis);
const adapter = new MockOssStorageAdapter(directory);
const storage = new StorageService(pool, config, adapter, uploads);
const claims = new ResourceClaims(config, uploads);
const cleaner = new TemporaryUploadCleaner(worker, adapter, uploads, config);
const metadata = { fileName: '中文 笔记.txt', mimeType: 'text/plain', sizeBytes: 13n };
const bytes = Buffer.from('hello-storage');
const oneDay = 86400_000;

async function fixture() {
  const userId = await insertFixtureUser(root), sessionId = randomUUID(), workspaceId = randomUUID();
  const bearer = await insertFixtureSession(root, userId, sessionId, 'fixture-fixture');
  await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'fixture',true,$3)", [workspaceId, userId, randomUUID()]);
  return { userId, scope: { userId, sessionId, traceId: randomUUID() }, workspaceId, bearer };
}
async function uploaded(complete = false) {
  const user = await fixture();
  const upload = await storage.createUpload(user.scope, { ...metadata, workspaceId: user.workspaceId },randomUUID());
  await adapter.uploadPart(upload.uploadUrl, bytes);
  if (complete) await storage.complete(user.scope, upload.uploadId, randomUUID());
  return { user, upload };
}
async function databaseCounts(userId: string) {
  return (await root.query(`SELECT
    (SELECT count(*)::int FROM resources WHERE user_id=$1::uuid) AS resources,
    (SELECT count(*)::int FROM storage_reservations WHERE user_id=$1::uuid) AS reservations,
    (SELECT count(*)::int FROM tasks WHERE user_id=$1::uuid) AS tasks,
    (SELECT count(*)::int FROM api_idempotency WHERE scope=$1::text) AS idempotency`, [userId])).rows[0];
}
async function forgetTestKeys() {
  const keys = await redis.keys(`${prefix}:storage:temporary:*`);
  if (keys.length) await redis.del(...keys);
}
/** Simulates elapsed retention with real Redis data; production save() keeps the deadline immutable. */
async function age(id: string) {
  const key = `${prefix}:storage:temporary:record:${id}`;
  const value = await redis.get(key);
  if (!value) throw new Error('FIXTURE_UPLOAD_REQUIRED');
  const record = JSON.parse(value) as { createdAt: number; expiresAt: number };
  const [seconds, microseconds] = await redis.time();
  // Redis runs in a VM: keep the fixture clearly expired on both clocks.
  record.expiresAt = Math.min(Date.now(), Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000)) - 60_000;
  record.createdAt = record.expiresAt - oneDay;
  await redis.set(key, JSON.stringify(record));
  await redis.zadd(`${prefix}:storage:temporary:due`, record.expiresAt, id);
}
async function claim(user: Awaited<ReturnType<typeof fixture>>, id: string, reference = randomUUID()) {
  return transaction(pool, async tx => {
    await claims.ensure(tx, user.scope, user.workspaceId, [id]);
    await attachResource(tx, user.userId, id, 'message', reference, user.workspaceId);
    return reference;
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('temporary uploads: real Redis/PostgreSQL, local OSS test double', () => {
  beforeAll(async () => {
    vi.spyOn(OSS.prototype, 'request').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    await migrate(migrator); await redis.connect();
    await root.query('UPDATE runtime_configuration SET "values"=$1,revision=revision+1', [JSON.stringify({ 'storage.maxUploadBytes': 1024 })]);
  });
  beforeEach(forgetTestKeys);
  afterAll(async () => {
    await forgetTestKeys(); redis.disconnect();
    await root.query('UPDATE runtime_configuration SET "values"=\'{}\',revision=revision+1');
    await Promise.all([pool.end(), root.end(), worker.end()]);
    await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks();
  });

  it('keeps admission, progress recovery and completed receipts in Redis without business database writes', async () => {
    const user = await fixture(), before = await databaseCounts(user.userId);
    const upload = await storage.createUpload(user.scope, { ...metadata, workspaceId: user.workspaceId },randomUUID());
    expect(upload.resourceId).toBe(upload.uploadId);
    expect((await storage.recover(user.scope, upload.uploadId)).status).toBe('initiated');
    await adapter.uploadPart(upload.uploadUrl, bytes);
    const complete = await storage.complete(user.scope, upload.uploadId, randomUUID());
    expect(complete).toEqual({ uploadId: upload.uploadId, status: 'completed', resource: {
      resourceId: upload.resourceId, fileName: metadata.fileName, mimeType: metadata.mimeType, sizeBytes: 13, sha256: null,
    } });
    expect((await storage.recover(user.scope, upload.uploadId)).status).toBe('completed');
    expect(await databaseCounts(user.userId)).toEqual(before);
    expect(await uploads.get(upload.uploadId)).toMatchObject({ status: 'completed', userId: user.userId });
    expect(await uploads.get(upload.uploadId)).not.toHaveProperty('workspaceId');
    const head = vi.spyOn(adapter, 'head').mockRejectedValue(new Error('UNEXPECTED_HEAD'));
    const read = vi.spyOn(adapter, 'read').mockRejectedValue(new Error('UNEXPECTED_FILE_READ'));
    try {
      const restarted = new StorageService(pool, config, adapter, uploads);
      await expect(restarted.complete(user.scope, upload.uploadId, randomUUID())).resolves.toEqual(complete);
      const playback = await restarted.playback(user.scope, upload.resourceId);
      expect(new URL(playback.url).pathname).toBe(`/uploads/${upload.resourceId}`);
      expect(new URL(playback.url).searchParams.get('versionId')).toBeTruthy();
      expect(new URL(playback.url).searchParams.has('response-content-type')).toBe(false);
      expect(new URL(playback.url).searchParams.get('response-content-encoding')).toBe('identity');
      expect(new URL(playback.url).searchParams.get('response-content-disposition')).toMatch(/^inline; filename=/);
      expect(playback.mimeType).toBe(metadata.mimeType);
      expect(head).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    } finally { head.mockRestore(); read.mockRestore(); }
  });

  it('reuses a Redis idempotency receipt without extending 24-hour retention or repeating initialization', async () => {
    const user = await fixture(), key=randomUUID(), begin = vi.spyOn(adapter, 'beginUpload');
    try {
      const first = await storage.createUpload(user.scope, metadata,key), original = await uploads.get(first.uploadId);
      const second = await storage.createUpload(user.scope, metadata,key), after = await uploads.get(first.uploadId);
      expect(second.uploadId).toBe(first.uploadId); expect(begin).toHaveBeenCalledTimes(1);
      expect(original!.expiresAt - original!.createdAt).toBe(oneDay);
      expect(after!.expiresAt).toBe(original!.expiresAt);
      expect(Date.parse(first.expiresAt!) - Date.now()).toBeLessThanOrEqual(3600_000);
      expect(new URL(first.uploadUrl!).searchParams.get('partNumber')).toBe('1');
      await expect(storage.createUpload(user.scope, { ...metadata, fileName: 'renamed.txt' },key)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
      await adapter.uploadPart(first.uploadUrl,bytes);await storage.complete(user.scope,first.uploadId,randomUUID());
      expect(await storage.createUpload(user.scope,metadata,key)).toMatchObject({resourceId:first.resourceId,uploadRequired:false,uploadUrl:null});
      expect(first.headers).not.toHaveProperty('Content-MD5');
      const other = await fixture(), separate = await storage.createUpload(other.scope, metadata,key);
      expect(separate.uploadId).not.toBe(first.uploadId);
      expect(await databaseCounts(user.userId)).toEqual({ resources: 0, reservations: 0, tasks: 0, idempotency: 0 });
    } finally { begin.mockRestore(); }
  });

  it('retains retryable admission when initialization fails, with no duplicate resource identity', async () => {
    const user = await fixture(),key=randomUUID();
    const begin = vi.spyOn(adapter, 'beginUpload').mockRejectedValueOnce(new Error('connection lost'));
    try {
      await expect(storage.createUpload(user.scope, metadata,key)).rejects.toThrow();
      const entries = await redis.keys(`${prefix}:storage:temporary:record:*`); expect(entries).toHaveLength(1);
      const stored = JSON.parse((await redis.get(entries[0]!))!) as { id: string };
      const retried = await storage.createUpload(user.scope, metadata,key);
      expect(retried.resourceId).toBe(stored.id); expect(begin).toHaveBeenCalledTimes(2);
      expect(await databaseCounts(user.userId)).toEqual({ resources: 0, reservations: 0, tasks: 0, idempotency: 0 });
    } finally { begin.mockRestore(); }
  });

  it('serializes concurrent completion and permits retry after UPLOAD_BUSY', async () => {
    const { user, upload } = await uploaded(), entered = deferred(), resume = deferred();
    const original = adapter.completeUpload.bind(adapter);
    const complete = vi.spyOn(adapter, 'completeUpload').mockImplementationOnce(async (...args) => {
      entered.resolve(); await resume.promise; await original(...args);
    });
    try {
      const pending = storage.complete(user.scope, upload.uploadId, randomUUID()); await entered.promise;
      await expect(storage.complete(user.scope, upload.uploadId, randomUUID())).rejects.toMatchObject({ code: 'UPLOAD_BUSY' });
      resume.resolve(); const result = await pending;
      await expect(storage.complete(user.scope, upload.uploadId, randomUUID())).resolves.toEqual(result);
      expect(complete).toHaveBeenCalledTimes(1);
    } finally { resume.resolve(); complete.mockRestore(); }
  });

  it('recovers cloud completion whose response was lost without publishing or uploading twice', async () => {
    const { user, upload } = await uploaded(), original = adapter.completeUpload.bind(adapter);
    const complete = vi.spyOn(adapter, 'completeUpload').mockImplementationOnce(async (...args) => {
      await original(...args); throw new Error('response lost after OSS committed');
    });
    try {
      await storage.complete(user.scope, upload.uploadId, randomUUID()).catch(() => undefined);
      await expect(new StorageService(pool, config, adapter, uploads).complete(user.scope, upload.uploadId, randomUUID())).resolves.toHaveProperty('status', 'completed');
      expect(complete).toHaveBeenCalledTimes(1);
      expect(await databaseCounts(user.userId)).toEqual({ resources: 0, reservations: 0, tasks: 0, idempotency: 0 });
    } finally { complete.mockRestore(); }
  });

  it('recovers after OSS committed but Redis could not store the completion receipt', async () => {
    const { user, upload } = await uploaded(), original = uploads.save.bind(uploads);
    const complete = vi.spyOn(adapter, 'completeUpload');
    const save = vi.spyOn(uploads, 'save').mockImplementation(async record => {
      if (record.status === 'completed') throw new Error('Redis write unavailable');
      return original(record);
    });
    try {
      await expect(storage.complete(user.scope, upload.uploadId, randomUUID())).rejects.toThrow();
      await access(`${directory}/${upload.resourceId}`);
      expect((await uploads.get(upload.uploadId))?.completionStartedAt).toEqual(expect.any(Number));
      save.mockRestore();
      await expect(storage.complete(user.scope, upload.uploadId, randomUUID())).resolves.toHaveProperty('status', 'completed');
      expect(complete).toHaveBeenCalledTimes(1);
      expect(await databaseCounts(user.userId)).toEqual({ resources: 0, reservations: 0, tasks: 0, idempotency: 0 });
    } finally { save.mockRestore(); complete.mockRestore(); }
  });

  it('does not finish cloud uploads or claim resources when Redis state is unavailable', async () => {
    const { user, upload } = await uploaded(), complete = vi.spyOn(adapter, 'completeUpload');
    const get = vi.spyOn(uploads, 'get').mockRejectedValue(new Error('Redis unavailable'));
    try {
      await expect(storage.complete(user.scope, upload.uploadId, randomUUID())).rejects.toThrow();
      await expect(transaction(pool, tx => claims.ensure(tx, user.scope, user.workspaceId, [upload.resourceId]))).rejects.toThrow();
      expect(complete).not.toHaveBeenCalled();
      expect(await databaseCounts(user.userId)).toEqual({ resources: 0, reservations: 0, tasks: 0, idempotency: 0 });
    } finally { get.mockRestore(); complete.mockRestore(); }
  });

  it('allows retrying early completion and rejects a bad part size before the cloud commit', async () => {
    const user = await fixture(), upload = await storage.createUpload(user.scope, metadata,randomUUID());
    await expect(storage.complete(user.scope, upload.uploadId, randomUUID())).rejects.toMatchObject({ code: 'UPLOAD_PARTS_INVALID' });
    await adapter.uploadPart(upload.uploadUrl, bytes);
    adapter.setPartSize(new URL(upload.uploadUrl!).searchParams.get('uploadId')!, 2);
    const complete = vi.spyOn(adapter, 'completeUpload');
    try {
      await expect(storage.complete(user.scope, upload.uploadId, randomUUID())).rejects.toMatchObject({ code: 'UPLOAD_SIZE_MISMATCH' });
      expect(complete).not.toHaveBeenCalled();
      await adapter.uploadPart(upload.uploadUrl, bytes);
      await expect(storage.complete(user.scope, upload.uploadId, randomUUID())).resolves.toHaveProperty('status', 'completed');
    } finally { complete.mockRestore(); }
  });

  it.each([
    { change: { contentType: 'image/png' }, code: 'UPLOAD_MIME_MISMATCH' },
    { change: { bytes: 2 }, code: 'UPLOAD_SIZE_MISMATCH' },
    { change: { uploadSessionId: randomUUID() }, code: 'UPLOAD_OBJECT_IDENTITY_MISMATCH' },
  ])('rejects incompatible final metadata instead of returning a usable receipt: $code', async ({ change, code }) => {
    const { user, upload } = await uploaded(); adapter.setHeadMetadata(upload.resourceId, change);
    await expect(storage.complete(user.scope, upload.uploadId, randomUUID())).rejects.toMatchObject({ code });
    expect((await uploads.get(upload.uploadId))?.status).not.toBe('completed');
    expect(await databaseCounts(user.userId)).toEqual({ resources: 0, reservations: 0, tasks: 0, idempotency: 0 });
  });

  it('rejects another user and workspace before object-store actions or permanent claims', async () => {
    const { user, upload } = await uploaded(true), other = await fixture();
    const head = vi.spyOn(adapter, 'head'), begin = vi.spyOn(adapter, 'beginUpload');
    try {
      await expect(storage.recover(other.scope, upload.uploadId)).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
      await expect(storage.complete(other.scope, upload.uploadId, randomUUID())).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
      await expect(storage.cancel(other.scope, upload.uploadId, randomUUID())).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
      await expect(storage.playback(other.scope, upload.resourceId)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      await expect(storage.complete(user.scope, upload.uploadId, randomUUID(), other.workspaceId)).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
      await expect(transaction(pool, tx => claims.ensure(tx, other.scope, other.workspaceId, [upload.resourceId]))).rejects.toThrow();
      expect(await databaseCounts(other.userId)).toEqual({ resources: 0, reservations: 0, tasks: 0, idempotency: 0 });
      expect(head).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled();
    } finally { head.mockRestore(); begin.mockRestore(); }
  });

  it('uploads multiple temporary files without charging or reserving account space', async () => {
    const user = await fixture(), limited = new StorageService(pool, { ...config, storageQuotaBytes: 13 }, adapter, uploads);
    const attempts = await Promise.all([limited.createUpload(user.scope, metadata,randomUUID()), limited.createUpload(user.scope, {...metadata},randomUUID())]);
    expect(new Set(attempts.map(upload=>upload.uploadId)).size).toBe(2);
    const upload = attempts[0]!;
    await storage.cancel(user.scope, upload.uploadId, randomUUID());
    await expect(limited.createUpload(user.scope, {...metadata},randomUUID())).resolves.toHaveProperty('uploadId');
    await cleaner.sweep();
    await expect(limited.createUpload(user.scope, metadata,randomUUID())).resolves.toHaveProperty('uploadId');
    expect(await databaseCounts(user.userId)).toEqual({ resources: 0, reservations: 0, tasks: 0, idempotency: 0 });
    expect((await root.query('SELECT storage_used_bytes,storage_reserved_bytes FROM users WHERE id=$1',[user.userId])).rows[0]).toEqual({storage_used_bytes:'0',storage_reserved_bytes:'0'});
    expect(await redis.keys(`${prefix}:storage:temporary:pending:*`)).toEqual([]);
  });

  it('checks capacity only at the business claim and serializes concurrent claims without losing receipts', async () => {
    const user=await fixture(), limitedClaims=new ResourceClaims({...config,storageQuotaBytes:13},uploads);
    const candidates=await Promise.all([0,1].map(async index=>{
      const body=Buffer.from(index?'other-storage':'hello-storage');
      const upload=await storage.createUpload(user.scope,{...metadata},randomUUID());
      await adapter.uploadPart(upload.uploadUrl,body);
      await storage.complete(user.scope,upload.uploadId,randomUUID());
      return upload;
    }));
    const attempts=await Promise.allSettled(candidates.map(upload=>transaction(pool,async tx=>{
      await limitedClaims.ensure(tx,user.scope,user.workspaceId,[upload.resourceId]);
      await attachResource(tx,user.userId,upload.resourceId,'message',randomUUID(),user.workspaceId);
    })));
    expect(attempts.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(attempts.find(result=>result.status==='rejected')).toMatchObject({reason:{code:'STORAGE_QUOTA_EXCEEDED'}});
    expect((await root.query('SELECT storage_used_bytes,storage_reserved_bytes FROM users WHERE id=$1',[user.userId])).rows[0]).toEqual({storage_used_bytes:'13',storage_reserved_bytes:'0'});
    expect(await databaseCounts(user.userId)).toEqual({resources:1,reservations:1,tasks:0,idempotency:0});
    for(const [index,attempt] of attempts.entries()){
      const receipt=await uploads.get(candidates[index]!.uploadId);
      if(attempt.status==='fulfilled')expect(receipt).toBeUndefined();
      else expect(receipt?.status).toBe('completed');
    }
  });

  it('does not mistake a retained Redis key for a still-valid 24-hour upload receipt', async () => {
    const { user, upload } = await uploaded(true); await age(upload.uploadId);
    expect(await redis.exists(`${prefix}:storage:temporary:record:${upload.uploadId}`)).toBe(1);
    await expect(storage.complete(user.scope, upload.uploadId, randomUUID())).rejects.toThrow();
    await expect(transaction(pool, tx => claims.ensure(tx, user.scope, user.workspaceId, [upload.resourceId]))).rejects.toThrow();
    const remove = vi.spyOn(adapter, 'remove');
    try {
      await cleaner.sweep();
      expect(remove).toHaveBeenCalledWith(upload.resourceId, expect.stringMatching(/^oss-version:/));
      expect(await uploads.get(upload.uploadId)).toBeFalsy();
      await expect(access(`${directory}/${upload.resourceId}`)).rejects.toThrow();
    } finally { remove.mockRestore(); }
  });

  it('shares a resource ID across its user workspaces and maintains exact business reference counts', async () => {
    const {user,upload}=await uploaded(true),firstRef=await claim(user,upload.resourceId),workspaceId=randomUUID();
    await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'Another',false,$3)",[workspaceId,user.userId,randomUUID()]);
    const repeated=await storage.createUpload(user.scope,{...metadata,fileName:'renamed.txt',workspaceId},randomUUID());
    expect(repeated.resourceId).not.toBe(upload.resourceId);expect(repeated.uploadRequired).toBe(true);
    const secondRef=randomUUID();
    const attach=()=>transaction(pool,async tx=>{
      await claims.ensure(tx,user.scope,workspaceId,[upload.resourceId]);
      await attachResource(tx,user.userId,upload.resourceId,'message',secondRef,workspaceId);
    });
    await Promise.all([attach(),attach(),attach()]);
    expect((await root.query('SELECT reference_count FROM resources WHERE resource_id=$1',[upload.resourceId])).rows[0].reference_count).toBe('2');
    expect((await root.query('SELECT storage_used_bytes FROM users WHERE id=$1',[user.userId])).rows[0].storage_used_bytes).toBe('13');
    const other=await fixture(),separate=await storage.createUpload(other.scope,metadata,randomUUID());
    expect(separate.resourceId).not.toBe(upload.resourceId);expect(separate.uploadRequired).toBe(true);
    await expect(storage.playback(other.scope,upload.resourceId)).rejects.toMatchObject({code:'RESOURCE_NOT_FOUND'});
    await transaction(pool,tx=>replaceResourceRefs(tx,user.userId,'message',firstRef,[],user.workspaceId));
    expect((await root.query('SELECT reference_count FROM resources WHERE resource_id=$1',[upload.resourceId])).rows[0].reference_count).toBe('1');
    expect((await root.query('SELECT task_id FROM storage_jobs WHERE resource_id=$1',[upload.resourceId])).rows).toEqual([]);
    await expect(transaction(pool,async tx=>{
      await replaceResourceRefs(tx,user.userId,'message',secondRef,[],workspaceId);throw new Error('BUSINESS_ROLLBACK');
    })).rejects.toThrow('BUSINESS_ROLLBACK');
    expect((await root.query('SELECT reference_count FROM resources WHERE resource_id=$1',[upload.resourceId])).rows[0].reference_count).toBe('1');
    expect((await root.query('SELECT task_id FROM storage_jobs WHERE resource_id=$1',[upload.resourceId])).rows).toEqual([]);
    await expect(storage.remove(user.scope,user.workspaceId,upload.resourceId,randomUUID())).rejects.toMatchObject({code:'RESOURCE_REFERENCED'});
    await transaction(pool,tx=>replaceResourceRefs(tx,user.userId,'message',secondRef,[],workspaceId));
    expect((await root.query('SELECT reference_count,status FROM resources WHERE resource_id=$1',[upload.resourceId])).rows[0]).toEqual({reference_count:'0',status:'deleting'});
    await transaction(pool,tx=>replaceResourceRefs(tx,user.userId,'message',secondRef,[],workspaceId));
    const jobs=(await root.query('SELECT j.task_id,t.workspace_id,t.state FROM storage_jobs j JOIN tasks t ON t.id=j.task_id WHERE j.resource_id=$1',[upload.resourceId])).rows;
    expect(jobs).toHaveLength(1);expect(jobs[0]).toMatchObject({workspace_id:null,state:'queued'});
    const engine=new TaskEngine(worker,15000,undefined,new StorageJobs(worker,adapter,config)),a=await engine.claim(jobs[0].task_id,randomUUID());
    expect(a).toBeTruthy();await engine.execute(a!);
    expect((await root.query('SELECT resource_id FROM resources WHERE resource_id=$1',[upload.resourceId])).rows).toEqual([]);
    await expect(access(`${directory}/${upload.resourceId}`)).rejects.toThrow();
    expect((await root.query('SELECT storage_used_bytes FROM users WHERE id=$1',[user.userId])).rows[0].storage_used_bytes).toBe('0');
  });

  it('retries failed zero-reference deletion and resumes after hard deletion without repeating storage or occupancy changes',async()=>{
    const {user,upload}=await uploaded(true),ref=await claim(user,upload.resourceId);
    await transaction(pool,tx=>replaceResourceRefs(tx,user.userId,'message',ref,[],user.workspaceId));
    const job=(await root.query('SELECT task_id FROM storage_jobs WHERE resource_id=$1',[upload.resourceId])).rows[0];
    const jobs=new StorageJobs(worker,adapter,config),engine=new TaskEngine(worker,15000,undefined,jobs),a=await engine.claim(job.task_id,randomUUID());expect(a).toBeTruthy();
    const remove=vi.spyOn(adapter,'remove').mockRejectedValueOnce(new Error('OSS_UNAVAILABLE'));
    try{
      await expect(jobs.execute(a!)).rejects.toThrow('OSS_UNAVAILABLE');
      expect((await root.query('SELECT status,reference_count FROM resources WHERE resource_id=$1',[upload.resourceId])).rows[0]).toEqual({status:'deleting',reference_count:'0'});
      expect((await root.query('SELECT completed_at FROM storage_jobs WHERE task_id=$1',[job.task_id])).rows[0].completed_at).toBeNull();
      expect((await root.query('SELECT storage_used_bytes FROM users WHERE id=$1',[user.userId])).rows[0].storage_used_bytes).toBe('13');
      await access(`${directory}/${upload.resourceId}`);
      // The file/usage transaction committed, but the process stopped before
      // TaskEngine.finish. A fresh worker uses the existing job receipt.
      const result=await jobs.execute(a!);
      expect((await root.query('SELECT resource_id FROM resources WHERE resource_id=$1',[upload.resourceId])).rows).toEqual([]);
      expect((await root.query('SELECT completed_at FROM storage_jobs WHERE task_id=$1',[job.task_id])).rows[0].completed_at).toBeInstanceOf(Date);
      expect((await root.query('SELECT storage_used_bytes FROM users WHERE id=$1',[user.userId])).rows[0].storage_used_bytes).toBe('0');
      await expect(new StorageJobs(worker,adapter,config).execute(a!)).resolves.toEqual(result);
      await engine.execute(a!);expect(remove).toHaveBeenCalledTimes(2);
      expect((await root.query('SELECT state FROM tasks WHERE id=$1',[job.task_id])).rows[0].state).toBe('succeeded');
      expect(await engine.claim(job.task_id,randomUUID())).toBeNull();
      await expect(storage.playback(user.scope,upload.resourceId)).rejects.toMatchObject({code:'RESOURCE_NOT_FOUND'});
    }finally{remove.mockRestore();}
  });

  it('does not deduplicate identical bytes across independent uploads by the same user',async()=>{
    const {user,upload}=await uploaded(true);await claim(user,upload.resourceId);
    const second=await storage.createUpload(user.scope,metadata,randomUUID());
    expect(second.resourceId).not.toBe(upload.resourceId);expect(second.uploadRequired).toBe(true);
    expect(second.headers).not.toHaveProperty('Content-MD5');
    await adapter.uploadPart(second.uploadUrl,bytes);await storage.complete(user.scope,second.uploadId,randomUUID());
    await claim(user,second.resourceId);
    const files=(await root.query('SELECT resource_id,reference_count,sha256 FROM resources WHERE user_id=$1',[user.userId])).rows;
    expect(files).toHaveLength(2);expect(files.every(row=>row.reference_count==='1'&&row.sha256===null)).toBe(true);
    expect((await root.query('SELECT storage_used_bytes FROM users WHERE id=$1',[user.userId])).rows[0].storage_used_bytes).toBe('26');
  });

  it('cancels a live multipart session without a durable business task and invalidates the old part URL', async () => {
    const { user, upload } = await uploaded(), key = randomUUID();
    await expect(storage.cancel(user.scope, upload.uploadId, key)).resolves.toEqual({ uploadId: upload.uploadId, status: 'cancel_pending' });
    await expect(storage.cancel(user.scope, upload.uploadId, key)).resolves.toEqual({ uploadId: upload.uploadId, status: 'cancel_pending' });
    await cleaner.sweep();
    expect(await uploads.get(upload.uploadId)).toBeFalsy();
    await expect(adapter.uploadPart(upload.uploadUrl, bytes)).rejects.toMatchObject({ code: 'STORAGE_UPLOAD_NOT_FOUND' });
    expect(await databaseCounts(user.userId)).toEqual({ resources: 0, reservations: 0, tasks: 0, idempotency: 0 });
  });

  it('retains cleanup state after an object-store failure and retries safely', async () => {
    const { user, upload } = await uploaded(true); await storage.cancel(user.scope, upload.uploadId, randomUUID());
    const remove = vi.spyOn(adapter, 'remove').mockRejectedValueOnce(new Error('provider unavailable'));
    try {
      const failed = await cleaner.sweep(); expect(failed.failures).toHaveLength(1);
      expect(await uploads.get(upload.uploadId)).toBeTruthy(); await access(`${directory}/${upload.resourceId}`);
      // Advance only this fixture's retry index; production backs off failures for 60 seconds.
      await redis.zadd(`${prefix}:storage:temporary:due`, 0, upload.uploadId);
      await cleaner.sweep(); expect(await uploads.get(upload.uploadId)).toBeFalsy();
      await expect(access(`${directory}/${upload.resourceId}`)).rejects.toThrow();
    } finally { remove.mockRestore(); }
  });

  it('retains an unknown completion result instead of assuming NoSuchUpload plus HEAD absence means cleaned', async () => {
    const { user, upload } = await uploaded();
    const complete = vi.spyOn(adapter, 'completeUpload').mockImplementationOnce(async (key, uploadId) => {
      // OSS has consumed the upload ID, but the final object is not yet observable.
      await adapter.abortUpload(key, uploadId); throw new Error('cloud completion outcome unknown');
    });
    try { await expect(storage.complete(user.scope, upload.uploadId, randomUUID())).rejects.toThrow(); }
    finally { complete.mockRestore(); }
    await storage.cancel(user.scope, upload.uploadId, randomUUID());
    const result = await cleaner.sweep(); expect(result.failures).toHaveLength(1);
    expect(await uploads.get(upload.uploadId)).toBeTruthy();
    expect((await root.query('SELECT storage_used_bytes,storage_reserved_bytes FROM users WHERE id=$1',[user.userId])).rows[0]).toEqual({storage_used_bytes:'0',storage_reserved_bytes:'0'});
    expect(await databaseCounts(user.userId)).toEqual({ resources: 0, reservations: 0, tasks: 0, idempotency: 0 });
  });

  it('creates the permanent resource, occupancy and reference only inside the business transaction', async () => {
    const { user, upload } = await uploaded(true);
    await claim(user, upload.resourceId);
    expect((await root.query('SELECT user_id,size_bytes,status FROM resources WHERE resource_id=$1', [upload.resourceId])).rows[0]).toEqual({ user_id: user.userId, size_bytes: '13', status: 'ready' });
    expect((await root.query('SELECT status,confirmed_bytes FROM storage_reservations WHERE user_id=$1', [user.userId])).rows).toEqual([{ status: 'confirmed', confirmed_bytes: '13' }]);
    expect((await root.query('SELECT storage_used_bytes,storage_reserved_bytes FROM users WHERE id=$1',[user.userId])).rows[0]).toEqual({storage_used_bytes:'13',storage_reserved_bytes:'0'});
    expect((await root.query('SELECT count(*)::int n FROM resource_refs WHERE resource_id=$1', [upload.resourceId])).rows[0].n).toBe(1);
    await claim(user, upload.resourceId);
    expect((await root.query('SELECT count(*)::int n FROM resources WHERE resource_id=$1', [upload.resourceId])).rows[0].n).toBe(1);
    expect((await root.query('SELECT count(*)::int n FROM storage_reservations WHERE user_id=$1', [user.userId])).rows[0].n).toBe(1);
    expect((await root.query('SELECT storage_used_bytes FROM users WHERE id=$1',[user.userId])).rows[0].storage_used_bytes).toBe('13');
    expect((await root.query("SELECT kind FROM tasks WHERE user_id=$1", [user.userId])).rows).toEqual([]);
    expect(await uploads.get(upload.uploadId)).toBeFalsy();
  });

  it('rolls back resource registration with a failed business mutation and keeps the temporary receipt reusable', async () => {
    const { user, upload } = await uploaded(true), before = await databaseCounts(user.userId);
    await expect(transaction(pool, async tx => {
      await claims.ensure(tx, user.scope, user.workspaceId, [upload.resourceId]);
      await attachResource(tx, user.userId, upload.resourceId, 'message', randomUUID(), user.workspaceId);
      throw new Error('BUSINESS_MUTATION_REJECTED');
    })).rejects.toThrow('BUSINESS_MUTATION_REJECTED');
    expect(await databaseCounts(user.userId)).toEqual(before);
    expect((await root.query('SELECT storage_used_bytes FROM users WHERE id=$1',[user.userId])).rows[0].storage_used_bytes).toBe('0');
    expect((await uploads.get(upload.uploadId))?.status).toBe('completed');
    expect((await root.query('SELECT count(*)::int n FROM resource_refs WHERE resource_id=$1', [upload.resourceId])).rows[0].n).toBe(0);
    await claim(user, upload.resourceId);
  });

  it('never double-counts or deletes a claimed object when Redis acknowledgement was lost', async () => {
    const { user, upload } = await uploaded(true);
    const forget = vi.spyOn(uploads, 'forget').mockRejectedValueOnce(new Error('Redis acknowledgement lost'));
    try {
      await claim(user, upload.resourceId);
      expect(forget).toHaveBeenCalledWith(upload.resourceId);
    } finally { forget.mockRestore(); }
    // The retained Redis receipt is not an additional capacity charge. A second
    // 13-byte file can still be claimed inside this user's 26-byte formal quota.
    expect(await uploads.get(upload.uploadId)).toBeTruthy();
    const limitedConfig={...config,storageQuotaBytes:26}, limited=new StorageService(pool,limitedConfig,adapter,uploads);
    const nextBytes=Buffer.from('other-storage');
    const next=await limited.createUpload(user.scope,{...metadata},randomUUID());
    await adapter.uploadPart(next.uploadUrl,nextBytes);
    await limited.complete(user.scope,next.uploadId,randomUUID());
    await transaction(pool,async tx=>{
      await new ResourceClaims(limitedConfig,uploads).ensure(tx,user.scope,user.workspaceId,[next.resourceId]);
      await attachResource(tx,user.userId,next.resourceId,'message',randomUUID(),user.workspaceId);
    });
    expect((await root.query('SELECT storage_used_bytes FROM users WHERE id=$1',[user.userId])).rows[0].storage_used_bytes).toBe('26');
    expect(await uploads.get(next.uploadId)).toBeUndefined();
    expect(await uploads.get(upload.uploadId)).toBeTruthy();
    await age(upload.uploadId);
    const remove = vi.spyOn(adapter, 'remove'), abort = vi.spyOn(adapter, 'abortUpload');
    try {
      await cleaner.sweep(); expect(await uploads.get(upload.uploadId)).toBeFalsy();
      expect(remove).not.toHaveBeenCalled(); expect(abort).not.toHaveBeenCalled();
      await access(`${directory}/${upload.resourceId}`);
      const link = await storage.playback(user.scope, upload.resourceId); expect(link.resourceId).toBe(upload.resourceId);
      await claim(user, upload.resourceId);
      expect((await root.query('SELECT count(*)::int n FROM storage_reservations WHERE user_id=$1', [user.userId])).rows[0].n).toBe(2);
      expect((await root.query('SELECT storage_used_bytes FROM users WHERE id=$1',[user.userId])).rows[0].storage_used_bytes).toBe('26');
    } finally { remove.mockRestore(); abort.mockRestore(); }
  });

  it('releases formal space once after confirmed deletion so a waiting business claim can retry', async () => {
    const {user,upload}=await uploaded(true);
    await claim(user,upload.resourceId);
    const limited=new StorageService(pool,{...config,storageQuotaBytes:13},adapter,uploads);
    const nextBytes=Buffer.from('other-storage');
    const next=await limited.createUpload(user.scope,{...metadata},randomUUID());
    await adapter.uploadPart(next.uploadUrl,nextBytes);
    await limited.complete(user.scope,next.uploadId,randomUUID());
    const limitedClaims=new ResourceClaims({...config,storageQuotaBytes:13},uploads);
    const claimNext=()=>transaction(pool,async tx=>{
      await limitedClaims.ensure(tx,user.scope,user.workspaceId,[next.resourceId]);
      await attachResource(tx,user.userId,next.resourceId,'message',randomUUID(),user.workspaceId);
    });
    await expect(claimNext()).rejects.toMatchObject({code:'STORAGE_QUOTA_EXCEEDED'});
    expect((await uploads.get(next.uploadId))?.status).toBe('completed');
    await transaction(pool,async tx=>{const refs=(await tx.query('SELECT ref_kind,ref_id_external,workspace_id FROM resource_refs WHERE resource_id=$1',[upload.resourceId])).rows;for(const r of refs)await replaceResourceRefs(tx,user.userId,r.ref_kind,r.ref_id_external,[],r.workspace_id);});
    await storage.remove(user.scope,user.workspaceId,upload.resourceId,randomUUID());
    expect((await root.query('SELECT storage_used_bytes FROM users WHERE id=$1',[user.userId])).rows[0].storage_used_bytes).toBe('13');
    const task=(await root.query("SELECT task_id FROM storage_jobs WHERE resource_id=$1 AND operation='delete'",[upload.resourceId])).rows[0];
    const engine=new TaskEngine(worker,15000,undefined,new StorageJobs(worker,adapter,config));
    const attempt=await engine.claim(task.task_id,randomUUID());expect(attempt).toBeTruthy();
    const remove=vi.spyOn(adapter,'remove');
    try{
      const changedBucket={...config,storageAliyunOss:{...config.storageAliyunOss!,bucket:'different-bucket'}};
      await expect(new StorageJobs(worker,adapter,changedBucket).execute(attempt!)).rejects.toThrow('RESOURCE_STORAGE_MISMATCH');
      expect(remove).not.toHaveBeenCalled();
      expect((await root.query('SELECT storage_used_bytes FROM users WHERE id=$1',[user.userId])).rows[0].storage_used_bytes).toBe('13');
    }finally{remove.mockRestore();}
    await engine.execute(attempt!);
    expect((await root.query('SELECT storage_used_bytes FROM users WHERE id=$1',[user.userId])).rows[0].storage_used_bytes).toBe('0');
    expect(await engine.claim(task.task_id,randomUUID())).toBeNull();
    await expect(storage.remove(user.scope,user.workspaceId,upload.resourceId,randomUUID())).rejects.toMatchObject({code:'RESOURCE_NOT_FOUND'});
    expect((await root.query('SELECT storage_used_bytes FROM users WHERE id=$1',[user.userId])).rows[0].storage_used_bytes).toBe('0');
    await expect(adapter.uploadPart(upload.uploadUrl,bytes)).rejects.toMatchObject({code:'STORAGE_UPLOAD_NOT_FOUND'});
    await claimNext();
    expect(await uploads.get(next.uploadId)).toBeUndefined();
    expect((await root.query('SELECT storage_used_bytes FROM users WHERE id=$1',[user.userId])).rows[0].storage_used_bytes).toBe('13');
  });

  it('serializes temporary cleanup with a committing business claim', async () => {
    const { user, upload } = await uploaded(true), inserted = deferred(), commit = deferred();
    const claiming = transaction(pool, async tx => {
      await claims.ensure(tx, user.scope, user.workspaceId, [upload.resourceId]);
      inserted.resolve(); await commit.promise;
      await attachResource(tx, user.userId, upload.resourceId, 'message', randomUUID(), user.workspaceId);
    });
    await inserted.promise; await age(upload.uploadId);
    const remove = vi.spyOn(adapter, 'remove');
    try {
      const cleaning = cleaner.sweep(); commit.resolve(); await Promise.all([claiming, cleaning]);
      expect(remove).not.toHaveBeenCalled(); await access(`${directory}/${upload.resourceId}`);
      expect((await root.query('SELECT status FROM resources WHERE resource_id=$1', [upload.resourceId])).rows[0].status).toBe('ready');
    } finally { commit.resolve(); remove.mockRestore(); }
  });

  it('does not re-create a deleted temporary object when the former part URL is replayed', async () => {
    const { user, upload } = await uploaded(true); await storage.cancel(user.scope, upload.uploadId, randomUUID()); await cleaner.sweep();
    await expect(adapter.uploadPart(upload.uploadUrl, bytes)).rejects.toMatchObject({ code: 'STORAGE_UPLOAD_NOT_FOUND' });
    await expect(access(`${directory}/${upload.resourceId}`)).rejects.toThrow();
  });

  it('rejects unsupported storage drivers before allocating temporary upload state', async () => {
    const user = await fixture();
    for (const storageDriver of ['local', 's3'] as const) {
      const service = new StorageService(pool, { ...config, storageDriver }, adapter, uploads);
      await expect(service.createUpload(user.scope, metadata,randomUUID())).rejects.toMatchObject({ code: 'DIRECT_UPLOAD_NOT_CONFIGURED' });
    }
    expect(await redis.keys(`${prefix}:storage:temporary:record:*`)).toHaveLength(0);
  });

  it('provides a generic metadata-only HTTP contract and never accepts a file-body proxy request', async () => {
    const user = await fixture();
    const spies = [
      vi.spyOn(AliyunOssStorageAdapter.prototype, 'beginUpload').mockImplementation(adapter.beginUpload.bind(adapter)),
      vi.spyOn(AliyunOssStorageAdapter.prototype, 'signUploadPart').mockImplementation(adapter.signUploadPart.bind(adapter)),
      vi.spyOn(AliyunOssStorageAdapter.prototype, 'inspectUploadPart').mockImplementation(adapter.inspectUploadPart.bind(adapter)),
      vi.spyOn(AliyunOssStorageAdapter.prototype, 'completeUpload').mockImplementation(adapter.completeUpload.bind(adapter)),
      vi.spyOn(AliyunOssStorageAdapter.prototype, 'abortUpload').mockImplementation(adapter.abortUpload.bind(adapter)),
      vi.spyOn(AliyunOssStorageAdapter.prototype, 'head').mockImplementation(adapter.head.bind(adapter)),
      vi.spyOn(AliyunOssStorageAdapter.prototype, 'stat').mockRejectedValue(new Error('UNEXPECTED_INSPECTION')),
      vi.spyOn(AliyunOssStorageAdapter.prototype, 'read').mockRejectedValue(new Error('UNEXPECTED_FILE_READ')),
    ];
    const app = await buildApiServer({ config });
    try {
      const headers = { ...fixtureScopeHeaders(user.bearer), 'x-idempotency-key': randomUUID() };
      const init = await app.inject({ method: 'POST', url: '/api/v1/media/upload-token', headers, payload: { ...metadata, sizeBytes: 13, workspaceId: user.workspaceId } });
      expect(init.statusCode, init.body).toBe(200); expect(init.headers['cache-control']).toBe('no-store');
      const upload = init.json().data;
      expect(upload.uploadId).toBe(upload.resourceId);
      expect(new URL(upload.uploadUrl!).searchParams.get('partNumber')).toBe('1');
      expect(upload.headers).toMatchObject({ 'Content-Type': 'text/plain', 'Content-Length': '13' });
      for (const unsupported of [{contentMd5:'a'.repeat(32)}, { sha256: '0'.repeat(64) }, { sourceScene: 'note_import' }, { durationSeconds: 23 }, { distillToDigitalTwin: true }]) {
        const result = await app.inject({ method: 'POST', url: '/api/v1/media/upload-token', headers: { ...headers, 'x-idempotency-key': randomUUID() }, payload: { ...metadata, sizeBytes: 13, ...unsupported } });
        expect(result.statusCode, result.body).toBe(400);
      }
      const proxy = await app.inject({ method: 'PUT', url: `/api/v1/media/uploads/${upload.uploadId}/object`, headers: { ...fixtureScopeHeaders(user.bearer), 'content-type': 'text/plain' }, payload: bytes });
      expect(proxy.statusCode).toBe(404);
      await adapter.uploadPart(upload.uploadUrl, bytes, upload.headers);
      const done = await app.inject({ method: 'POST', url: `/api/v1/media/uploads/${upload.uploadId}/complete`, headers: { ...headers, 'x-idempotency-key': randomUUID() }, payload: {} });
      expect(done.statusCode, done.body).toBe(200); expect(done.json().data.resource).toEqual({ resourceId: upload.resourceId, fileName: metadata.fileName, mimeType: metadata.mimeType, sizeBytes: 13, sha256: null });
      expect(await databaseCounts(user.userId)).toEqual({ resources: 0, reservations: 0, tasks: 0, idempotency: 0 });
      const cancel = await app.inject({ method: 'POST', url: `/api/v1/media/uploads/${upload.uploadId}/cancel`, headers: { ...headers, 'x-idempotency-key': randomUUID() }, payload: {} });
      expect(cancel.statusCode, cancel.body).toBe(200); expect(cancel.json().data.status).toBe('cancel_pending');
    } finally { await app.close(); for (const spy of spies) spy.mockRestore(); }
  });
});
