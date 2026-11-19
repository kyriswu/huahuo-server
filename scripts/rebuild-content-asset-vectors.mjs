import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { DataType } from '@zilliz/milvus2-sdk-node';

const fail = code => { throw new Error(code); };
function checked(response) {
  const status = response?.status ?? response;
  if (status?.error_code !== undefined && status.error_code !== 'Success'
    || status?.code !== undefined && Number(status.code) !== 0) fail('CONTENT_ASSET_REBUILD_MILVUS_FAILED');
  return response;
}
const denseTypes = new Set([DataType.FloatVector, DataType.Float16Vector, DataType.BFloat16Vector,
  DataType.BinaryVector, DataType.Int8Vector, 'FloatVector', 'Float16Vector', 'BFloat16Vector', 'BinaryVector', 'Int8Vector']);

/** Explicit one-off operation for an empty derived content asset index, never startup or
 * deployment automation. No record exports, SQL mutations or database drops. */
export async function rebuildContentAssetVectors({ config, client, pool, createIndex, expectedId, discard = false }) {
  if (!['development', 'test'].includes(config.appEnv) || config.kb.contentAssetCollection === config.kb.documentCollection) fail('CONTENT_ASSET_REBUILD_TARGET_DENIED');
  const collection_name = config.kb.contentAssetCollection;
  const description = checked(await client.describeCollection({ collection_name }));
  if (!description.schema.fields.some(field => denseTypes.has(field.data_type))) fail('CONTENT_ASSET_REBUILD_DENSE_REQUIRED');
  const id = String(description.collectionID);
  if (!/^\d+$/.test(id)) fail('CONTENT_ASSET_REBUILD_ID_REQUIRED');
  // Published PG metadata may not keep claiming removed points are ready.
  // Non-empty installations need a separately reviewed reindex plan.
  const metadata = (await pool.query(`SELECT
    (SELECT count(*)::int FROM kb_content_asset_hybrid_builds) AS builds,
    (SELECT count(*)::int FROM kb_content_asset_hybrid_chunks) AS chunks,
    (SELECT count(*)::int FROM tasks WHERE (kind LIKE '%index%' OR kind LIKE 'kb.%')
      AND state NOT IN ('succeeded','failed','cancelled')) AS active_tasks`)).rows[0];
  if (!metadata || Object.values(metadata).some(value => Number(value) !== 0)) fail('CONTENT_ASSET_REBUILD_REINDEX_PLAN_REQUIRED');
  const points = checked(await client.query({ collection_name, output_fields: ['count(*)'], consistency_level: 'Strong' }));
  const logicalRows = Number(points.data?.[0]?.['count(*)']);
  if (!Number.isSafeInteger(logicalRows) || logicalRows < 0) fail('CONTENT_ASSET_REBUILD_COUNT_REQUIRED');
  const report = { database: config.milvus.database, collection: collection_name, oldId: id, logicalRows, metadata, backups: 0, modelCalls: 0, applied: false };
  if (!discard) return report;
  if (!expectedId || String(expectedId) !== id) fail('CONTENT_ASSET_REBUILD_ID_MISMATCH');
  // Recheck identity immediately before the destructive operation.
  if (String(checked(await client.describeCollection({ collection_name })).collectionID) !== id) fail('CONTENT_ASSET_REBUILD_ID_MISMATCH');
  checked(await client.dropCollection({ collection_name }));
  report.applied = true;
  const index = createIndex();
  try { await index.ensureReady(); } finally { await index.close(); }
  const rebuilt = checked(await client.describeCollection({ collection_name }));
  const dense = rebuilt.schema.fields.find(field => field.name === 'dense_vector');
  const dimensions = dense?.type_params?.find(param => param.key === 'dim')?.value ?? dense?.dim;
  if (!dense || ![DataType.Float16Vector, 'Float16Vector'].includes(dense.data_type) || Number(dimensions) !== 1024 || String(rebuilt.collectionID) === id) fail('CONTENT_ASSET_REBUILD_VERIFY_FAILED');
  report.newId = String(rebuilt.collectionID);
  report.dimensions = 1024;
  report.storage = 'Float16Vector';
  const remaining = checked(await client.query({ collection_name, output_fields: ['count(*)'], consistency_level: 'Strong' }));
  report.newLogicalRows = Number(remaining.data?.[0]?.['count(*)']);
  if (report.newLogicalRows !== 0) fail('CONTENT_ASSET_REBUILD_VERIFY_FAILED');
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { loadConfig } = await import('../dist/config/config.js');
  const { poolFor } = await import('../dist/plugins/dependencies.js');
  const { createMilvusClient, createMilvusHybridIndex } = await import('../dist/integrations/search-index/milvus.js');
  const config = loadConfig('migrate'), pool = poolFor(config), client = createMilvusClient(config.milvus);
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--discard-without-backup', '--expected-id'].includes(arg) && !/^\d+$/.test(arg))) fail('CONTENT_ASSET_REBUILD_ARGUMENT_INVALID');
    await client.connectPromise;
    const report = await rebuildContentAssetVectors({ config, client, pool,
      expectedId: args.includes('--expected-id') ? args[args.indexOf('--expected-id') + 1] : undefined,
      discard: args.includes('--discard-without-backup'),
      createIndex: () => createMilvusHybridIndex({ ...config.milvus, collection: config.kb.contentAssetCollection, maxContentChars: 500, dimensions: 1024, createIfMissing: true }),
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    const code = /^CONTENT_ASSET_REBUILD_[A-Z_]+$/.test(error.message) ? error.message : 'CONTENT_ASSET_REBUILD_FAILED';
    console.error(JSON.stringify({ code })); process.exitCode = 1;
  } finally { await client.closeConnection(); await pool.end(); }
}
