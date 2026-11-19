import { DataType } from '@zilliz/milvus2-sdk-node';
import { loadConfig } from '../../../../dist/config/config.js';
import { poolFor } from '../../../../dist/plugins/dependencies.js';
import { createMilvusClient } from '../../../../dist/integrations/search-index/milvus.js';
import { buildMilvusSchema } from '../../../../dist/integrations/search-index/milvus-schema.js';
import { snapshotForSource } from '../../../../dist/modules/kb/profile.js';

const config = loadConfig('api-server');
const pool = poolFor(config);
const client = createMilvusClient(config.milvus);
const check = response => {
  const status = response.status ?? response;
  if (status.error_code !== 'Success' || Number(status.code ?? 0) !== 0) throw new Error('MILVUS_READ_FAILED');
  return response;
};
try {
  if (config.appEnv !== 'test' || config.kb.indexLayout !== 'sparse-v1' || config.rag.rerankProvider !== 'disabled') throw new Error('WRONG_CONFIGURATION');
  // Empty-generation maintenance only. A nonempty target needs an indexed
  // replay that preserves published constructs before the readers move.
  const { rows: [state] } = await pool.query(`SELECT
    EXISTS(SELECT FROM kb_content_asset_hybrid_builds WHERE published) AS assets,
    EXISTS(SELECT FROM kb_document_keyword_builds WHERE published) AS documents,
    EXISTS(SELECT FROM tasks WHERE kind IN ('kb.content-asset-index','kb.content-asset-cleanup','rag.document-ingest','text.ingest')
      AND state NOT IN ('succeeded','failed','cancelled')) AS pending`);
  if (!state || Object.values(state).some(Boolean)) throw new Error('LEGACY_SEARCH_REFERENCES_REMAIN');
  await client.connectPromise;
  for (const source of ['content_asset', 'file']) {
    const { mode, target: { collection: collection_name } } = snapshotForSource(config, source, 'markdown');
    const { schema, collectionID } = check(await client.describeCollection({ collection_name }));
    const expected = buildMilvusSchema(mode, 1024, true);
    if (!/^\d+$/.test(String(collectionID)) || schema.enable_dynamic_field !== false || (schema.functions?.length ?? 0) !== 0
      || schema.fields.length !== expected.length || expected.some((field) => !schema.fields.some((actual) =>
        field.name === actual.name && field.data_type === (typeof actual.data_type === 'string' ? DataType[actual.data_type] : actual.data_type)))) throw new Error('TEXTLESS_SCHEMA_MISMATCH');
    const { index_descriptions: indexes } = check(await client.describeIndex({ collection_name }));
    const actualMetrics = indexes.map((index) => [index.field_name, index.params.find((p) => p.key === 'metric_type')?.value]);
    if (!actualMetrics.some(([field, metric]) => field === 'sparse_vector' && metric === 'IP')
      || mode === 'hybrid' && !actualMetrics.some(([field, metric]) => field === 'dense_vector' && metric === 'COSINE')) throw new Error('TEXTLESS_METRIC_MISMATCH');
  }
} catch {
  console.error('RELEASE_TEXTLESS_EXTERNAL_VERIFICATION_FAILED');
  process.exitCode = 1;
} finally {
  await Promise.all([client.closeConnection(), pool.end()]);
}
