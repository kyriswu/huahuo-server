import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import type { VectorRecord } from '../../src/lib/rag-indexing/index.js';
import { fileProcessingSnapshot, type FileProcessingSnapshot } from '../../src/modules/rag/processing-profile.js';
import type { Attempt } from '../../src/modules/tasks/engine.js';
import { TextIngestionJobs, type TextIngestionJobRow } from '../../src/modules/text-ingestion/jobs.js';
import { TextIngestionSourceType } from '../../src/modules/text-ingestion/types.js';
import { env } from '../helpers.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const content = '  标题🙂\r\n\r\n' + Array.from({ length: 6 }, (_, i) => `第${i}段，精确保留重复文字。\n`).join('') + '  ';
interface Chunk {
  chunk_key: string; parent_id: string; task_id: string; ordinal: number; content: string;
  embedding_text: string; content_hash: string; embedding_text_hash: string; source_hash: string;
  source_start: number; source_end: number; index_status: string;
}
function fixture(source = TextIngestionSourceType.MANUAL_INPUT) {
  const config = loadConfig('worker', { ...env, ALLOW_MOCK_PROVIDERS: 'true', RAG_PROVIDER_MODE: 'mock', RAG_EMBEDDING_DIMENSIONS: '4' });
  const snapshot = fileProcessingSnapshot(config, 'markdown');
  Object.assign(snapshot.split, { targetTokens: 24, maxEmbeddingTokens: 40, overlapTokens: 4, maxSourceChars: 30 });
  Object.assign(snapshot.indexing, { batchSize: 1, concurrency: 1, maxRetries: 0 });
  const taskId = randomUUID(), inputId = randomUUID(), id = randomUUID(), userId = randomUUID(), workspaceId = randomUUID();
  const job: TextIngestionJobRow = { id, workspace_id: workspaceId, created_by: userId, source_type: source,
    raw_content: source === TextIngestionSourceType.MANUAL_INPUT ? content : null,
    origin_resource_uri: source === TextIngestionSourceType.MANUAL_INPUT ? null : 'https://assets.test/source',
    current_task_id: taskId, active_task_id: null, content_hash: null, artifact_uri: null, ingest_status: 'pending', error_msg: null };
  const state = { job, chunks: new Map<string, Chunk>(), valid: true, leaseValid: true, rejectReadyWrite: false };
  const inputs = new Map<string, string>([[inputId, JSON.stringify({ jobId: id, snapshot })]]);
  const taskInputs = new Map<string, string>([[taskId, inputId]]);
  let backup: { job: TextIngestionJobRow; chunks: Map<string, Chunk> } | undefined;
  let retirementRead = false;
  const hooks: { afterRetirement?: () => void } = {};
  const writes: string[] = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    const rows = (items: unknown[]) => ({ rows: items, rowCount: items.length });
    if (sql === 'BEGIN') { backup = { job: { ...state.job }, chunks: new Map([...state.chunks].map(([key, value]) => [key, { ...value }])) }; return rows([]); }
    if (sql === 'COMMIT') { backup = undefined; if (retirementRead) { retirementRead = false; const hook = hooks.afterRetirement; hooks.afterRetirement = undefined; hook?.(); } return rows([]); }
    if (sql === 'ROLLBACK') { if (backup) { state.job = backup.job; state.chunks = backup.chunks; backup = undefined; } return rows([]); }
    if (sql.startsWith('SELECT body FROM task_inputs')) return rows(inputs.has(String(values[0])) ? [{ body: inputs.get(String(values[0])) }] : []);
    if (sql.startsWith('SELECT j.* FROM text_ingestion_jobs')) return rows(state.valid && state.job.current_task_id === values[3] ? [{ ...state.job }] : []);
    if (sql.startsWith('SELECT id FROM tasks')) return rows(state.valid && state.leaseValid && state.job.current_task_id === values[0] ? [{ id: values[0] }] : []);
    if (sql.startsWith('SELECT count(*)')) return rows([{ count: [...state.chunks.values()].filter(c => c.parent_id === values[0] && c.task_id === values[1]).length }]);
    if (sql.startsWith('SELECT chunk_key,ordinal')) return rows([...state.chunks.values()].filter(c => c.parent_id === values[0] && c.task_id === values[1]).sort((a, b) => a.ordinal - b.ordinal));
    if (sql.startsWith('SELECT 1 FROM text_ingestion_chunks')) return rows([...state.chunks.values()].filter(c => c.parent_id === values[0] && c.task_id === values[1] && c.index_status !== 'ready').slice(0, 1));
    if (sql.startsWith('SELECT t.id AS task_id')) {
      retirementRead = true;
      if (state.job.current_task_id !== values[1] || state.job.active_task_id !== values[1]) return rows([]);
      return rows([...taskInputs].filter(([task]) => task !== values[1]).flatMap(([task, input]) => {
        const body = inputs.get(input); return body && (JSON.parse(body) as {jobId?:string}).jobId === values[0] ? [{ task_id: task, body }] : [];
      }));
    }
    if (sql.startsWith('SELECT current_task_id,active_task_id')) return rows([{ current_task_id: state.job.current_task_id, active_task_id: state.job.active_task_id }]);
    if (sql.startsWith('SELECT chunk_key FROM text_ingestion_chunks')) return rows([...state.chunks.values()].filter(c => c.parent_id === values[0] && c.task_id === values[1]).slice(0, Number(values[2])).map(c => ({ chunk_key: c.chunk_key })));
    if (sql.startsWith('INSERT INTO text_ingestion_chunks')) {
      writes.push(sql);
      if (![...state.chunks.values()].some(c => c.task_id === values[2] && c.ordinal === values[3])) {
        state.chunks.set(String(values[0]), { chunk_key: String(values[0]), parent_id: String(values[1]), task_id: String(values[2]), ordinal: Number(values[3]), content: String(values[4]), embedding_text: String(values[5]), content_hash: String(values[6]), embedding_text_hash: String(values[7]), source_hash: String(values[8]), source_start: Number(values[10]), source_end: Number(values[11]), index_status: 'pending' });
      }
      return rows([]);
    }
    if (sql.startsWith('UPDATE text_ingestion_chunks')) {
      if (state.rejectReadyWrite) { state.rejectReadyWrite = false; throw new Error('POSTGRES_TRANSIENT_FAILURE'); }
      const row = state.chunks.get(String(values[2])); if (row && row.task_id === values[1]) row.index_status = String(values[3]);
      return rows([]);
    }
    if (sql.startsWith('DELETE FROM text_ingestion_chunks')) {
      const keys = values[2] as string[] | undefined;
      for (const key of keys ?? [...state.chunks.keys()]) { const row = state.chunks.get(key); if (row && row.parent_id === values[0] && row.task_id === values[1]) state.chunks.delete(key); }
      return rows([]);
    }
    if (sql.startsWith('UPDATE text_ingestion_jobs')) {
      writes.push(sql);
      if (sql.includes('SET raw_content=')) Object.assign(state.job, { raw_content: values[1], content_hash: values[2], artifact_uri: values[3], ingest_status: 'chunking', error_msg: null });
      else if (sql.includes('SET active_task_id=')) Object.assign(state.job, { active_task_id: values[1], ingest_status: 'success', error_msg: null });
      else if (sql.includes('CASE WHEN active_task_id=')) {
        if (state.job.active_task_id !== values[1] || state.job.ingest_status !== 'success') Object.assign(state.job, { ingest_status: 'failed', error_msg: values[2] });
      } else Object.assign(state.job, { ingest_status: values[1], error_msg: null });
      return rows([]);
    }
    throw new Error('UNEXPECTED_QUERY:' + sql.slice(0, 100));
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: async () => client } as unknown as pg.Pool;
  const vectors = new Map<string, VectorRecord>();
  const upsert = vi.fn(async (records: readonly VectorRecord[]) => { for (const record of records) vectors.set(record.id, record); });
  const remove = vi.fn(async (selector: { ids?: readonly string[]; scope?: Readonly<Record<string, string | number | boolean>> }) => {
    for (const [key, value] of vectors) if (selector.ids?.includes(key) || selector.scope && Object.entries(selector.scope).every(([field, expected]) => value.metadata[field] === expected)) vectors.delete(key);
  });
  const storeTargets: string[] = [];
  const vectorStore = (value: FileProcessingSnapshot) => { storeTargets.push(value.vectorTarget.collection); return { target: value.vectorTarget, upsert, delete: remove, close: vi.fn(async () => undefined) }; };
  const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 2, 3, 4]));
  const prepareSource = vi.fn(async () => ({ content, format: 'markdown' as const, artifactUri: 'text/artifact.json' }));
  const dependencies = { vectorStore, embedding: () => ({ model: snapshot.embedding.model, dimensions: 4, embed }), tokenizer: () => ({ id: 'explicit-test-counter', model: snapshot.embedding.model, maxInputTokens: 1000, count: (value: string) => Array.from(value).length }), prepareSource };
  const attempt = { task: { id: taskId, input_id: inputId, user_id: userId, workspace_id: workspaceId }, owner: randomUUID(), version: 2, attempt: 1 } as unknown as Attempt;
  const worker = new TextIngestionJobs(pool, config, dependencies);
  return { config, snapshot, taskId, id, state, inputs, taskInputs, hooks, writes, query, pool, vectors, upsert, remove, storeTargets, embed, prepareSource, dependencies, attempt, worker };
}

