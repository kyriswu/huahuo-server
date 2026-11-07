import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { TextIngestionQueryService } from '../../src/modules/text-ingestion/query.js';
import { fileProcessingSnapshot } from '../../src/modules/rag/processing-profile.js';
import type { RagQueryDependencies, RagQueryMode } from '../../src/modules/rag/query-service.js';
import type { MilvusSearchHit } from '../../src/modules/rag/adapters/milvus.js';
import { config as baseConfig } from '../helpers.js';

const userId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
const sessionId = '44444444-4444-4444-8444-444444444444';
const workspaceId = '55555555-5555-4555-8555-555555555555';
const scope = { userId, sessionId, traceId: 'query-fixture' };
function config() {
  const settings = baseConfig();
  Object.assign(settings.rag, { providerMode: 'mock', rerankProvider: 'disabled', embeddingDimensions: 8, embeddingModel: 'fixture-model', embeddingProfile: 'fixture-model-8' });
  return settings;
}
function job() {
  return { id: jobId, created_by: userId, workspace_id: workspaceId, source_type: 'MANUAL_INPUT', active_task_id: taskId as string | null,
    ingest_status: 'pending', content_hash: 'c'.repeat(64), workspace_ready: true,
    task_input: JSON.stringify({ jobId, snapshot: fileProcessingSnapshot(config(), 'text') }), chunk_count: 7 };
}
function child() { return { chunk_key: 'text-fixture-chunk', parent_id: jobId, task_id: taskId, ordinal: 0, content: 'PostgreSQL 的真实正文🙂', source_hash: 'b'.repeat(64), index_status: 'ready' }; }
type Job = ReturnType<typeof job>;
type Child = ReturnType<typeof child>;
function database(options: { jobs?: Job[]; chunks?: Child[]; validSession?: boolean; publishDuringQuery?: boolean } = {}) {
  const jobs = options.jobs ?? [job()], chunks = options.chunks ?? [child()];
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      const result = (rows: unknown[]) => ({ rows, rowCount: rows.length });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return result([]);
      if (sql.includes('FROM user_sessions')) return result(options.validSession === false ? [] : [{ id: sessionId }]);
      if (sql.startsWith('SELECT j.id')) return result(jobs.filter(row => row.created_by === params[0] && row.workspace_ready && row.active_task_id && (!params[1] || row.id === params[1])));
      if (sql.startsWith('SELECT c.chunk_key')) {
        if (options.publishDuringQuery) return result([]);
        const keys = params[2] as string[];
        const allowed = JSON.parse(String(params[3])) as Array<{ parent_id: string; task_id: string }>;
        return result(chunks.filter(chunk => {
          const source = jobs.find(row => row.id === chunk.parent_id);
          return chunk.index_status === 'ready' && keys.includes(chunk.chunk_key) && source?.workspace_ready && source.created_by === params[0]
            && source.workspace_id === params[1] && source.active_task_id === chunk.task_id && allowed.some(row => row.parent_id === chunk.parent_id && row.task_id === chunk.task_id);
        }));
      }
      throw new Error('UNEXPECTED_FIXTURE_QUERY');
    },
    release() {},
  };
  return { calls, pool: { connect: async () => client } as unknown as pg.Pool };
}
type Index = NonNullable<RagQueryDependencies['milvus']>;
const hit = (score = 0.032): MilvusSearchHit => ({ chunkKey: child().chunk_key, score, state: 'ready' });
function index(hits: MilvusSearchHit[] = [hit()]) {
  return {
    close: vi.fn<Index['close']>().mockResolvedValue(undefined), ensureReady: vi.fn<Index['ensureReady']>().mockResolvedValue(undefined),
    search: vi.fn<Index['search']>().mockResolvedValue(hits), searchKeyword: vi.fn<Index['searchKeyword']>().mockResolvedValue(hits),
    hybridSearch: vi.fn<Index['hybridSearch']>().mockResolvedValue(hits),
  };
}
function embedding() { return { model: 'fixture-model', dimensions: 8, embed: vi.fn().mockResolvedValue([Array<number>(8).fill(0.25)]) }; }

