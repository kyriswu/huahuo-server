import { parseArgs } from 'node:util';
import { ConsistencyLevelEnum } from '@zilliz/milvus2-sdk-node';
import { loadConfig } from '../dist/config/config.js';
import { poolFor } from '../dist/plugins/dependencies.js';
import { createMilvusClient } from '../dist/modules/rag/adapters/milvus.js';

// Read-only audit. Run pnpm build first; use the same configuration and TLS
// implementation as the application. No collection creation, flush or repair.
const BATCH_SIZE = 1000;
const MAX_SCAN_ROWS = 1_000_000;
const OUTPUT_FIELDS = ['id', 'doc_id', 'document_version', 'embedding_profile', 'index_build_id', 'index_status'];

function ensureSuccess(response, operation) {
  const status = response?.status ?? response;
  if (!['Success', '0'].includes(String(status?.error_code ?? 'Success')) || Number(status?.code ?? 0) !== 0) throw new Error(`CONSISTENCY_QUERY_FAILED:${operation}`);
}

function tuple(row) {
  const values = [row.id, row.doc_id, row.document_version, row.embedding_profile, row.index_build_id];
  if (values.some(value => typeof value !== 'string' || !value)) throw new Error('CONSISTENCY_ROW_INVALID');
  return JSON.stringify(values);
}