describe('independent text ingestion Worker', () => {
  it.each(Object.values(TextIngestionSourceType))('runs %s through the same Child indexing core and preserves exact text', async source => {
    const f = fixture(source);
    expect(await f.worker.execute(f.attempt)).toEqual({ digest: hash(content), bytes: Buffer.byteLength(content) });
    expect(f.state.job).toMatchObject({ ingest_status: 'success', raw_content: content, active_task_id: f.taskId, content_hash: hash(content), error_msg: null });
    expect(f.state.chunks.size).toBeGreaterThan(1);
    for (const chunk of f.state.chunks.values()) {
      expect(content.slice(chunk.source_start, chunk.source_end)).toBe(chunk.content);
      expect(chunk.source_hash).toBe(hash(content));
      expect(chunk.index_status).toBe('ready');
    }
    for (const vector of f.vectors.values()) expect(vector.metadata).toMatchObject({ parent_id: f.id, source_type: 'text', document_version: f.taskId, index_build_id: f.taskId });
    const keys = [...f.state.chunks.keys()], calls = f.embed.mock.calls.length;
    await f.worker.execute(f.attempt);
    expect([...f.state.chunks.keys()]).toEqual(keys); expect(f.embed).toHaveBeenCalledTimes(calls);
    expect(f.prepareSource).toHaveBeenCalledTimes(source === TextIngestionSourceType.MANUAL_INPUT ? 0 : 1);
  });

  it.each([TextIngestionSourceType.WEB_CRAWL, TextIngestionSourceType.IMAGE_OCR, TextIngestionSourceType.MEDIA_ASR, TextIngestionSourceType.BOOK_OCR])('fails closed for unconfigured %s without pretending to parse', async source => {
    const f = fixture(source), worker = new TextIngestionJobs(f.pool, f.config, { ...f.dependencies, prepareSource: undefined });
    await expect(worker.execute(f.attempt)).rejects.toMatchObject({ code: 'TEXT_SOURCE_ADAPTER_UNAVAILABLE', retryable: false });
    expect(f.state.job).toMatchObject({ ingest_status: 'failed', error_msg: 'TEXT_SOURCE_ADAPTER_UNAVAILABLE', raw_content: null });
    expect(f.embed).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
  });

  it('rejects a lost lease before preprocessing or writing any state', async () => {
    const f = fixture(); f.state.valid = false;
    await expect(f.worker.execute(f.attempt)).rejects.toMatchObject({ code: 'TEXT_INGESTION_STALE_ATTEMPT' });
    expect(f.writes).toEqual([]); expect(f.prepareSource).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled();
  });

  it('rechecks the task lease after acquiring the source lock', async () => {
    const f = fixture(); f.state.leaseValid = false;
    await expect(f.worker.execute(f.attempt)).rejects.toMatchObject({ code: 'TEXT_INGESTION_STALE_ATTEMPT' });
    const locks = f.query.mock.calls.map(call => call[0]).filter(sql => sql.includes('FOR UPDATE OF j') || sql.includes('FOR SHARE'));
    expect(locks).toHaveLength(2); expect(locks[0]).toContain('FOR UPDATE OF j'); expect(locks[1]).toContain('FOR SHARE');
    expect(f.writes).toEqual([]);
  });

  it('does not relabel an incompatible Embedding adapter as the configured model', async () => {
    const f = fixture();
    const worker = new TextIngestionJobs(f.pool, f.config, { ...f.dependencies, embedding: () => ({ model: 'different-model', dimensions: 4, embed: f.embed }) });
    await expect(worker.execute(f.attempt)).rejects.toMatchObject({ code: 'TEXT_EMBEDDING_PROFILE_MISMATCH', retryable: false });
    expect(f.embed).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled(); expect(f.state.job.active_task_id).toBeNull();
  });

  it('keeps successful batches ready and retries only pending embeddings with stable keys', async () => {
    const f = fixture(TextIngestionSourceType.WEB_CRAWL);
    const write = f.upsert.getMockImplementation()!;
    let calls = 0;
    f.upsert.mockImplementation(async records => { calls += 1; if (calls === 2) throw new Error('ONE_BATCH_FAILED'); await write(records); });
    await expect(f.worker.execute(f.attempt)).rejects.toMatchObject({ code: 'TEXT_INDEX_PARTIAL_FAILURE' });
    const ready = [...f.state.chunks.values()].filter(c => c.index_status === 'ready');
    expect(ready.length).toBeGreaterThan(0); expect(f.state.job.active_task_id).toBeNull();
    const readyTexts = new Set(ready.map(c => c.embedding_text));
    f.embed.mockClear();
    await f.worker.execute(f.attempt);
    expect(f.prepareSource).toHaveBeenCalledOnce();
    expect(f.embed.mock.calls.flatMap(call => call[0]).some(text => readyTexts.has(text))).toBe(false);
    expect(f.vectors.size).toBe(f.state.chunks.size); expect(f.state.job.ingest_status).toBe('success');
  });

  it('retries the same Milvus keys if its upsert succeeded but PostgreSQL acknowledgement failed', async () => {
    const f = fixture(); f.state.rejectReadyWrite = true;
    await expect(f.worker.execute(f.attempt)).rejects.toMatchObject({ code: 'TEXT_INGESTION_FAILED' });
    const keys = [...f.vectors.keys()]; expect(keys.length).toBeGreaterThan(0); expect(f.state.job.active_task_id).toBeNull();
    await f.worker.execute(f.attempt);
    expect([...f.vectors.keys()]).toEqual(keys); expect(f.vectors.size).toBe(f.state.chunks.size);
  });

  it('keeps a published index successful when cleanup fails, then retries cleanup in the original target only', async () => {
    const f = fixture(), oldTask = randomUUID(), oldInput = randomUUID();
    const oldSnapshot = { ...f.snapshot, vectorTarget: { ...f.snapshot.vectorTarget, collection: 'original-target' } };
    f.inputs.set(oldInput, JSON.stringify({ jobId: f.id, snapshot: oldSnapshot })); f.taskInputs.set(oldTask, oldInput);
    f.state.job.active_task_id = oldTask;
    f.state.chunks.set('old-chunk', { chunk_key: 'old-chunk', parent_id: f.id, task_id: oldTask, ordinal: 0, content: 'old', embedding_text: 'old', content_hash: hash('old'), embedding_text_hash: hash('old'), source_hash: hash('old'), source_start: 0, source_end: 3, index_status: 'ready' });
    f.remove.mockRejectedValueOnce(new Error('DELETE_FAILED'));
    await expect(f.worker.execute(f.attempt)).rejects.toMatchObject({ code: 'TEXT_INDEX_CLEANUP_FAILED', retryable: true });
    expect(f.state.job).toMatchObject({ ingest_status: 'success', active_task_id: f.taskId, error_msg: null });
    expect(f.state.chunks.has('old-chunk')).toBe(true);
    const calls = f.embed.mock.calls.length;
    await f.worker.execute(f.attempt);
    expect(f.embed).toHaveBeenCalledTimes(calls); expect(f.state.chunks.has('old-chunk')).toBe(false);
    expect(f.storeTargets.filter(target => target === 'original-target')).toHaveLength(2);
  });

  it('does not publish or overwrite new edited text when an old embedding call completes late', async () => {
    const f = fixture(), original = f.upsert.getMockImplementation()!;
    f.upsert.mockImplementation(async records => {
      await original(records);
      f.state.job = { ...f.state.job, current_task_id: randomUUID(), raw_content: 'new edit', content_hash: hash('new edit'), ingest_status: 'pending' };
    });
    await expect(f.worker.execute(f.attempt)).rejects.toMatchObject({ code: 'TEXT_INGESTION_STALE_ATTEMPT' });
    expect(f.state.job).toMatchObject({ raw_content: 'new edit', ingest_status: 'pending', active_task_id: null });
    expect(f.vectors.size).toBe(0); expect(f.state.chunks.size).toBe(0);
    expect(f.remove).toHaveBeenCalledWith({ scope: { source_type: 'text', parent_id: f.id, index_build_id: f.taskId, user_id: f.state.job.created_by, workspace_id: f.state.job.workspace_id } }, expect.anything());
  });

  it('cleans a fixed retirement set without deleting a newer edit created during cleanup', async () => {
    const f = fixture(), oldTask = randomUUID(), oldInput = randomUUID(), newerTask = randomUUID(), newerInput = randomUUID();
    const chunk = (key: string, task: string): Chunk => ({ chunk_key: key, parent_id: f.id, task_id: task, ordinal: 0, content: key, embedding_text: key, content_hash: hash(key), embedding_text_hash: hash(key), source_hash: hash(key), source_start: 0, source_end: key.length, index_status: 'ready' });
    f.taskInputs.set(oldTask, oldInput); f.inputs.set(oldInput, JSON.stringify({ jobId: f.id, snapshot: f.snapshot })); f.state.chunks.set('old', chunk('old', oldTask));
    f.hooks.afterRetirement = () => {
      f.state.job = { ...f.state.job, current_task_id: newerTask, raw_content: 'new edit', content_hash: hash('new edit'), ingest_status: 'pending' };
      f.taskInputs.set(newerTask, newerInput); f.inputs.set(newerInput, JSON.stringify({ jobId: f.id, snapshot: f.snapshot }));
      f.state.chunks.set('newer', chunk('newer', newerTask));
    };
    await f.worker.execute(f.attempt);
    expect(f.state.chunks.has('old')).toBe(false); expect(f.state.chunks.has('newer')).toBe(true);
    expect(f.state.job).toMatchObject({ current_task_id: newerTask, ingest_status: 'pending', active_task_id: f.taskId });
    expect(f.remove.mock.calls.map(call => call[0].scope?.index_build_id)).toEqual([oldTask]);
    const selections = f.query.mock.calls.filter(call => call[0].startsWith('SELECT t.id AS task_id'));
    expect(selections).toHaveLength(1); expect(selections[0]![0]).toContain('j.current_task_id=$2 AND j.active_task_id=$2');
  });

  it('retains an old active index when a superseded attempt finishes late', async () => {
    const f = fixture(), original = f.upsert.getMockImplementation()!;
    f.upsert.mockImplementation(async records => {
      await original(records);
      // Another attempt of this stable build already published it; a newer
      // edit is pending and still needs that active evidence as its fallback.
      f.state.job = { ...f.state.job, current_task_id: randomUUID(), active_task_id: f.taskId, raw_content: 'new edit', ingest_status: 'pending' };
    });
    await expect(f.worker.execute(f.attempt)).rejects.toMatchObject({ code: 'TEXT_INGESTION_STALE_ATTEMPT' });
    expect(f.remove).not.toHaveBeenCalled(); expect(f.vectors.size).toBeGreaterThan(0); expect(f.state.chunks.size).toBeGreaterThan(0);
  });

  it('reports stale-build cleanup failure and retains PostgreSQL evidence for retry', async () => {
    const f = fixture(), original = f.upsert.getMockImplementation()!;
    f.upsert.mockImplementation(async records => { await original(records); f.state.job = { ...f.state.job, current_task_id: randomUUID(), raw_content: 'new edit', ingest_status: 'pending' }; });
    f.remove.mockRejectedValue(new Error('MILVUS_UNAVAILABLE'));
    await expect(f.worker.execute(f.attempt)).rejects.toMatchObject({ code: 'TEXT_STALE_CLEANUP_FAILED', retryable: true });
    expect(f.state.chunks.size).toBeGreaterThan(0); expect(f.vectors.size).toBeGreaterThan(0);
    expect(f.state.job).toMatchObject({ raw_content: 'new edit', ingest_status: 'pending' });
  });
});
