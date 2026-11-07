import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ConsistencyLevelEnum } from '@zilliz/milvus2-sdk-node';
import { loadConfig } from '../dist/config/config.js';
import { createMilvusClient, MilvusRepository } from '../dist/modules/rag/adapters/milvus.js';
import { detectChunkLanguage } from '../dist/modules/rag/adapters/milvus-schema.js';
import { OpenAICompatibleEmbeddingClient } from '../dist/modules/rag/adapters/embedding.js';
import { HttpRerankAdapter } from '../dist/modules/rag/search.js';

// Explicit live test of the configured canonical target. It does not alter
// PostgreSQL, parsing or embedding configuration. Replays use stable IDs.
const config = loadConfig('worker');
const target = 'huahuo_chunks';
assert.equal(config.milvus.collection, target, 'CANONICAL_MILVUS_TARGET_REQUIRED');
const options = { ...config.milvus, collection: target, createIfMissing: true };
const client = createMilvusClient(options);
const repository = new MilvusRepository(options, () => client);
const schemaOnly = process.argv.includes('--schema-only');
const report = { collection: target, sdk: '2.6.17', complete: false, embedding: schemaOnly ? 'not requested' : 'real configured provider', stages: [] };
const ok = response => {
  const s = response.status ?? response;
  assert.ok(['Success', '0'].includes(String(s.error_code ?? 'Success')) && Number(s.code ?? 0) === 0, `MILVUS_STATUS:${s.error_code}:${s.code ?? 0}`);
  return response;
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
const userId = '__huahuo_smoke__';
const workspaceId = '__huahuo_smoke_workspace__';
const documentId = 'milvus-smoke';
const versionId = documentId;
const build = 'milvus-smoke';
const scope = { userId, workspaceId, versions: [{ documentId, versionId, embeddingProfile: config.rag.embeddingProfile, indexBuildId: build }] };
const samples = [
  'PostgreSQL 是一个关系型数据库，支持 MVCC 和 B-tree 索引。',
  'PostgreSQL is a relational database supporting MVCC and B-tree indexes.',
  'PostgreSQL 数据库支持 MVCC，使用 B-tree Index 优化查询性能。',
];
const queries = [
  { kind: 'zh', query: '数据库并发控制和索引', keywordRequired: true },
  { kind: 'en', query: 'relational database MVCC', keywordRequired: true },
  { kind: 'mixed', query: '数据库 MVCC B-tree Index', keywordRequired: true },
  { kind: 'technical', query: 'MVCC', keywordRequired: true },
  { kind: 'semantic', query: 'How can simultaneous transactions see consistent records while speeding up lookups?', keywordRequired: false },
];
let stage = 'connect';
try {
  await repository.connect();
  const version = ok(await client.getVersion()); report.serverVersion = version.version;
  stage = 'create-schema-indexes';
  await repository.ensureReady(config.rag.embeddingDimensions);
  // A fresh repository exercises the already-exists branch (not just a promise cache).
  const repeated = new MilvusRepository(options);
  try { await repeated.ensureReady(config.rag.embeddingDimensions); } finally { await repeated.close(); }
  const description = ok(await client.describeCollection({ collection_name: target }));
  const indexes = ok(await client.describeIndex({ collection_name: target }));
  report.schema = description.schema;
  report.indexes = indexes.index_descriptions;
  report.stages.push(stage);
  stage = 'tokenization';
  report.tokenization = [];
  for (const text of [...samples, '12345']) {
    const language = detectChunkLanguage(text);
    const result = ok(await client.runAnalyzer({ collection_name: target, field_name: 'text', text: [text], analyzer_names: [language] }));
    const tokens = result.results[0]?.tokens.map(token => token.token) ?? [];
    assert.ok(tokens.length > 0, 'EMPTY_TOKENIZATION');
    if (text.includes('MVCC')) assert.ok(tokens.includes('mvcc'), 'TECHNICAL_TERM_NORMALIZATION');
    report.tokenization.push({ language, tokens });
  }
  assert.deepEqual(samples.map(detectChunkLanguage), ['zh', 'en', 'mixed']);
  report.stages.push(stage);
  if (!schemaOnly) {
    stage = 'embedding';
    assert.equal(config.rag.embeddingModel, 'Qwen/Qwen3-Embedding-8B', 'EXPECTED_CURRENT_MODEL');
    assert.equal(config.rag.embeddingDimensions, 4096, 'EXPECTED_CURRENT_DIMENSIONS');
    const embedding = new OpenAICompatibleEmbeddingClient({ baseUrl: config.rag.embeddingBaseUrl, apiKey: config.rag.embeddingApiKey, model: config.rag.embeddingModel, dimensions: config.rag.embeddingDimensions, sendDimensions: config.rag.embeddingSendDimensions, timeoutMs: config.rag.embeddingTimeoutMs, maxRetries: config.rag.embeddingMaxRetries });
    const vectors = await embedding.embed([...samples, ...queries.map(q => q.query)]);
    report.model = embedding.model; report.dimensions = vectors[0].length;
    report.stages.push(stage);
    stage = 'upsert';
    const input = samples.map((content, ordinal) => ({
      chunk: { id: `${documentId}_c${ordinal}`, chunkKey: `${documentId}_c${ordinal}`, ordinal, parentId: versionId, sourceType: 'file', sourceRevision: versionId, content, embeddingText: content, contentHash: sha256(content), embeddingTextHash: sha256(content), headingPath: [], tokenCount: 0, metadata: {} },
      embedding: vectors[ordinal], documentId, documentVersion: versionId, state: 'ready', model: embedding.model, dimensions: embedding.dimensions, userId, workspaceId, embeddingProfile: config.rag.embeddingProfile, indexBuildId: build,
    }));
    await repository.upsert(input);
    await repository.upsert(input);
    // Sentinels exercise server-side user and state filters, not just result post-filtering.
    await repository.upsert([
      { ...input[0], state: 'building', chunk: { ...input[0].chunk, chunkKey: `${documentId}_building` } },
      { ...input[0], userId: '__huahuo_smoke_other__', documentId: `${documentId}-other`, chunk: { ...input[0].chunk, chunkKey: `${documentId}_other` } },
    ]);
    const read = ok(await client.query({ collection_name: target, filter: `doc_id == "${documentId}" && index_status == "ready"`, output_fields: ['id', 'text', 'language', 'dense_vector'], consistency_level: ConsistencyLevelEnum.Strong }));
    assert.equal(read.data.length, 3);
    for (const row of read.data) {
      assert.equal(row.dense_vector.length, 4096);
      assert.ok(row.dense_vector.every(Number.isFinite));
      assert.equal(row.language, detectChunkLanguage(row.text));
    }
    report.readyFixtureCount = 3; report.sentinelCount = 2;
    report.sparseGenerated = 'Verified by BM25 Function/index and raw text recall; BM25 output vectors cannot be returned by Milvus.';
    report.stages.push(stage);
    stage = 'retrieval'; report.searches = [];
    let rerankCandidates = [];
    const keys = new Set(input.map(row => row.chunk.chunkKey));
    for (const [index, item] of queries.entries()) {
      const vector = vectors[index + samples.length];
      const dense = await repository.search(vector, { limit: config.milvus.denseCandidates, dimensions: embedding.dimensions, scope });
      const keyword = await repository.searchKeyword(item.query, { limit: config.milvus.bm25Candidates, scope });
      const hybrid = await repository.hybridSearch(vector, item.query, { limit: config.milvus.hybridCandidates, dimensions: embedding.dimensions, scope });
      assert.ok(dense.length > 0 && hybrid.length > 0, 'DENSE_HYBRID_EMPTY');
      if (item.keywordRequired) assert.ok(keyword.length > 0, 'KEYWORD_EMPTY');
      for (const hits of [dense, keyword, hybrid]) {
        assert.equal(new Set(hits.map(hit => hit.chunkKey)).size, hits.length);
        assert.ok(hits.every(hit => keys.has(hit.chunkKey) && hit.state === 'ready'), 'SCOPE_LEAK');
      }
      if (index === 0) rerankCandidates = hybrid.map(hit => {
        const row = input.find(candidate => candidate.chunk.chunkKey === hit.chunkKey);
        assert.ok(row, 'RERANK_FIXTURE_NOT_FOUND');
        return { chunkKey: hit.chunkKey, documentKey: documentId, parentChunkKey: null, content: row.chunk.content, chunkIndex: row.chunk.ordinal, chunkCount: input.length, denseScore: 0, keywordScore: 0, rrfScore: hit.score };
      });
      report.searches.push({ kind: item.kind, dense: dense.map(hit => ({ id: hit.chunkKey, score: hit.score })), keyword: keyword.map(hit => ({ id: hit.chunkKey, score: hit.score })), hybrid: hybrid.map(hit => ({ id: hit.chunkKey, score: hit.score })) });
    }
    const emptyScope = { ...scope, userId: '__no_matching_smoke_user__' };
    assert.equal((await repository.searchKeyword('MVCC', { limit: 20, scope: emptyScope })).length, 0);
    assert.equal((await repository.hybridSearch(vectors[0], 'MVCC', { limit: 30, dimensions: 4096, scope: emptyScope })).length, 0);
    report.stages.push(stage);
    stage = 'reranker';
    if (config.rag.rerankProvider === 'http') {
      const reranker = new HttpRerankAdapter({ baseUrl: config.rag.rerankBaseUrl, apiKey: config.rag.rerankApiKey, model: config.rag.rerankModel, timeoutMs: config.rag.rerankTimeoutMs });
      const ranked = await reranker.rerank(queries[0].query, rerankCandidates);
      assert.equal(ranked.length, 3); assert.ok(ranked.every(row => Number.isFinite(row.rerankScore)));
      report.reranker = { provider: 'real HTTP', model: config.rag.rerankModel, count: ranked.length, input: 'native Milvus Hybrid candidates and scores; public fixture text; PostgreSQL hydration verified separately by service tests' };
      report.stages.push(stage);
    } else report.reranker = { provider: 'not configured; not tested live' };
  }
  report.complete = true;
} catch (error) {
  report.failedStage = stage;
  report.errorCode = error.code ?? error.name;
  // No transport URL, API key, raw provider error or vectors in diagnostics.
  report.causeCode = error.cause?.code;
  process.exitCode = 1;
} finally {
  await repository.close();
  mkdirSync('.local', { recursive: true });
  writeFileSync('.local/milvus-live-verification.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
