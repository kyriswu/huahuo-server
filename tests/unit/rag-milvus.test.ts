import { describe, expect, it, vi } from 'vitest';
import {
  CONNECT_STATUS, ConsistencyLevelEnum, DataType, MilvusClient,
  type DescribeCollectionResponse, type FieldSchema, type IndexDescription,
  type MutationResult, type ResStatus, type SearchResultData,
} from '@zilliz/milvus2-sdk-node';
import type { MilvusConfig } from '../../src/config/config.js';
import {
  MilvusRepository, milvusScopeFilter, type MilvusChunkInput, type MilvusSearchScope,
} from '../../src/modules/rag/adapters/milvus.js';
import {
  BM25_FUNCTION, buildMilvusSchema, DENSE_INDEX_NAME, MULTI_ANALYZER_PARAMS, SPARSE_INDEX_NAME,
} from '../../src/modules/rag/adapters/milvus-schema.js';

// Only the constructor is replaced. SDK enums, parameter helpers and request
// types remain real; no test creates a gRPC connection.
vi.mock('@zilliz/milvus2-sdk-node', async importOriginal => {
  const actual = await importOriginal<typeof import('@zilliz/milvus2-sdk-node')>();
  return { ...actual, MilvusClient: vi.fn() };
});

const DIMENSIONS = 4; // Small synthetic vectors for adapter contract tests only.
const status: ResStatus = { error_code: 'Success', code: 0, reason: '', retriable: false, detail: '', extra_info: {} };
const config: MilvusConfig = {
  address: 'unit.invalid:19530', username: 'unit', password: 'unit-only', database: 'default',
  collection: 'huahuo_chunks', tls: true, createIfMissing: true, searchConcurrency: 2,
  denseCandidates: 20, bm25Candidates: 20, hybridCandidates: 30, rrfK: 60,
};
const scope: MilvusSearchScope = {
  userId: 'user-1', workspaceId: 'workspace-1',
  versions: [{ documentId: 'doc-1', versionId: 'version-1', embeddingProfile: 'profile-1', indexBuildId: 'build-1' }],
};

function description(): DescribeCollectionResponse {
  const fields: FieldSchema[] = buildMilvusSchema(DIMENSIONS).map((field, index) => {
    if (typeof field.data_type !== 'number') throw new Error('TEST_SCHEMA_EXPECTS_ENUM');
    const typeParams: FieldSchema['type_params'] = [];
    for (const key of ['dim', 'max_length', 'enable_analyzer', 'multi_analyzer_params'] as const) {
      const value = field[key];
      if (value !== undefined) typeParams.push({ key, value: typeof value === 'object' ? JSON.stringify(value) : String(value) });
    }
    return {
      name: field.name, fieldID: index + 100, description: '', state: 'FieldCreated',
      data_type: DataType[field.data_type] as keyof typeof DataType, dataType: field.data_type,
      is_primary_key: field.is_primary_key ?? false, autoID: field.autoID ?? false,
      is_function_output: field.is_function_output ?? false, index_params: [], type_params: typeParams,
    };
  });
  return {
    status, schema: { name: config.collection, description: '', enable_dynamic_field: false, autoID: false, fields, functions: [structuredClone(BM25_FUNCTION)], struct_array_fields: [] },
    collectionID: '100', collection_name: config.collection, consistency_level: 'Strong', aliases: [],
    virtual_channel_names: [], physical_channel_names: [], start_positions: [], properties: [],
    created_timestamp: '1', created_utc_timestamp: '1', shards_num: 1, db_name: 'default',
    functions: [structuredClone(BM25_FUNCTION)], update_timestamp_str: '1', update_timestamp: 1,
    anns_fields: {}, scalar_fields: {}, function_fields: {},
  };
}

function indexFor(field: string, metric = field === 'dense_vector' ? 'COSINE' : 'BM25'): IndexDescription {
  return {
    index_name: field === 'dense_vector' ? DENSE_INDEX_NAME : SPARSE_INDEX_NAME,
    indexID: 1, field_name: field, indexed_rows: '0', total_rows: '0', state: 'Finished', index_state_fail_reason: '', pending_index_rows: '0',
    params: [
      { key: 'index_type', value: field === 'dense_vector' ? 'HNSW' : 'SPARSE_INVERTED_INDEX' },
      { key: 'metric_type', value: metric },
      { key: 'params', value: JSON.stringify(field === 'dense_vector' ? { M: 16, efConstruction: 128 } : { inverted_index_algo: 'DAAT_MAXSCORE' }) },
    ],
  };
}

function mutation(count: number): MutationResult {
  return { status, succ_index: [], err_index: [], acknowledged: true, insert_cnt: '0', delete_cnt: '0', upsert_cnt: String(count), timestamp: '1', IDs: { str_id: { data: [] } } };
}

