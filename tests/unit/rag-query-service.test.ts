import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { RagQueryService, type RagQueryDependencies, type RagQueryMode } from '../../src/modules/rag/query-service.js';
import { MilvusError, type MilvusSearchHit } from '../../src/modules/rag/adapters/milvus.js';
import { config as baseConfig } from '../helpers.js';
import { vectorConnectionId } from '../../src/modules/rag/vector-store.js';

const versionId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const scope = { userId, sessionId, traceId: 'trace' };
const version = { id: versionId, workspace_id: 'workspace', user_id: userId, status: 'SUCCEEDED', embedding_model: 'mock', embedding_dimension: 8, child_count: 2, document_key: 'document-key', source_pk: 'source-key', embedding_profile: 'mock-8', index_build_id: 'build-one', active: true, processing_snapshot: { providerMode: 'mock', vectorTarget: { connectionId: vectorConnectionId(config()), database: config().milvus.database, collection: config().milvus.collection }, embedding: { model: 'mock', dimensions: 8, profile: 'mock-8' } } };
const child = { id: 'database-child-id', version_id: versionId, parent_id: versionId, source_type: 'file', source_revision: 'body-hash', document_key: 'document-key', chunk_key: 'child-key', chunk_count: 2, embedding_profile: 'mock-8', index_build_id: 'build-one', ordinal: 0, content: 'alpha body from PostgreSQL', embedding_text: 'alpha embedding text', token_count: 2, metadata: {} };
type VersionFixture = Omit<typeof version, 'processing_snapshot'> & { processing_snapshot: typeof version.processing_snapshot | null };

function config() {
  const value = baseConfig();
  Object.assign(value.rag, { providerMode: 'mock', embeddingDimensions: 8, embeddingModel: 'mock', embeddingProfile: 'mock-8' });
  return value;
}

function database(options: { versions?: VersionFixture[]; children?: Array<typeof child>; validSession?: boolean; manual?: boolean; retireDuringRecall?: boolean } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM user_sessions')) return { rows: options.validSession === false ? [] : [{ id: sessionId }], rowCount: options.validSession === false ? 0 : 1 };
      if (sql.includes('FROM note_index_state')) {
        const rows = options.manual ? [{ document_id: versionId, workspace_id: version.workspace_id, task_id: 'current-task', chunk_count: 3,
          ready_ids: [child.chunk_key], processing_snapshot: version.processing_snapshot }] : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('FROM document_ingestion_chunks')) {
        const rows = options.manual && !options.retireDuringRecall ? [{ chunk_id: child.chunk_key, text: child.content, chunk_index: 0 }] : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('FROM rag_ingestion_versions')) {
        const rows = (options.versions ?? [version]).filter(row => row.user_id === params[0] && (!sql.includes('AND v.processing_snapshot IS NOT NULL') || row.processing_snapshot !== null) && (params.length < 3 || [row.id, row.document_key, row.source_pk].includes(String(params[2]))));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('FROM rag_child_chunks')) {
        const rows = options.children ?? [child];
        return { rows, rowCount: rows.length };
      }
      throw new Error('Unexpected fixture database query');
    },
    release() {},
  };
  return { pool: { async connect() { return client; } } as unknown as pg.Pool, calls };
}

type VectorIndex = NonNullable<RagQueryDependencies['milvus']>;
const untrustedIndexHit: MilvusSearchHit & { text: string } = { chunkKey: 'child-key', score: 0.032, state: 'ready', text: 'untrusted index copy' };
function vectorIndex(hits: MilvusSearchHit[] = [untrustedIndexHit]) {
  return {
    close: vi.fn<VectorIndex['close']>().mockResolvedValue(undefined),
    ensureReady: vi.fn<VectorIndex['ensureReady']>().mockResolvedValue(undefined),
    search: vi.fn<VectorIndex['search']>().mockResolvedValue(hits),
    searchKeyword: vi.fn<VectorIndex['searchKeyword']>().mockResolvedValue(hits),
    hybridSearch: vi.fn<VectorIndex['hybridSearch']>().mockResolvedValue(hits),
  };
}

function embedding() { return { model: 'mock', dimensions: 8, embed: vi.fn().mockResolvedValue([Array.from({ length: 8 }, () => 0.25)]) }; }

