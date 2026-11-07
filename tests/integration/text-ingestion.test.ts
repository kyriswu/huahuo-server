import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { loadConfig } from '../../src/config/config.js';
import { migrate } from '../../src/db/migrate.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { buildApiServer } from '../../src/apps/api-server.js';
import { TextIngestionService } from '../../src/modules/text-ingestion/service.js';
import { TextIngestionJobs } from '../../src/modules/text-ingestion/jobs.js';
import { TextIngestionSourceType as Source } from '../../src/modules/text-ingestion/types.js';
import { TaskEngine } from '../../src/modules/tasks/engine.js';
import type { VectorRecord } from '../../src/lib/rag-indexing/index.js';
import type { MilvusSearchOptions } from '../../src/modules/rag/adapters/milvus.js';
import { processingEmbedding } from '../../src/modules/rag/processing-profile.js';
import { testJwtEnv, insertFixtureUser, insertFixtureSession } from './jwt-fixture.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL;
if (!migrationUrl || !/^huahuo_test_/.test(new URL(migrationUrl).pathname.slice(1))) throw new Error('ISOLATED_TEST_DATABASE_REQUIRED');
const environment = { ...process.env, ...testJwtEnv, APP_ENV: 'test', LOG_LEVEL: 'silent', ALLOW_MOCK_PROVIDERS: 'true',
  RAG_PROVIDER_MODE: 'mock', RAG_RERANK_PROVIDER: 'mock', RAG_EMBEDDING_MODEL: 'text-fixture-model', RAG_EMBEDDING_DIMENSIONS: '8',
  RAG_CHILD_TARGET_TOKENS: '40', RAG_CHILD_MAX_TOKENS: '80', RAG_CHILD_OVERLAP_TOKENS: '8',
  RAG_INGEST_BATCH_SIZE: '2', RAG_INDEXING_CONCURRENCY: '1', RAG_EMBEDDING_MAX_RETRIES: '0', RAG_SOURCE_ALLOWED_HOSTS: '127.0.0.1' };
const config = loadConfig('api-server', { ...environment, DATABASE_URL: process.env.TEST_DATABASE_API_URL,
  APP_TOKEN_SECRET: 'text-ingestion-test-secret'.repeat(2), APP_PUBLIC_BASE_URL: 'http://text.test' });
const workerConfig = loadConfig('worker', { ...environment, DATABASE_URL: process.env.TEST_DATABASE_WORKER_URL });
const root = poolFor(loadConfig('migrate', { DATABASE_URL: migrationUrl })), pool = poolFor(config), workerPool = poolFor(workerConfig);
const service = new TextIngestionService(pool, config);
const vectors = new Map<string, VectorRecord>();
const upsert = vi.fn(async (records: readonly VectorRecord[]) => { for (const record of records) vectors.set(record.id, record); });
const remove = vi.fn(async (ids: readonly string[]) => { for (const id of ids) vectors.delete(id); });
const jobs = new TextIngestionJobs(workerPool, workerConfig, { vectorStore: snapshot => ({ target: snapshot.vectorTarget,
  upsert, delete: async selector => {
    if (selector.ids) await remove(selector.ids);
    else if (selector.scope) await remove([...vectors.values()].filter(row => Object.entries(selector.scope!).every(([key, value]) => row.metadata[key] === value)).map(row => row.id));
  }, close: async () => undefined }) });
const engine = new TaskEngine(workerPool, 15_000, undefined, undefined, undefined, undefined, undefined, jobs);
const recalled = (options: MilvusSearchOptions) => [...vectors.values()].filter(row => {
  const m = row.metadata;
  return m.user_id === options.scope.userId && m.workspace_id === options.scope.workspaceId && m.source_type === options.scope.sourceType
    && 'versions' in options.scope && options.scope.versions.some(build => m.document_id === build.documentId && m.document_version === build.versionId && m.index_build_id === build.indexBuildId);
}).map(row => ({ chunkKey: row.id, state: 'ready', score: 0.9 }));
const milvus = { ensureReady: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
  search: vi.fn(async (_vector: number[], options: MilvusSearchOptions) => recalled(options)),
  searchKeyword: vi.fn(async (_query: string, options: MilvusSearchOptions) => recalled(options)),
  hybridSearch: vi.fn(async (_vector: number[], _query: string, options: MilvusSearchOptions) => {
    const hits = recalled(options); return [...hits, ...hits, { chunkKey: 'unowned-physical-row', state: 'building', score: 100 }];
  }) };