function results(rows: SearchResultData[] = []) {
  return { status, results: rows, recalls: [], session_ts: 1, collection_name: config.collection };
}

function setup(options: { exists?: boolean; indexes?: boolean; config?: Partial<MilvusConfig> } = {}) {
  let exists = options.exists ?? true;
  const desc = description();
  const indexes = new Map<string, IndexDescription>(options.indexes === false ? [] : ['dense_vector', 'sparse_vector'].map(field => [field, indexFor(field)]));
  const mocks = {
    hasCollection: vi.fn<MilvusClient['hasCollection']>().mockImplementation(async () => ({ status, value: exists })),
    createCollection: vi.fn<MilvusClient['createCollection']>().mockImplementation(async () => { exists = true; return status; }),
    describeCollection: vi.fn<MilvusClient['describeCollection']>().mockResolvedValue(desc),
    // Real deployments can return every index despite request.field_name.
    describeIndex: vi.fn<MilvusClient['describeIndex']>().mockImplementation(async () => ({ status, index_descriptions: [...indexes.values()] })),
    createIndex: vi.fn<MilvusClient['createIndex']>().mockImplementation(async request => {
      if (Array.isArray(request)) throw new Error('TEST_EXPECTS_ONE_INDEX');
      indexes.set(request.field_name, indexFor(request.field_name)); return status;
    }),
    loadCollection: vi.fn<MilvusClient['loadCollection']>().mockResolvedValue(status),
    upsert: vi.fn<MilvusClient['upsert']>().mockImplementation(async request => mutation((request.data ?? request.fields_data).length)),
    search: vi.fn<MilvusClient['search']>().mockResolvedValue(results()),
    hybridSearch: vi.fn<MilvusClient['hybridSearch']>().mockResolvedValue(results()),
    query: vi.fn<MilvusClient['query']>().mockResolvedValue({ status, data: [{ 'count(*)': '3' }] }),
    getCollectionStatistics: vi.fn<MilvusClient['getCollectionStatistics']>(),
    dropCollection: vi.fn<MilvusClient['dropCollection']>(),
    dropIndex: vi.fn<MilvusClient['dropIndex']>(),
    deleteEntities: vi.fn<MilvusClient['deleteEntities']>(),
    closeConnection: vi.fn<MilvusClient['closeConnection']>().mockResolvedValue(CONNECT_STATUS.SHUTDOWN),
  };
  const client = new MilvusClient({ address: 'unit.invalid:19530' });
  Object.assign(client, mocks, { connectPromise: Promise.resolve() });
  const factory = vi.fn(() => client);
  const repository = new MilvusRepository({ ...config, ...options.config }, factory);
  return { repository, mocks, desc, indexes, factory, setExists(value: boolean) { exists = value; } };
}

function chunkInput(): MilvusChunkInput {
  return {
    chunk: {
      id: 'internal-pg-id', chunkKey: 'doc-1_c0', parentId: 'version-1', sourceType: 'file', sourceRevision: 'version-1', ordinal: 0,
      content: 'PostgreSQL 是一个关系型数据库，支持 MVCC 和 B-tree 索引。',
      embeddingText: 'Database heading\nDifferent embedding prefix', contentHash: 'c'.repeat(64),
      embeddingTextHash: 'e'.repeat(64), tokenCount: 20, headingPath: ['Database'], metadata: {},
    },
    embedding: [1, 0, 0, 0], documentId: 'doc-1', documentVersion: 'version-1', state: 'ready',
    model: 'test-embedding', dimensions: DIMENSIONS, userId: scope.userId, workspaceId: scope.workspaceId,
    embeddingProfile: 'profile-1', indexBuildId: 'build-1',
  };
}