async function run() {
  const { values } = parseArgs({ options: { 'user-id': { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) {
    console.log('Usage: node --env-file=.env scripts/rag-consistency.mjs [--user-id <UUID>]');
    console.log('Default: audit every ready/building row in the configured Collection and Embedding profile. Index-only fixtures are reported, never silently excluded. --user-id scopes both PostgreSQL and Milvus. Physical count always describes the entire Collection. Read-only, no paid model requests.');
    return;
  }
  const userId = values['user-id'];
  if (userId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(userId)) throw new Error('CONSISTENCY_USER_ID_INVALID');
  const config = loadConfig('migrate', { ...process.env, SERVICE_ROLE: 'migrate', DATABASE_POOL_MAX: '2' });
  if (!config.milvus.address || !config.milvus.username || !config.milvus.password) throw new Error('MILVUS_CONFIG_INVALID');
  const pool = poolFor(config);
  let milvus;
  try {
    milvus = createMilvusClient(config.milvus);
    await milvus.connectPromise;
    const pgReady = await pool.query(`
      SELECT c.chunk_key AS id,c.document_key AS doc_id,c.version_id::text AS document_version,
             c.embedding_profile,c.index_build_id
        FROM rag_child_chunks c
        JOIN rag_ingestion_versions v ON v.id=c.version_id
       WHERE v.milvus_collection=$1 AND v.embedding_model=$2 AND v.embedding_dimension=$3
         AND v.embedding_profile=$4 AND v.active=true AND v.status='SUCCEEDED'
         AND v.embedding_status='ready' AND v.index_status='ready'
         AND c.embedding_status='ready' AND c.index_status='ready'
         AND c.document_key=v.document_key AND c.embedding_profile=v.embedding_profile
         AND c.index_build_id=v.index_build_id AND c.embedding_model=v.embedding_model
         AND c.embedding_dimension=v.embedding_dimension
         AND ($5::uuid IS NULL OR v.user_id=$5::uuid)
       ORDER BY c.chunk_key`, [config.milvus.collection, config.rag.embeddingModel, config.rag.embeddingDimensions, config.rag.embeddingProfile, userId ?? null]);
    const pgByKey = new Map(pgReady.rows.map(row => [row.id, tuple(row)]));
    if (pgByKey.size !== pgReady.rows.length) throw new Error('POSTGRES_DUPLICATE_CHUNK_KEY');

    const commonFilter = `embedding_model == ${JSON.stringify(config.rag.embeddingModel)} && embedding_dimensions == ${config.rag.embeddingDimensions} && embedding_profile == ${JSON.stringify(config.rag.embeddingProfile)}${userId ? ` && user_id == ${JSON.stringify(userId)}` : ''}`;
    const scan = async (state, consume) => {
      const filter = `${commonFilter} && index_status == ${JSON.stringify(state)}`;
      // SDK 2.6.17 paginates by primary key. No 16,384-row truncation or large
      // offset query. Only IDs/filter metadata are retained, never vectors/text.
      const iterator = await milvus.queryIterator({ collection_name: config.milvus.collection, filter, output_fields: OUTPUT_FIELDS, batchSize: BATCH_SIZE, consistency_level: ConsistencyLevelEnum.Strong });
      let scanned = 0;
      for await (const batch of iterator) {
        // A changing collection or an SDK count/query discrepancy can produce
        // empty batches without advancing its iterator. Fail instead of hanging.
        if (!Array.isArray(batch) || !batch.length) throw new Error('CONSISTENCY_SCAN_INCOMPLETE');
        scanned += batch.length;
        if (scanned > MAX_SCAN_ROWS) throw new Error('CONSISTENCY_SCAN_LIMIT_EXCEEDED');
        for (const row of batch) {
          if (row.index_status !== state) throw new Error('CONSISTENCY_ROW_STATE_INVALID');
          consume(row);
        }
      }
      const count = await milvus.query({ collection_name: config.milvus.collection, filter, output_fields: ['count(*)'], consistency_level: ConsistencyLevelEnum.Strong });
      ensureSuccess(count, 'count');
      if (Number(count.data?.[0]?.['count(*)']) !== scanned) throw new Error('CONSISTENCY_SCAN_CHANGED');
      return scanned;
    };
    const readyByKey = new Map();
    let tupleMismatchCount = 0;
    const readyRows = await scan('ready', row => {
      const key = row.id;
      const value = tuple(row);
      const tuples = readyByKey.get(key) ?? new Set();
      tuples.add(value); readyByKey.set(key, tuples);
      if (pgByKey.has(key) && pgByKey.get(key) !== value) tupleMismatchCount += 1;
    });
    const buildingRows = await scan('building', () => undefined);
    const physical = await milvus.getCollectionStatistics({ collection_name: config.milvus.collection });
    ensureSuccess(physical, 'statistics');
    const physicalCount = Number(physical.data?.row_count ?? physical.stats?.find(entry => entry.key === 'row_count')?.value);
    if (!Number.isFinite(physicalCount)) throw new Error('CONSISTENCY_STATS_INVALID');
    const activeBuilds = [...new Set(pgReady.rows.map(row => row.index_build_id))].sort();
    console.log(JSON.stringify({
      postgres_ready_count: pgByKey.size,
      milvus_ready_unique_count: readyByKey.size,
      milvus_building_count: buildingRows,
      milvus_physical_count: physicalCount,
      duplicate_logical_count: readyRows - readyByKey.size,
      missing_in_milvus_count: [...pgByKey].filter(([key, value]) => !readyByKey.get(key)?.has(value)).length,
      missing_in_postgres_count: [...readyByKey].filter(([key, tuples]) => !tuples.has(pgByKey.get(key))).length,
      index_tuple_mismatch_count: tupleMismatchCount,
      active_index_build_id: activeBuilds.length === 1 ? activeBuilds[0] : null,
      active_index_build_ids: activeBuilds,
      active_embedding_profile: config.rag.embeddingProfile,
      scope: { collection: config.milvus.collection, user_id: userId ?? null, embedding_model: config.rag.embeddingModel, embedding_dimensions: config.rag.embeddingDimensions, includes_index_only_rows: true },
      scan_complete: true,
      scan_batch_size: BATCH_SIZE,
      scan_row_limit: MAX_SCAN_ROWS,
      physical_count_scope: 'entire_collection',
      snapshot_note: 'Independent read snapshots; run against a quiescent index for migration acceptance.',
    }, null, 2));
  } finally {
    await Promise.allSettled([pool.end(), milvus?.closeConnection()]);
  }
}

try { await run(); }
catch (error) {
  const code = error instanceof Error && /^(CONSISTENCY_|POSTGRES_DUPLICATE_|MILVUS_CONFIG_|INVALID_CONFIG:)/u.test(error.message) ? error.message : 'MILVUS_CONSISTENCY_UNAVAILABLE';
  // Driver/SDK errors may contain connection details; never log their messages.
  console.error(JSON.stringify({ error_code: code }));
  process.exitCode = 2;
}