const fixtureText = '  # Uploaded Economic\r\n\r\nAn economic file preserves its source. 😀  ';
const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/markdown' }); res.end(fixtureText); });
let sourceUrl = '';
const owners: string[] = [];
async function fixture() {
  const userId = await insertFixtureUser(root), sessionId = randomUUID(), workspaceId = randomUUID(); owners.push(userId);
  const bearer = await insertFixtureSession(root, userId, sessionId, 'text-ingestion-fixture');
  await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'text',true,$3)", [workspaceId, userId, randomUUID()]);
  return { scope: { userId, sessionId, traceId: randomUUID() }, bearer, workspaceId };
}
async function taskId(id: string): Promise<string> { return (await root.query<{ current_task_id: string }>('SELECT current_task_id FROM text_ingestion_jobs WHERE id=$1', [id])).rows[0]!.current_task_id; }
async function run(id: string) { const attempt = await engine.claim(await taskId(id), randomUUID()); expect(attempt).toBeTruthy(); expect(await engine.execute(attempt!)).toBe(true); }

describe('independent text import API and real SQL orchestration', () => {
  beforeAll(async () => {
    await migrate(loadConfig('migrate', { DATABASE_URL: migrationUrl }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('HTTP_FIXTURE_FAILED');
    sourceUrl = `http://127.0.0.1:${address.port}/fixture.md`;
  });
  afterAll(async () => {
    await root.query("UPDATE tasks SET state='cancelled' WHERE user_id=ANY($1::uuid[]) AND state IN ('queued','retry_scheduled')", [owners]);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await jobs.close(); await Promise.all([root.end(), pool.end(), workerPool.end()]);
  });
  it('exposes strict JWT-owned inputs and retains exact text with Unix millisecond timestamps', async () => {
    const user = await fixture(), app = await buildApiServer({ config });
    const raw = '  # 经济\r\n\r\nEconomic 😀\n尾部  ';
    const headers = { authorization: `Bearer ${user.bearer}`, 'x-idempotency-key': randomUUID() };
    try {
      expect((await app.inject({ method: 'POST', url: '/api/v1/text-ingestions', payload: { source_type: Source.MANUAL_INPUT, raw_content: raw } })).statusCode).toBe(401);
      for (const extra of [{ created_by: randomUUID() }, { ingest_status: 'success' }, { userId: randomUUID() }, { rag_chunk_version: 1 }]) {
        expect((await app.inject({ method: 'POST', url: '/api/v1/text-ingestions', headers, payload: { source_type: Source.MANUAL_INPUT, raw_content: raw, ...extra } })).statusCode).toBe(400);
      }
      for (const invalid of [123, '\u0000', '\ud800']) {
        expect((await app.inject({ method: 'POST', url: '/api/v1/text-ingestions', headers, payload: { source_type: Source.MANUAL_INPUT, raw_content: invalid } })).statusCode).toBe(400);
      }
      const response = await app.inject({ method: 'POST', url: '/api/v1/text-ingestions', headers, payload: { source_type: Source.MANUAL_INPUT, raw_content: raw } });
      expect(response.statusCode, response.body).toBe(200);
      const job = response.json().data;
      expect(job).toMatchObject({ source_type: Source.MANUAL_INPUT, raw_content: raw, origin_resource_uri: null, ingest_status: 'pending', created_by: user.scope.userId });
      expect(job.created_at).toBeGreaterThan(1_000_000_000_000); expect(Number.isSafeInteger(job.updated_at)).toBe(true);
      const again = await app.inject({ method: 'POST', url: '/api/v1/text-ingestions', headers, payload: { source_type: Source.MANUAL_INPUT, raw_content: raw } });
      expect(again.json().data.id).toBe(job.id);
      await run(job.id);
      const read = await app.inject({ method: 'GET', url: `/api/v1/text-ingestions/${job.id}`, headers: { authorization: headers.authorization } });
      expect(read.json().data).toMatchObject({ raw_content: raw, ingest_status: 'success' }); expect(read.headers.etag).toBeTruthy();
      const chunks = (await root.query('SELECT * FROM text_ingestion_chunks WHERE parent_id=$1 ORDER BY ordinal', [job.id])).rows;
      expect(chunks.length).toBeGreaterThan(0);
      for (const [ordinal, chunk] of chunks.entries()) { expect(chunk.ordinal).toBe(ordinal); expect(raw.slice(chunk.source_start, chunk.source_end)).toBe(chunk.content); expect(chunk.index_status).toBe('ready'); expect(chunk.parent_id).toBe(job.id); }
      const note = await root.query('SELECT 1 FROM notes WHERE note_id=$1', [job.id]); expect(note.rowCount).toBe(0);
    } finally { await app.close(); }
  });
  it('enforces the exact 50,000 code-point boundary and rejects unavailable source adapters', async () => {
    const user = await fixture();
    const capService = new TextIngestionService(pool, { ...config, rag: { ...config.rag, childTargetTokens: 500, childMaxTokens: 800, childOverlapTokens: 64, embeddingBatchSize: 16 } });
    const accepted = await capService.create(user.scope, { source_type: Source.MANUAL_INPUT, raw_content: '😀'.repeat(50_000) }, randomUUID());
    expect(Array.from(accepted.raw_content!).length).toBe(50_000); await run(accepted.id);
    expect((await service.get(user.scope, accepted.id)).data.ingest_status).toBe('success');
    await expect(service.create(user.scope, { source_type: Source.MANUAL_INPUT, raw_content: '字'.repeat(50_001) }, randomUUID())).rejects.toMatchObject({ statusCode: 413 });
    for (const source_type of [Source.WEB_CRAWL, Source.IMAGE_OCR, Source.MEDIA_ASR, Source.BOOK_OCR]) {
      await expect(service.create(user.scope, { source_type, origin_resource_uri: sourceUrl }, randomUUID())).rejects.toMatchObject({ statusCode: 503, code: 'TEXT_SOURCE_ADAPTER_UNAVAILABLE' });
    }
  });
  it('downloads a real HTTP text fixture then uses the same indexing pipeline; external raw is read-only', async () => {
    const user = await fixture(), created = await service.create(user.scope, { source_type: Source.FILE_UPLOAD, origin_resource_uri: sourceUrl }, randomUUID());
    expect(created.raw_content).toBeNull(); await run(created.id);
    const read = await service.get(user.scope, created.id); expect(read.data).toMatchObject({ raw_content: fixtureText, ingest_status: 'success' });
    await expect(service.update(user.scope, created.id, { raw_content: 'forged' }, randomUUID(), read.etag)).rejects.toMatchObject({ code: 'TEXT_INGESTION_SOURCE_READ_ONLY' });
    const reimport = await service.create(user.scope, { source_type: Source.FILE_UPLOAD, origin_resource_uri: sourceUrl }, randomUUID());
    expect(reimport.id).not.toBe(created.id);
    await expect(service.create(user.scope, { source_type: Source.FILE_UPLOAD, origin_resource_uri: 'http://unauthorized.test/input.pdf' }, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
  });
  it('keeps the previous active index during an edit and never lets the superseded execution publish', async () => {
    const user = await fixture(), job = await service.create(user.scope, { source_type: Source.MANUAL_INPUT, raw_content: 'first economic body' }, randomUUID());
    await run(job.id); const first = await taskId(job.id), etag = (await service.get(user.scope, job.id)).etag;
    await service.update(user.scope, job.id, { raw_content: 'second economic body' }, randomUUID(), etag);
    const second = await taskId(job.id), secondAttempt = await engine.claim(second, randomUUID()); expect(secondAttempt).toBeTruthy();
    const secondEtag = (await service.get(user.scope, job.id)).etag;
    await expect(service.update(user.scope, job.id, { raw_content: 'lost update' }, randomUUID(), etag)).rejects.toMatchObject({ statusCode: 412 });
    await service.update(user.scope, job.id, { raw_content: 'third economic body' }, randomUUID(), secondEtag);
    await expect(jobs.execute(secondAttempt!)).rejects.toMatchObject({ code: 'TEXT_INGESTION_STALE_ATTEMPT' });
    expect((await root.query('SELECT active_task_id FROM text_ingestion_jobs WHERE id=$1', [job.id])).rows[0].active_task_id).toBe(first);
    await run(job.id);
    expect((await service.get(user.scope, job.id)).data).toMatchObject({ raw_content: 'third economic body', ingest_status: 'success' });
    expect((await root.query('SELECT DISTINCT task_id FROM text_ingestion_chunks WHERE parent_id=$1', [job.id])).rows.map(row => row.task_id)).toEqual([await taskId(job.id)]);
  });
  it('retrieves published text with native dense/keyword/hybrid, deduplicates hits and excludes other owners', async () => {
    const owner = await fixture(), other = await fixture();
    const job = await service.create(owner.scope, { source_type: Source.MANUAL_INPUT, raw_content: 'Economic PostgreSQL text for retrieval.' }, randomUUID()); await run(job.id);
    const app = await buildApiServer({ config, ragQueryDependencies: { milvus, embedding: processingEmbedding(config, config.rag.embeddingModel, config.rag.embeddingDimensions) } });
    try {
      for (const mode of ['dense', 'keyword', 'hybrid']) {
        const response = await app.inject({ method: 'POST', url: '/api/v1/rag/query', headers: { authorization: `Bearer ${owner.bearer}` }, payload: { query: 'Economic', sourceType: 'text', mode, documentId: job.id } });
        expect(response.statusCode, response.body).toBe(200); const results = response.json().data.results;
        expect(results.length).toBeGreaterThan(0); expect(new Set(results.map((row: { chunkId: string }) => row.chunkId)).size).toBe(results.length);
        expect(results[0]).toMatchObject({ sourceType: 'text', parentId: job.id, evidence: { child: expect.stringContaining('Economic') }, context: null });
      }
      await expect(service.get(other.scope, job.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(service.update(other.scope, job.id, { raw_content: 'stolen' }, randomUUID(), (await service.get(owner.scope, job.id)).etag)).rejects.toMatchObject({ statusCode: 404 });
      const response = await app.inject({ method: 'POST', url: '/api/v1/rag/query', headers: { authorization: `Bearer ${other.bearer}` }, payload: { query: 'Economic', sourceType: 'text', documentId: job.id } }); expect(response.statusCode).toBe(404);
    } finally { await app.close(); }
  });
  it('can retry a terminal failed task after workspace restoration using its original frozen target', async () => {
    const user = await fixture(), job = await service.create(user.scope, { source_type: Source.MANUAL_INPUT, raw_content: 'retry original target' }, randomUUID());
    const attempt = await engine.claim(await taskId(job.id), randomUUID()); expect(attempt).toBeTruthy();
    await root.query("UPDATE workspaces SET state='disabled' WHERE id=$1", [user.workspaceId]);
    await expect(jobs.execute(attempt!)).rejects.toMatchObject({ code: 'TEXT_INGESTION_STALE_ATTEMPT' });
    await engine.fail(attempt!, 'TEXT_INGESTION_STALE_ATTEMPT', false);
    await root.query("UPDATE workspaces SET state='ready' WHERE id=$1", [user.workspaceId]);
    expect((await service.get(user.scope, job.id)).data.ingest_status).toBe('failed');
    const changed = new TextIngestionService(pool, { ...config, milvus: { ...config.milvus, collection: 'new_default_must_not_receive_retry' } });
    await changed.retry(user.scope, job.id, randomUUID());
    const input = (await root.query('SELECT i.body FROM tasks t JOIN task_inputs i ON i.id=t.input_id WHERE t.id=$1', [await taskId(job.id)])).rows[0].body;
    expect(JSON.parse(input).snapshot.vectorTarget.collection).toBe(config.milvus.collection);
    await run(job.id); expect((await service.get(user.scope, job.id)).data.ingest_status).toBe('success');
  });
  it('has no business version counter or physical foreign keys', async () => {
    const version = await root.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='text_ingestion_jobs' AND column_name IN ('rag_chunk_version','document_version_id','version')"); expect(version.rows).toEqual([]);
    expect((await root.query("SELECT count(*)::int n FROM pg_constraint WHERE contype='f'")).rows[0].n).toBe(0);
  });
});