describe('Milvus collection lifecycle', () => {
  it('creates the schema/function and both indexes once across concurrent readiness requests', async () => {
    const { repository, mocks } = setup({ exists: false, indexes: false });
    await Promise.all([repository.ensureReady(DIMENSIONS), repository.ensureReady(DIMENSIONS)]);
    await repository.ensureReady(DIMENSIONS);
    expect(mocks.createCollection).toHaveBeenCalledTimes(1);
    expect(mocks.createCollection).toHaveBeenCalledWith(expect.objectContaining({ collection_name: 'huahuo_chunks', enable_dynamic_field: false, functions: [BM25_FUNCTION] }));
    expect(mocks.createIndex).toHaveBeenCalledTimes(2);
    expect(mocks.createIndex).toHaveBeenCalledWith(expect.objectContaining({ field_name: 'dense_vector', index_type: 'HNSW', metric_type: 'COSINE', params: { M: 16, efConstruction: 128 } }));
    expect(mocks.createIndex).toHaveBeenCalledWith(expect.objectContaining({ field_name: 'sparse_vector', index_type: 'SPARSE_INVERTED_INDEX', metric_type: 'BM25' }));
    expect(mocks.loadCollection).toHaveBeenCalledTimes(1);
    expect(mocks.dropCollection).not.toHaveBeenCalled();
    expect(mocks.dropIndex).not.toHaveBeenCalled();
    expect(mocks.deleteEntities).not.toHaveBeenCalled();
  });

  it('validates an existing collection without creating or replacing it', async () => {
    const { repository, mocks } = setup();
    await repository.ensureReady(DIMENSIONS);
    expect(mocks.describeCollection).toHaveBeenCalledOnce();
    expect(mocks.createCollection).not.toHaveBeenCalled();
    expect(mocks.createIndex).not.toHaveBeenCalled();
  });

  it('creates the missing sparse index when describeIndex also returns the existing dense index', async () => {
    const { repository, mocks, indexes } = setup();
    indexes.delete('sparse_vector');
    await expect(repository.ensureReady(DIMENSIONS)).resolves.toBeUndefined();
    expect(mocks.createIndex).toHaveBeenCalledOnce();
    expect(mocks.createIndex).toHaveBeenCalledWith(expect.objectContaining({ field_name: 'sparse_vector', metric_type: 'BM25' }));
    expect(mocks.dropIndex).not.toHaveBeenCalled();
  });

  it('does not treat an unrelated existing index as successful creation race recovery', async () => {
    const { repository, mocks, indexes } = setup();
    indexes.delete('sparse_vector');
    mocks.createIndex.mockRejectedValueOnce(new Error('sparse creation failed'));
    await expect(repository.ensureReady(DIMENSIONS)).rejects.toMatchObject({ code: 'MILVUS_UNAVAILABLE' });
    expect(mocks.loadCollection).not.toHaveBeenCalled();
  });

  it('handles another process winning collection and index creation races', async () => {
    const { repository, mocks, setExists, indexes } = setup({ exists: false, indexes: false });
    mocks.createCollection.mockImplementationOnce(async () => { setExists(true); throw new Error('already exists'); });
    mocks.createIndex.mockImplementationOnce(async request => {
      if (Array.isArray(request)) throw new Error('TEST_EXPECTS_ONE_INDEX');
      indexes.set(request.field_name, indexFor(request.field_name)); throw new Error('already exists');
    });
    await expect(repository.ensureReady(DIMENSIONS)).resolves.toBeUndefined();
    expect(mocks.hasCollection).toHaveBeenCalledTimes(2);
    expect(mocks.dropCollection).not.toHaveBeenCalled();
    expect(mocks.dropIndex).not.toHaveBeenCalled();
  });

  it('does not swallow a failed create when the collection still does not exist', async () => {
    const { repository, mocks } = setup({ exists: false });
    mocks.createCollection.mockRejectedValueOnce(new Error('network failed'));
    await expect(repository.ensureReady(DIMENSIONS)).rejects.toMatchObject({ code: 'MILVUS_UNAVAILABLE' });
    expect(mocks.loadCollection).not.toHaveBeenCalled();
  });

  it('fails closed when a collection is missing and creation is disabled', async () => {
    const { repository, mocks } = setup({ exists: false, config: { createIfMissing: false } });
    await expect(repository.ensureReady(DIMENSIONS)).rejects.toMatchObject({ code: 'MILVUS_COLLECTION_MISSING' });
    expect(mocks.createCollection).not.toHaveBeenCalled();
  });

  it.each(['primary', 'dimension', 'analyzer', 'function', 'sparse-output'] as const)('rejects incompatible %s schema without destructive repair', async kind => {
    const { repository, mocks, desc } = setup();
    if (kind === 'primary') desc.schema.fields.find(field => field.name === 'id')!.autoID = true;
    if (kind === 'dimension') desc.schema.fields.find(field => field.name === 'dense_vector')!.type_params = [{ key: 'dim', value: 2 }];
    if (kind === 'analyzer') desc.schema.fields.find(field => field.name === 'text')!.type_params = [{ key: 'max_length', value: 65535 }, { key: 'enable_analyzer', value: 'true' }, { key: 'multi_analyzer_params', value: JSON.stringify({ ...MULTI_ANALYZER_PARAMS, by_field: 'wrong' }) }];
    if (kind === 'function') { desc.schema.functions = []; desc.functions = []; }
    if (kind === 'sparse-output') desc.schema.fields.find(field => field.name === 'sparse_vector')!.is_function_output = false;
    await expect(repository.ensureReady(DIMENSIONS)).rejects.toMatchObject({ code: 'MILVUS_SCHEMA_INCOMPATIBLE', retryable: false });
    expect(mocks.dropCollection).not.toHaveBeenCalled();
    expect(mocks.dropIndex).not.toHaveBeenCalled();
    expect(mocks.loadCollection).not.toHaveBeenCalled();
  });

  it('rejects IP for an existing BM25 function output index', async () => {
    const { repository, indexes, mocks } = setup();
    indexes.set('sparse_vector', indexFor('sparse_vector', 'IP'));
    await expect(repository.ensureReady(DIMENSIONS)).rejects.toMatchObject({ code: 'MILVUS_SCHEMA_INCOMPATIBLE' });
    expect(mocks.createIndex).not.toHaveBeenCalled();
    expect(mocks.dropIndex).not.toHaveBeenCalled();
  });

  it.each([undefined, 'not-a-number', 'Infinity', '128'])('rejects a missing or invalid string field max_length: %s', async maxLength => {
    const { repository, mocks, desc } = setup();
    desc.schema.fields.find(field => field.name === 'id')!.type_params = maxLength === undefined ? [] : [{ key: 'max_length', value: maxLength }];
    await expect(repository.ensureReady(DIMENSIONS)).rejects.toMatchObject({ code: 'MILVUS_SCHEMA_INCOMPATIBLE' });
    expect(mocks.createIndex).not.toHaveBeenCalled();
    expect(mocks.loadCollection).not.toHaveBeenCalled();
  });

  it('validates function metadata exposed at the SDK response top level', async () => {
    const { repository, desc } = setup();
    desc.schema.functions = [];
    await expect(repository.ensureReady(DIMENSIONS)).resolves.toBeUndefined();
  });

  it('accepts index details reported as top-level string parameters', async () => {
    const { repository, indexes } = setup();
    const dense = indexFor('dense_vector');
    dense.params = dense.params.filter(pair => pair.key !== 'params').concat([{ key: 'M', value: '16' }, { key: 'efConstruction', value: '128' }]);
    const sparse = indexFor('sparse_vector');
    sparse.params = sparse.params.filter(pair => pair.key !== 'params').concat([{ key: 'inverted_index_algo', value: 'DAAT_MAXSCORE' }]);
    indexes.set('dense_vector', dense); indexes.set('sparse_vector', sparse);
    await expect(repository.ensureReady(DIMENSIONS)).resolves.toBeUndefined();
  });

  it.each([
    { field: 'dense_vector', parameters: '{"M":32,"efConstruction":128}', reason: 'different HNSW M' },
    { field: 'dense_vector', parameters: '{"M":16,"efConstruction":64}', reason: 'different efConstruction' },
    { field: 'dense_vector', parameters: '{"M":16}', reason: 'missing efConstruction' },
    { field: 'dense_vector', parameters: 'not-json', reason: 'malformed index parameters' },
    { field: 'sparse_vector', parameters: '{"inverted_index_algo":"DAAT_WAND"}', reason: 'different sparse algorithm' },
  ])('rejects $reason without replacing an existing index', async ({ field, parameters }) => {
    const { repository, indexes, mocks } = setup();
    const index = indexFor(field);
    index.params.find(pair => pair.key === 'params')!.value = parameters;
    indexes.set(field, index);
    await expect(repository.ensureReady(DIMENSIONS)).rejects.toMatchObject({ code: 'MILVUS_SCHEMA_INCOMPATIBLE', retryable: false });
    expect(mocks.createIndex).not.toHaveBeenCalled(); expect(mocks.dropIndex).not.toHaveBeenCalled();
    expect(mocks.loadCollection).not.toHaveBeenCalled();
  });

  it('rejects a noncanonical BM25 name without installing a parallel function', async () => {
    const { repository, desc, mocks } = setup();
    for (const fn of [...desc.schema.functions!, ...desc.functions!]) fn.name = 'unexpected_bm25';
    await expect(repository.ensureReady(DIMENSIONS)).rejects.toMatchObject({ code: 'MILVUS_SCHEMA_INCOMPATIBLE' });
    expect(mocks.createCollection).not.toHaveBeenCalled();
  });

  it('rejects a noncanonical index name without building a parallel index', async () => {
    const { repository, indexes, mocks } = setup();
    indexes.get('dense_vector')!.index_name = 'unexpected_dense';
    await expect(repository.ensureReady(DIMENSIONS)).rejects.toMatchObject({ code: 'MILVUS_SCHEMA_INCOMPATIBLE' });
    expect(mocks.createIndex).not.toHaveBeenCalled(); expect(mocks.dropIndex).not.toHaveBeenCalled();
  });

  it('does not let a matching nested parameter hide a conflicting top-level value', async () => {
    const { repository, indexes } = setup();
    const dense = indexFor('dense_vector');
    dense.params.push({ key: 'M', value: '32' }); indexes.set('dense_vector', dense);
    await expect(repository.ensureReady(DIMENSIONS)).rejects.toMatchObject({ code: 'MILVUS_SCHEMA_INCOMPATIBLE' });
  });
});