describe('RAG query service', () => {
  it('excludes records without a frozen target from default retrieval without guessing the current route', async () => {
    const db = database({ versions: [{ ...version, processing_snapshot: null }] });
    const milvus = vectorIndex(); const embedder = embedding();
    const result = await new RagQueryService(db.pool, config(), { milvus, embedding: embedder }).query(scope, { query: 'alpha' });
    expect(result.results).toEqual([]);
    expect(db.calls.find(call => call.sql.includes('FROM rag_ingestion_versions'))?.sql).toContain('AND v.processing_snapshot IS NOT NULL');
    expect(milvus.ensureReady).not.toHaveBeenCalled(); expect(embedder.embed).not.toHaveBeenCalled();
  });

  it('rejects an explicitly selected record without a frozen target before contacting providers', async () => {
    const db = database({ versions: [{ ...version, processing_snapshot: null }] }); const milvus = vectorIndex();
    await expect(new RagQueryService(db.pool, config(), { milvus }).query(scope, { query: 'alpha', documentKey: version.document_key })).rejects.toMatchObject({ statusCode: 503, code: 'RAG_TARGET_SNAPSHOT_UNAVAILABLE' });
    expect(db.calls.find(call => call.sql.includes('FROM rag_ingestion_versions'))?.sql).not.toContain('AND v.processing_snapshot IS NOT NULL');
    expect(milvus.ensureReady).not.toHaveBeenCalled();
  });

  it('rejects a stored target for another connection before contacting a vector provider', async () => {
    const settings = config(); const milvus = vectorIndex();
    const routed = { ...version, milvus_collection: 'original_collection', processing_snapshot: { providerMode: 'mock', vectorTarget: { connectionId: 'another-primary', database: 'original_db', collection: 'original_collection' }, embedding: { model: version.embedding_model, dimensions: version.embedding_dimension, profile: version.embedding_profile } } };
    await expect(new RagQueryService(database({ versions: [routed] }).pool, settings, { milvus }).query(scope, { query: 'alpha', mode: 'keyword' })).rejects.toMatchObject({ statusCode: 503, code: 'RAG_TARGET_UNAVAILABLE' });
    expect(milvus.ensureReady).not.toHaveBeenCalled(); expect(milvus.searchKeyword).not.toHaveBeenCalled();
  });

  it('searches stored target groups independently and applies one global candidate budget', async () => {
    const settings = config(); const milvus = vectorIndex();
    const first = { ...version, milvus_collection: 'original_collection', processing_snapshot: { providerMode: 'mock', vectorTarget: { connectionId: vectorConnectionId(settings), database: 'original_db', collection: 'original_collection' }, embedding: { model: version.embedding_model, dimensions: version.embedding_dimension, profile: version.embedding_profile } } };
    const second = { ...first, id: '44444444-4444-4444-8444-444444444444', document_key: 'second-doc', processing_snapshot: { ...first.processing_snapshot, vectorTarget: { ...first.processing_snapshot.vectorTarget, database: 'second_db', collection: 'second_collection' } } };
    const rerank = vi.fn<NonNullable<RagQueryDependencies['rerank']>['rerank']>().mockImplementation(async (_query, candidates) => candidates.map(candidate => ({ ...candidate, rerankScore: 0.9 })));
    const result = await new RagQueryService(database({ versions: [first, second] }).pool, settings, { milvus, embedding: embedding(), rerank: { rerank } }).query(scope, { query: 'alpha' });
    expect(milvus.hybridSearch).toHaveBeenCalledTimes(2);
    expect(milvus.hybridSearch.mock.calls.map(call => ('versions' in call[2].scope ? call[2].scope.versions.map(row => row.versionId) : []))).toEqual([[first.id], [second.id]]);
    expect(result.results).toHaveLength(1); expect(rerank.mock.calls[0]?.[1]).toHaveLength(1);
    expect(result.results[0]?.rrfScore).toBe(untrustedIndexHit.score);
  });

  it.each<{ query: string; mode: RagQueryMode }>([
    { query: '关系型数据库并发控制', mode: 'dense' },
    { query: '关系型数据库并发控制', mode: 'keyword' },
    { query: 'relational database concurrency', mode: 'dense' },
    { query: 'relational database concurrency', mode: 'keyword' },
    { query: '数据库 MVCC B-tree Index', mode: 'hybrid' },
    { query: 'MVCC', mode: 'hybrid' },
  ])('routes $mode query "$query" only to Milvus and preserves its score', async ({ query, mode }) => {
    const db = database(); const milvus = vectorIndex(); const embedder = embedding();
    const result = await new RagQueryService(db.pool, config(), { milvus, embedding: embedder }).query(scope, { query, mode });
    expect(milvus.search).toHaveBeenCalledTimes(mode === 'dense' ? 1 : 0);
    expect(milvus.searchKeyword).toHaveBeenCalledTimes(mode === 'keyword' ? 1 : 0);
    expect(milvus.hybridSearch).toHaveBeenCalledTimes(mode === 'hybrid' ? 1 : 0);
    if (mode === 'keyword') {
      expect(embedder.embed).not.toHaveBeenCalled();
      expect(milvus.searchKeyword).toHaveBeenCalledWith(query, expect.any(Object));
    } else {
      expect(embedder.embed).toHaveBeenCalledExactlyOnceWith([query]);
      if (mode === 'hybrid') expect(milvus.hybridSearch).toHaveBeenCalledWith(expect.any(Array), query, expect.any(Object));
    }
    const scoreField = mode === 'dense' ? 'denseScore' : mode === 'keyword' ? 'keywordScore' : 'rrfScore';
    expect(result.results[0]?.[scoreField]).toBe(untrustedIndexHit.score);
    // PostgreSQL only authorizes and hydrates keys; it never receives a recall query.
    expect(db.calls.some(call => /tsvector|tsquery|ts_rank|\bI?LIKE\b/iu.test(call.sql))).toBe(false);
    expect(db.calls.flatMap(call => call.params)).not.toContain(query);
  });

  it('retrieves keyword candidates only through native BM25 and hydrates PostgreSQL content', async () => {
    const db = database(); const milvus = vectorIndex(); const embedder = embedding();
    const service = new RagQueryService(db.pool, config(), { milvus, embedding: embedder });
    const result = await service.query(scope, { query: 'alpha', mode: 'keyword' });
    expect(milvus.searchKeyword).toHaveBeenCalledWith('alpha', expect.objectContaining({ limit: 20, scope: { userId, workspaceId: 'workspace', sourceType: 'file', versions: [{ documentId: 'document-key', versionId, embeddingProfile: 'mock-8', indexBuildId: 'build-one' }] } }));
    expect(embedder.embed).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ content: child.content, parentId: versionId, context: null, keywordScore: 0.032, rrfScore: 0 });
    expect(result.results[0]).not.toHaveProperty('parentChunkKey');
    expect(result.results[0]).not.toHaveProperty('parentUniqKey');
    expect(db.calls.some(call => /to_tsvector|plainto_tsquery|ILIKE/.test(call.sql))).toBe(false);
  });

  it.each<RagQueryMode>(['dense', 'keyword', 'hybrid'])('rejects %s retrieval when Milvus is unavailable instead of falling back to PostgreSQL', async mode => {
    const db = database(); const service = new RagQueryService(db.pool, config());
    await expect(service.query(scope, { query: 'alpha', mode })).rejects.toMatchObject({ statusCode: 503, code: 'RAG_SEARCH_UNAVAILABLE' });
    expect(db.calls.some(call => call.sql.includes('FROM rag_child_chunks'))).toBe(false);
  });

  it('does not fall back when Milvus BM25 fails', async () => {
    const db = database(); const milvus = vectorIndex();
    milvus.searchKeyword.mockRejectedValue(new MilvusError('MILVUS_UNAVAILABLE', 'unavailable'));
    await expect(new RagQueryService(db.pool, config(), { milvus }).query(scope, { query: 'alpha', mode: 'keyword' })).rejects.toMatchObject({ code: 'RAG_SEARCH_UNAVAILABLE' });
    expect(db.calls.some(call => call.sql.includes('FROM rag_child_chunks'))).toBe(false);
  });

  it('returns no results without contacting providers when this user has no allowed documents', async () => {
    const milvus = vectorIndex(); const embedder = embedding();
    const service = new RagQueryService(database({ versions: [] }).pool, config(), { milvus, embedding: embedder });
    expect(await service.query(scope, { query: 'alpha' })).toEqual({ mode: 'hybrid', query: 'alpha', results: [] });
    expect(milvus.ensureReady).not.toHaveBeenCalled(); expect(embedder.embed).not.toHaveBeenCalled();
  });

  it('does not expose another user document or permit an invalid database session', async () => {
    const milvus = vectorIndex();
    const service = new RagQueryService(database().pool, config(), { milvus });
    await expect(service.query({ ...scope, userId: 'foreign-user' }, { query: 'alpha', documentKey: 'document-key' })).rejects.toMatchObject({ code: 'RAG_DOCUMENT_NOT_FOUND' });
    await expect(new RagQueryService(database({ validSession: false }).pool, config(), { milvus }).query(scope, { query: 'alpha' })).rejects.toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
    expect(milvus.ensureReady).not.toHaveBeenCalled();
  });

  it('binds exact version/profile/build pairs and user/workspace/active/ready guards during hydration', async () => {
    const secondVersion = { ...version, id: '44444444-4444-4444-8444-444444444444', document_key: 'second-doc', index_build_id: 'build-two' };
    const db = database({ versions: [version, secondVersion] }); const milvus = vectorIndex();
    await new RagQueryService(db.pool, config(), { milvus }).query(scope, { query: 'alpha', mode: 'keyword' });
    const hydration = db.calls.find(call => call.sql.includes('FROM rag_child_chunks'))!;
    expect(hydration.sql).toContain('v.user_id=$1 AND v.workspace_id=$2');
    expect(hydration.sql).toContain('v.active=true');
    expect(hydration.sql).toContain("c.embedding_status='ready' AND c.index_status='ready'");
    expect(hydration.sql).toContain('allowed.version_id=c.version_id AND allowed.document_key=c.document_key');
    expect(hydration.sql).toContain('allowed.embedding_profile=c.embedding_profile AND allowed.index_build_id=c.index_build_id');
    expect(hydration.sql).not.toContain('rag_parent_segments');
    expect(hydration.sql).not.toMatch(/parent_chunk_key|parent_segment_id|parent_ordinal/);
    expect(hydration.params.slice(0, 3)).toEqual([userId, 'workspace', ['child-key']]);
    expect(JSON.parse(String(hydration.params[3]))).toEqual([version, secondVersion].map(row => ({ version_id: row.id, document_key: row.document_key, embedding_profile: row.embedding_profile, index_build_id: row.index_build_id })));
  });

  it('uses native hybrid scores once, configured candidate limits, and PostgreSQL text for rerank', async () => {
    const db = database(); const milvus = vectorIndex(); const embedder = embedding();
    const rerank = vi.fn<NonNullable<RagQueryDependencies['rerank']>['rerank']>().mockImplementation(async (_query, candidates) => candidates.map(candidate => ({ ...candidate, rerankScore: 0.9 })));
    const settings = config(); settings.milvus.hybridCandidates = 25;
    const service = new RagQueryService(db.pool, settings, { milvus, embedding: embedder, rerank: { rerank } });
    const result = await service.query(scope, { query: 'alpha', mode: 'hybrid', topK: 1 });
    expect(milvus.hybridSearch).toHaveBeenCalledWith(expect.any(Array), 'alpha', expect.objectContaining({ limit: 25, dimensions: 8, scope: expect.any(Object) }));
    expect(milvus.search).not.toHaveBeenCalled(); expect(milvus.searchKeyword).not.toHaveBeenCalled();
    expect(rerank).toHaveBeenCalledWith('alpha', [expect.objectContaining({ content: child.content, rrfScore: 0.032 })]);
    expect(result.results[0]).toMatchObject({ chunkKey: 'child-key', documentVersionId: versionId, chunkOrdinal: 0, denseScore: 0, keywordScore: 0, rrfScore: 0.032, rerankScore: 0.9 });
  });

  it('preserves dense scores and raises candidate count to the bounded requested topK', async () => {
    const milvus = vectorIndex([{ chunkKey: 'child-key', score: 0.91, state: 'ready' }]);
    const service = new RagQueryService(database().pool, config(), { milvus, embedding: embedding() });
    const result = await service.query(scope, { query: 'alpha', mode: 'dense', topK: 50 });
    expect(milvus.search).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ limit: 50 }));
    expect(result.results[0]).toMatchObject({ denseScore: 0.91, keywordScore: 0, rrfScore: 0 });
  });

  it('drops building/unknown-state hits, hydrates stable keys only, and keeps the highest duplicate score', async () => {
    const db = database();
    const milvus = vectorIndex([{ chunkKey: 'child-key', score: 99, state: 'building' }, { chunkKey: 'child-key', score: 100 }, { chunkKey: 'child-key', score: 0.02, state: 'ready' }, { chunkKey: 'child-key', score: 0.04, state: 'ready' }, { chunkKey: 'not-in-postgres', score: 2, state: 'ready' }]);
    const result = await new RagQueryService(db.pool, config(), { milvus, embedding: embedding() }).query(scope, { query: 'alpha' });
    expect(result.results).toHaveLength(1); expect(result.results[0]).toMatchObject({ chunkKey: 'child-key', rrfScore: 0.04 });
  });

  it('returns whole-source parent IDs without a chapter entity or parent aliases', async () => {
    const children = [child, { ...child, chunk_key: 'child-two', ordinal: 1 }, { ...child, chunk_key: 'child-three', ordinal: 2 }];
    const milvus = vectorIndex(children.map((row, index) => ({ chunkKey: row.chunk_key, score: 3 - index, state: 'ready' })));
    const db=database({children});
    const service = new RagQueryService(db.pool, config(), { milvus, resolveAssets: async content => content });
    const result = await service.query(scope, { query: 'alpha', mode: 'keyword' });
    expect(result.results).toHaveLength(3);
    expect(result.results.every(row=>row.context===null&&row.parentId===versionId&&!('parentChunkKey' in row)&&!('parentUniqKey' in row))).toBe(true);
    expect(result.results[0]).toMatchObject({ evidence: { child: child.content } });
    expect(db.calls.some(call=>call.sql.includes('rag_parent_segments'))).toBe(false);
  });

  it.each<RagQueryMode>(['dense', 'keyword', 'hybrid'])('retrieves authorized chunks of a fully ready Note in %s mode', async mode => {
    const db = database({ manual: true });
    const milvus = vectorIndex([untrustedIndexHit, { chunkKey: 'pending-id', score: 90, state: 'ready' }]);
    const result = await new RagQueryService(db.pool, config(), { milvus }).query(scope, { query: 'alpha', mode, sourceType: 'note' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ parentId: versionId, sourceType: 'note', content: child.content, chunkCount: 3, context: null });
    expect(result.results[0]).not.toHaveProperty('sourceRevision');
    const recall = mode === 'dense' ? milvus.search : mode === 'keyword' ? milvus.searchKeyword : milvus.hybridSearch;
    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall.mock.calls[0]?.at(-1)).toMatchObject({ scope: {
      userId, workspaceId: version.workspace_id, sourceType: 'note',
      note: { documentId: versionId, embeddingProfile: 'mock-8', chunkIds: [child.chunk_key] },
    } });
    expect(db.calls.find(call => call.sql.includes('FROM note_index_state'))?.sql).toContain("HAVING bool_and(c.index_status='ready')");
    const hydrate = db.calls.find(call => call.sql.includes('c.chunk_id=ANY'));
    expect(hydrate?.sql).toContain("c.index_status='ready'");
    expect(hydrate?.params).toEqual([versionId, version.workspace_id, [child.chunk_key], userId, 'current-task']);
  });

  it('discards a Note point retired during recall', async () => {
    const db = database({ manual: true, retireDuringRecall: true });
    const result = await new RagQueryService(db.pool, config(), { milvus: vectorIndex() }).query(scope, { query: 'alpha', mode: 'keyword', sourceType: 'note' });
    expect(result.results).toEqual([]);
  });

  it.each(['', 'a-temporary-section-id'])('rejects a chunk whose parent_id is not the complete source record: %s', async parentId => {
    const db = database({ children: [{ ...child, parent_id: parentId }] }); const milvus = vectorIndex();
    await expect(new RagQueryService(db.pool, config(), { milvus }).query(scope, { query: 'alpha', mode: 'keyword' })).rejects.toMatchObject({ statusCode: 503, code: 'RAG_INDEX_SOURCE_INVALID' });
  });
});