describe('published text ingestion retrieval', () => {
  it.each<{ query: string; mode: RagQueryMode }>([
    { query: '并发控制', mode: 'dense' }, { query: '并发控制', mode: 'keyword' },
    { query: 'economic', mode: 'dense' }, { query: 'economic', mode: 'keyword' },
    { query: 'PostgreSQL 并发 MVCC', mode: 'hybrid' },
  ])('uses native $mode for "$query" and hydrates scoped PostgreSQL content', async ({ query, mode }) => {
    const db = database(), milvus = index(), embedder = embedding();
    const result = await new TextIngestionQueryService(db.pool, config(), { milvus, embedding: embedder }).query(scope, { query, mode });
    expect(milvus.search).toHaveBeenCalledTimes(mode === 'dense' ? 1 : 0);
    expect(milvus.searchKeyword).toHaveBeenCalledTimes(mode === 'keyword' ? 1 : 0);
    expect(milvus.hybridSearch).toHaveBeenCalledTimes(mode === 'hybrid' ? 1 : 0);
    expect(embedder.embed).toHaveBeenCalledTimes(mode === 'keyword' ? 0 : 1);
    const searchOptions = (mode === 'dense' ? milvus.search.mock.calls[0]?.[1] : mode === 'keyword' ? milvus.searchKeyword.mock.calls[0]?.[1] : milvus.hybridSearch.mock.calls[0]?.[2]);
    expect(searchOptions?.scope).toEqual({ userId, workspaceId, sourceType: 'text', versions: [{ documentId: jobId, versionId: taskId, embeddingProfile: config().rag.embeddingProfile, indexBuildId: taskId }] });
    const scoreField = mode === 'dense' ? 'denseScore' : mode === 'keyword' ? 'keywordScore' : 'rrfScore';
    expect(result.results[0]).toMatchObject({ chunkId: child().chunk_key, content: child().content, parentId: jobId, chunkCount: 7, indexBuildId: taskId, sourceRevision: child().source_hash, sourceType: 'text', context: null, [scoreField]: hit().score });
    expect(db.calls.some(call => /tsvector|tsquery|ts_rank|\bI?LIKE\b/iu.test(call.sql))).toBe(false);
    expect(db.calls.flatMap(call => call.params)).not.toContain(query);
  });

  it('keeps the old published text searchable while a manual edit is pending', async () => {
    const db = database();
    const result = await new TextIngestionQueryService(db.pool, config(), { milvus: index(), embedding: embedding() }).query(scope, { query: 'PostgreSQL' });
    expect(result.results[0]?.sourceRevision).toBe(child().source_hash);
    expect(result.results[0]?.sourceRevision).not.toBe(job().content_hash);
    const sql = db.calls.find(call => call.sql.startsWith('SELECT j.id'))!.sql;
    expect(sql).toContain('j.active_task_id IS NOT NULL');
    expect(sql).not.toContain('j.ingest_status');
    expect(db.calls.find(call => call.sql.startsWith('SELECT c.chunk_key'))!.sql).toContain('j.active_task_id=c.task_id');
  });

  it('ignores non-ready and physical duplicate hits, keeping the highest ready score', async () => {
    const db = database(), milvus = index([hit(0.01), { ...hit(9), state: 'building' }, hit(0.08), { chunkKey: 'foreign', score: 10, state: 'ready' }]);
    const result = await new TextIngestionQueryService(db.pool, config(), { milvus, embedding: embedding() }).query(scope, { query: 'text' });
    expect(result.results).toHaveLength(1); expect(result.results[0]?.rrfScore).toBe(0.08);
  });

  it('does not return unpublished chunks or stale hits after a new active task is published', async () => {
    for (const db of [database({ chunks: [{ ...child(), index_status: 'pending' }] }), database({ publishDuringQuery: true })]) {
      const result = await new TextIngestionQueryService(db.pool, config(), { milvus: index(), embedding: embedding() }).query(scope, { query: 'text' });
      expect(result.results).toEqual([]);
    }
  });

  it('rejects revoked sessions before invoking external services', async () => {
    const milvus = index(), embedder = embedding();
    await expect(new TextIngestionQueryService(database({ validSession: false }).pool, config(), { milvus, embedding: embedder }).query(scope, { query: 'text' })).rejects.toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
    expect(milvus.ensureReady).not.toHaveBeenCalled(); expect(embedder.embed).not.toHaveBeenCalled();
  });

  it('cannot search another owner, disabled workspace or absent active index', async () => {
    for (const source of [{ ...job(), created_by: 'another-user' }, { ...job(), workspace_ready: false }, { ...job(), active_task_id: null }]) {
      const milvus = index();
      const result = await new TextIngestionQueryService(database({ jobs: [source] }).pool, config(), { milvus }).query(scope, { query: 'text', mode: 'keyword' });
      expect(result.results).toEqual([]); expect(milvus.searchKeyword).not.toHaveBeenCalled();
    }
  });

  it('rejects a foreign or nonexistent explicitly requested source without querying Milvus', async () => {
    const milvus = index();
    await expect(new TextIngestionQueryService(database().pool, config(), { milvus }).query(scope, { query: 'text', documentKey: 'another-document' })).rejects.toMatchObject({ code: 'RAG_DOCUMENT_NOT_FOUND' });
    expect(milvus.ensureReady).not.toHaveBeenCalled();
  });

  it('validates the stored binding and never guesses a replacement target', async () => {
    const original = fileProcessingSnapshot(config(), 'text');
    for (const snapshot of [null, { ...original, businessStore: 'foreign-store' }, { ...original, vectorTarget: { ...original.vectorTarget, connectionId: 'foreign-instance' } }]) {
      const milvus = index(), db = database({ jobs: [{ ...job(), task_input: JSON.stringify({ jobId, snapshot }) }] });
      await expect(new TextIngestionQueryService(db.pool, config(), { milvus }).query(scope, { query: 'text', mode: 'keyword' })).rejects.toMatchObject({ statusCode: 503 });
      expect(milvus.ensureReady).not.toHaveBeenCalled();
    }
  });

  it('filters out another embedding profile rather than mixing it into current results', async () => {
    const snapshot = fileProcessingSnapshot(config(), 'text'); snapshot.embedding.profile = 'other-profile';
    snapshot.vectorTarget = { ...snapshot.vectorTarget, connectionId: 'retired-instance' };
    const milvus = index(), db = database({ jobs: [{ ...job(), task_input: JSON.stringify({ jobId, snapshot }) }] });
    const result = await new TextIngestionQueryService(db.pool, config(), { milvus }).query(scope, { query: 'text', mode: 'keyword' });
    expect(result.results).toEqual([]); expect(milvus.ensureReady).not.toHaveBeenCalled();
  });

  it('keeps workspace scopes separate and reuses one query embedding across matching models', async () => {
    const nextId = '66666666-6666-4666-8666-666666666666', nextTask = '77777777-7777-4777-8777-777777777777';
    const second = { ...job(), id: nextId, workspace_id: 'another-workspace', active_task_id: nextTask,
      task_input: JSON.stringify({ jobId: nextId, snapshot: fileProcessingSnapshot(config(), 'text') }) };
    const secondChild = { ...child(), parent_id: nextId, task_id: nextTask, chunk_key: 'second-chunk' };
    const db = database({ jobs: [job(), second], chunks: [child(), secondChild] });
    const milvus = index([hit(), { ...hit(), chunkKey: secondChild.chunk_key }]), embedder = embedding();
    const result = await new TextIngestionQueryService(db.pool, config(), { milvus, embedding: embedder }).query(scope, { query: 'text' });
    expect(result.results).toHaveLength(2);
    expect(embedder.embed).toHaveBeenCalledExactlyOnceWith(['text']);
    expect(milvus.hybridSearch.mock.calls.map(call => call[2].scope.workspaceId)).toEqual([workspaceId, second.workspace_id]);
    expect(milvus.hybridSearch.mock.calls.map(call => ('versions' in call[2].scope ? call[2].scope.versions : []))).toEqual([
      [{ documentId: jobId, versionId: taskId, embeddingProfile: config().rag.embeddingProfile, indexBuildId: taskId }],
      [{ documentId: nextId, versionId: nextTask, embeddingProfile: config().rag.embeddingProfile, indexBuildId: nextTask }],
    ]);
  });

  it('reranks PostgreSQL content once and does not accept invented or changed text from a ranker', async () => {
    let suppliedContent = '';
    const rerank = vi.fn<NonNullable<RagQueryDependencies['rerank']>['rerank']>().mockImplementation(async (_query, candidates) => {
      suppliedContent = candidates[0]!.content;
      candidates[0]!.content = 'mutated adapter input';
      return [{ ...candidates[0]!, content: 'untrusted replacement', rerankScore: 0.9 }, { ...candidates[0]!, rerankScore: 0.1 }];
    });
    const result = await new TextIngestionQueryService(database().pool, config(), { milvus: index(), embedding: embedding(), rerank: { rerank } }).query(scope, { query: 'text' });
    expect(rerank).toHaveBeenCalledTimes(1); expect(suppliedContent).toBe(child().content);
    expect(result.results).toHaveLength(1); expect(result.results[0]).toMatchObject({ content: child().content, rerankScore: 0.9, evidence: { child: child().content } });
  });

  it('maps ranking or vector failures to safe errors without a PostgreSQL recall fallback', async () => {
    const db = database();
    await expect(new TextIngestionQueryService(db.pool, config()).query(scope, { query: 'text' })).rejects.toMatchObject({ code: 'RAG_SEARCH_UNAVAILABLE' });
    expect(db.calls.some(call => call.sql.startsWith('SELECT c.chunk_key'))).toBe(false);
    const rerank = vi.fn().mockRejectedValue(new Error('private provider details'));
    await expect(new TextIngestionQueryService(database().pool, config(), { milvus: index(), embedding: embedding(), rerank: { rerank } }).query(scope, { query: 'text' })).rejects.toMatchObject({ code: 'RAG_RERANK_UNAVAILABLE' });
  });

  it('validates actual query vector dimensions before sending a search', async () => {
    const milvus = index(), embedder = embedding(); embedder.embed.mockResolvedValue([[0.1]]);
    await expect(new TextIngestionQueryService(database().pool, config(), { milvus, embedding: embedder }).query(scope, { query: 'text' })).rejects.toMatchObject({ code: 'RAG_SEARCH_UNAVAILABLE' });
    expect(milvus.hybridSearch).not.toHaveBeenCalled();
  });

  it('resolves assets only from authorized PostgreSQL content and leaves persistence untouched', async () => {
    const resolveAssets = vi.fn().mockResolvedValue('rendered signed image');
    const result = await new TextIngestionQueryService(database().pool, config(), { milvus: index(), embedding: embedding(), resolveAssets }).query(scope, { query: 'text' });
    expect(resolveAssets).toHaveBeenCalledExactlyOnceWith(child().content, jobId, scope);
    expect(result.results[0]?.evidence).toEqual({ child: 'rendered signed image' });
  });

  it('retains caller-owned vector clients on shutdown', async () => {
    const milvus = index(), service = new TextIngestionQueryService(database().pool, config(), { milvus });
    await service.close(); expect(milvus.close).not.toHaveBeenCalled();
  });
});