describe('Milvus chunk writes and counts', () => {
  it('upserts stable Child keys, raw text, language and dense vectors without client sparse vectors', async () => {
    const { repository, mocks } = setup();
    const row = chunkInput();
    await repository.upsert([row]); await repository.upsert([row]);
    const requests = mocks.upsert.mock.calls.map(([request]) => request.data ?? request.fields_data);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]?.[0]).toMatchObject({ id: 'doc-1_c0', parent_id: 'version-1', source_type: 'file', source_revision: 'version-1', text: row.chunk.content, dense_vector: row.embedding, language: 'zh', embedding_text_hash: row.chunk.embeddingTextHash });
    expect(requests[0]?.[0]).not.toHaveProperty('sparse_vector');
    expect(requests[0]?.[0]?.text).not.toBe(row.chunk.embeddingText);
    row.chunk.parentId = 'whole-note-record'; row.chunk.sourceType = 'note'; row.chunk.sourceRevision = undefined; row.documentVersion = ''; row.indexBuildId = '';
    await repository.upsert([row]);
    expect(mocks.upsert.mock.calls[2]?.[0].data?.[0]).toMatchObject({ parent_id: 'whole-note-record', source_type: 'note', source_revision: '', document_version: '', index_build_id: '' });
  });

  it.each([
    { reason: 'dimension mismatch', embedding: [1, 2] },
    { reason: 'zero norm', embedding: [0, 0, 0, 0] },
    { reason: 'NaN', embedding: [1, Number.NaN, 0, 0] },
    { reason: 'Infinity', embedding: [1, 0, Number.POSITIVE_INFINITY, 0] },
  ])('rejects invalid dense vector ($reason) before contacting Milvus', async ({ embedding }) => {
    const { repository, factory, mocks } = setup();
    await expect(repository.upsert([{ ...chunkInput(), embedding }])).rejects.toMatchObject({ code: 'MILVUS_SCHEMA_INCOMPATIBLE' });
    expect(factory).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('rejects missing identities and oversized UTF-8 content instead of truncating', async () => {
    const { repository, mocks } = setup(); const row = chunkInput();
    await expect(repository.upsert([{ ...row, userId: '' }])).rejects.toMatchObject({ code: 'MILVUS_SCHEMA_INCOMPATIBLE' });
    await expect(repository.upsert([{ ...row, chunk: { ...row.chunk, content: '文'.repeat(22000) } }])).rejects.toMatchObject({ code: 'MILVUS_TEXT_TOO_LARGE' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('reports incomplete acknowledgements and server errors as failures', async () => {
    const { repository, mocks } = setup();
    mocks.upsert.mockResolvedValueOnce(mutation(0));
    await expect(repository.upsert([chunkInput()])).rejects.toMatchObject({ code: 'MILVUS_UPSERT_INCOMPLETE' });
    mocks.upsert.mockResolvedValueOnce({ ...mutation(1), err_index: [0] });
    await expect(repository.upsert([chunkInput()])).rejects.toMatchObject({ code: 'MILVUS_UPSERT_INCOMPLETE' });
    mocks.upsert.mockResolvedValueOnce({ ...mutation(1), status: { ...status, code: 503 } });
    await expect(repository.upsert([chunkInput()])).rejects.toMatchObject({ code: 'MILVUS_UNAVAILABLE' });
  });

  it('accepts the cloud response with default acknowledged=false and complete mutation evidence', async () => {
    const { repository, mocks } = setup();
    const rows = [0, 1, 2].map(ordinal => ({ ...chunkInput(), chunk: { ...chunkInput().chunk, ordinal, chunkKey: `doc-1_c${ordinal}` } }));
    mocks.upsert.mockResolvedValueOnce({
      ...mutation(3), acknowledged: false, succ_index: [0, 1, 2], insert_cnt: '3', delete_cnt: '3',
      IDs: { str_id: { data: ['doc-1_c0', 'doc-1_c1', 'doc-1_c2'] } }, timestamp: '1',
    });
    await expect(repository.upsert(rows)).resolves.toBeUndefined();
  });

  it('rejects missing mutation counts instead of inferring success from acknowledged', async () => {
    const { repository, mocks } = setup();
    const missingCount = mutation(1);
    Reflect.deleteProperty(missingCount, 'upsert_cnt');
    mocks.upsert.mockResolvedValueOnce(missingCount);
    await expect(repository.upsert([chunkInput()])).rejects.toMatchObject({ code: 'MILVUS_UPSERT_INCOMPLETE' });
  });

  it.each([
    { succeeded: [0, 1], reason: 'partial coverage' },
    { succeeded: [0, 1, 1], reason: 'duplicate positions' },
    { succeeded: [0, 1, 3], reason: 'out of range position' },
    { succeeded: [0, 1, 1.5], reason: 'fractional position' },
  ])('rejects invalid reported success indices: $reason', async ({ succeeded }) => {
    const { repository, mocks } = setup();
    mocks.upsert.mockResolvedValueOnce({ ...mutation(3), succ_index: succeeded });
    const rows = [0, 1, 2].map(ordinal => ({ ...chunkInput(), chunk: { ...chunkInput().chunk, ordinal, chunkKey: `doc-1_c${ordinal}` } }));
    await expect(repository.upsert(rows)).rejects.toMatchObject({ code: 'MILVUS_UPSERT_INCOMPLETE' });
  });

  it('counts current logical ready rows with a scoped strong query, never physical row statistics', async () => {
    const { repository, mocks } = setup();
    await expect(repository.count('doc"1', 'version-1', 'ready')).resolves.toBe(3);
    expect(mocks.query).toHaveBeenCalledWith({ collection_name: config.collection, filter: 'doc_id == "doc\\"1" && document_version == "version-1" && index_status == "ready"', output_fields: ['count(*)'], consistency_level: ConsistencyLevelEnum.Strong });
    expect(mocks.getCollectionStatistics).not.toHaveBeenCalled();
  });
});

describe('explicit Milvus vector cleanup', () => {
  it('deletes only the supplied stable IDs in its bound collection, escaping values', async () => {
    const { repository, mocks } = setup(); mocks.deleteEntities.mockResolvedValueOnce(mutation(0));
    await repository.deleteVectors({ ids: ['file-chunk', 'note"chunk'] });
    expect(mocks.deleteEntities).toHaveBeenCalledExactlyOnceWith({ collection_name: config.collection, expr: 'id in ["file-chunk","note\\"chunk"]' });
    expect(mocks.dropCollection).not.toHaveBeenCalled(); expect(mocks.dropIndex).not.toHaveBeenCalled();
  });

  it('makes an empty ID deletion a no-op rather than guessing a document scope', async () => {
    const { repository, mocks, factory } = setup();
    await repository.deleteVectors({ ids: [] });
    expect(factory).not.toHaveBeenCalled(); expect(mocks.deleteEntities).not.toHaveBeenCalled();
  });

  it('keeps source type, whole-source identity and old revision together during scoped cleanup', async () => {
    const { repository, mocks } = setup(); mocks.deleteEntities.mockResolvedValueOnce(mutation(0));
    await repository.deleteVectors({ scope: { source_type: 'file', parent_id: 'shared-parent', source_revision: 'old"revision', user_id: 'user-1' } });
    expect(mocks.deleteEntities).toHaveBeenCalledExactlyOnceWith({ collection_name: config.collection, expr: 'source_type == "file" && parent_id == "shared-parent" && source_revision == "old\\"revision" && user_id == "user-1"' });
  });

  it('rejects retiring Note points by a whole-source revision', async () => {
    const { repository, mocks } = setup();
    await expect(repository.deleteVectors({ scope: { source_type: 'note', parent_id: 'note-1', source_revision: 'old' } }))
      .rejects.toMatchObject({ code: 'MILVUS_DELETE_SCOPE_INVALID' });
    expect(mocks.deleteEntities).not.toHaveBeenCalled();
  });

  it('deletes only an explicitly scoped text execution without requiring a business version counter', async () => {
    const { repository, mocks } = setup();
    await repository.deleteVectors({ scope: { source_type: 'text', parent_id: 'import-record', index_build_id: 'task-id', user_id: 'user-1', workspace_id: 'workspace-1' } });
    expect(mocks.deleteEntities).toHaveBeenCalledExactlyOnceWith({ collection_name: config.collection,
      expr: 'source_type == "text" && parent_id == "import-record" && index_build_id == "task-id" && user_id == "user-1" && workspace_id == "workspace-1"' });
  });

  it.each(['source_type', 'parent_id', 'source_revision'])('rejects cleanup without %s before connecting', async field => {
    const { repository, mocks, factory } = setup();
    const incomplete: Record<string, string> = { source_type: 'file', parent_id: 'shared-parent', source_revision: 'old-revision' };
    delete incomplete[field];
    await expect(repository.deleteVectors({ scope: incomplete })).rejects.toMatchObject({ code: 'MILVUS_DELETE_SCOPE_INVALID' });
    incomplete[field] = '';
    await expect(repository.deleteVectors({ scope: incomplete })).rejects.toMatchObject({ code: 'MILVUS_DELETE_SCOPE_INVALID' });
    expect(factory).not.toHaveBeenCalled(); expect(mocks.deleteEntities).not.toHaveBeenCalled();
  });

  it('rejects unknown scope fields and reports a failed delete response', async () => {
    const { repository, mocks } = setup();
    await expect(repository.deleteVectors({ scope: { source_type: 'file', parent_id: 'whole', source_revision: 'old', arbitrary_filter: 'all' } })).rejects.toMatchObject({ code: 'MILVUS_DELETE_SCOPE_INVALID' });
    mocks.deleteEntities.mockResolvedValueOnce({ ...mutation(0), status: { ...status, code: 503 } });
    await expect(repository.deleteVectors({ ids: ['one-specific-chunk'] })).rejects.toMatchObject({ code: 'MILVUS_UNAVAILABLE' });
  });
});

describe('Milvus dense, BM25 and hybrid search', () => {
  it('uses identical escaped scopes and independent per-route limits in native hybrid RRF', async () => {
    const { repository, mocks } = setup({ config: { rrfK: 41 } });
    const escapedScope: MilvusSearchScope = { userId: 'user" || true', workspaceId: 'work\\space', versions: [{ documentId: 'doc"1', versionId: 'version\n1', embeddingProfile: 'profile"1', indexBuildId: 'build\\1' }] };
    await repository.hybridSearch([1, 0, 0, 0], '数据库 MVCC Index', { dimensions: DIMENSIONS, limit: 27, scope: escapedScope });
    const request = mocks.hybridSearch.mock.calls[0]![0];
    expect(request).toMatchObject({ collection_name: config.collection, limit: 27, rerank: { strategy: 'rrf', params: { k: 41 } }, consistency_level: ConsistencyLevelEnum.Strong });
    if (!('data' in request) || !Array.isArray(request.data) || typeof request.data[0] !== 'object' || request.data[0] === null || !('anns_field' in request.data[0])) throw new Error('EXPECTED_HYBRID_REQUEST');
    const legs = request.data;
    const filter = milvusScopeFilter(escapedScope);
    expect(legs).toMatchObject([
      { anns_field: 'dense_vector', expr: filter, params: { topk: 20, metric_type: 'COSINE', params: JSON.stringify({ ef: 64 }) } },
      { anns_field: 'sparse_vector', expr: filter, data: '数据库 MVCC Index', params: { topk: 20, metric_type: 'BM25', analyzer_name: 'mixed', params: JSON.stringify({ drop_ratio_search: 0 }) } },
    ]);
    for (const value of ['user" || true', 'work\\space', 'doc"1', 'version\n1', 'profile"1', 'build\\1']) expect(filter).toContain(JSON.stringify(value));
    expect(filter).toContain('index_status == "ready"');
  });

  it('prefilters dense, BM25 and both hybrid legs by authorized ready Note IDs', async () => {
    const { repository, mocks } = setup();
    const noteScope: MilvusSearchScope = { sourceType: 'note', userId: 'user-1', workspaceId: 'workspace-1',
      note: { documentId: 'note-1', embeddingProfile: 'profile-1', chunkIds: ['ready-a', 'ready-"b'] } };
    const filter = 'user_id == "user-1" && workspace_id == "workspace-1" && index_status == "ready" && source_type == "note" && doc_id == "note-1" && embedding_profile == "profile-1" && id in ["ready-a","ready-\\"b"]';
    const options = { limit: 20, dimensions: DIMENSIONS, scope: noteScope };
    await repository.search([1, 0, 0, 0], options);
    await repository.searchKeyword('关系型数据库', options);
    await repository.hybridSearch([1, 0, 0, 0], 'query', options);
    expect(mocks.search.mock.calls.map(([request]) => request)).toMatchObject([{ filter }, { filter }]);
    expect(mocks.hybridSearch.mock.calls[0]?.[0]).toMatchObject({ data: [{ expr: filter }, { expr: filter }] });
    expect(() => milvusScopeFilter({ ...noteScope, note: { ...noteScope.note, chunkIds: [] } })).toThrow(expect.objectContaining({ code: 'MILVUS_SCOPE_REQUIRED' }));
  });

  it('uses both analyzers for an English Note keyword and merges hits within the requested limit', async () => {
    const { repository, mocks } = setup();
    const noteScope: MilvusSearchScope = { sourceType: 'note', userId: 'user-1', workspaceId: 'workspace-1',
      note: { documentId: 'note-1', embeddingProfile: 'profile-1', chunkIds: ['mixed-a', 'english-a', 'english-b'] } };
    const filter = milvusScopeFilter(noteScope);
    const english = { id: 'english-a', score: 0.8, doc_id: 'note-1', index_status: 'ready' };
    const mixed = { ...english, id: 'mixed-a', score: 0.5 };
    mocks.search.mockResolvedValueOnce(results([english, mixed]));
    mocks.search.mockResolvedValueOnce(results([{ ...mixed, score: 0.9 }, { ...mixed, id: 'english-b', score: 0.4 }]));

    const hits = await repository.searchKeyword('granitefable', { scope: noteScope, limit: 2 });

    expect(mocks.search.mock.calls.map(([request]) => request)).toMatchObject([
      { data: 'granitefable', filter, limit: 2, metric_type: 'BM25', params: { analyzer_name: 'en' } },
      { data: 'granitefable', filter: `${filter} && language in ["zh","mixed"]`, limit: 2, metric_type: 'BM25', params: { analyzer_name: 'mixed' } },
    ]);
    expect(hits.map(hit => [hit.chunkKey, hit.score])).toEqual([['mixed-a', 0.9], ['english-a', 0.8]]);
  });

  it('selects query analyzers for raw BM25 text and uses COSINE for dense queries', async () => {
    const { repository, mocks } = setup();
    await repository.searchKeyword('关系型数据库', { scope, limit: 20 });
    await repository.searchKeyword('relational database', { scope, limit: 20 });
    await repository.search([1, 0, 0, 0], { scope, dimensions: DIMENSIONS, limit: 20 });
    expect(mocks.search.mock.calls[0]?.[0]).toMatchObject({ data: '关系型数据库', anns_field: 'sparse_vector', filter: milvusScopeFilter(scope), metric_type: 'BM25', params: { analyzer_name: 'zh', drop_ratio_search: 0 } });
    expect(mocks.search.mock.calls[1]?.[0]).toMatchObject({ params: { analyzer_name: 'en' } });
    expect(mocks.search.mock.calls[2]?.[0]).toMatchObject({ anns_field: 'dense_vector', metric_type: 'COSINE', filter: milvusScopeFilter(scope) });
  });

  it('removes building rows, invalid scores and duplicate physical hits by stable ID', async () => {
    const { repository, mocks } = setup();
    const ready = { id: 'doc-1_c0', score: 0.2, doc_id: 'doc-1', document_version: 'version-1', index_status: 'ready', parent_id: 'version-1', chunk_index: 0, embedding_model: 'test-embedding', embedding_dimensions: DIMENSIONS };
    mocks.search.mockResolvedValueOnce(results([
      ready, { ...ready, score: 0.9 }, { ...ready, index_status: 'building', score: 99 },
      { ...ready, id: 'bad-score', score: Number.NaN }, { ...ready, id: '', score: 1 },
      { ...ready, id: 'doc-1_c1', parent_id: '', score: 0.5 },
    ]));
    const hits = await repository.search([1, 0, 0, 0], { scope, dimensions: DIMENSIONS, limit: 20 });
    expect(hits.map(hit => [hit.chunkKey, hit.score])).toEqual([['doc-1_c0', 0.9], ['doc-1_c1', 0.5]]);
    expect(hits[0]?.parentId).toBe('version-1'); expect(hits[1]?.parentId).toBe('');
  });

  it('rejects missing user, workspace and version scope', () => {
    for (const invalid of [{ ...scope, userId: '' }, { ...scope, workspaceId: '' }, { ...scope, versions: [] }, { ...scope, versions: [{ ...scope.versions[0]!, indexBuildId: '' }] }]) {
      expect(() => milvusScopeFilter(invalid)).toThrow(expect.objectContaining({ code: 'MILVUS_SCOPE_REQUIRED' }));
    }
  });

  it('bounds active requests while handing queued requests their permits', async () => {
    const { repository, mocks } = setup({ config: { searchConcurrency: 2 } });
    const releases: Array<() => void> = []; let active = 0; let peak = 0;
    mocks.search.mockImplementation(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise<void>(resolve => releases.push(resolve)); active -= 1;
      return results();
    });
    const pending = Array.from({ length: 8 }, () => repository.searchKeyword('MVCC', { scope, limit: 20 }));
    await vi.waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(2));
    for (let count = 0; count < 8; count += 1) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0)); releases.shift()!();
    }
    await Promise.all(pending);
    expect(peak).toBe(2); expect(active).toBe(0); expect(mocks.search).toHaveBeenCalledTimes(8);
  });
});
