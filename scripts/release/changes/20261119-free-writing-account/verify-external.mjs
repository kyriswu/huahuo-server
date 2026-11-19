import { DataType } from '@zilliz/milvus2-sdk-node';
import { loadConfig } from '../../../../dist/config/config.js';
import { createMilvusClient } from '../../../../dist/integrations/search-index/milvus.js';
import { buildMilvusSchema } from '../../../../dist/integrations/search-index/milvus-schema.js';
import { snapshotForSource } from '../../../../dist/modules/kb/profile.js';

const config = loadConfig('api-server');
const { mode, target, indexLayout, embedding } = snapshotForSource(config, 'content_asset', 'markdown');
const sparse = indexLayout === 'sparse-v1';
const dimensions = embedding.dimensions;
const client = createMilvusClient(config.milvus);
const request = { collection_name: target.collection };
const typeId = value => typeof value === 'string' ? DataType[value] : value;

try {
  await client.connectPromise;
  const { status, schema } = await client.describeCollection(request);
  const expected = buildMilvusSchema(mode, dimensions, sparse, true);
  if (status.error_code !== 'Success' || !schema || schema.enable_dynamic_field !== false || schema.fields.length !== expected.length
      || expected.some(field => !schema.fields.some(actual => actual.name === field.name && typeId(actual.data_type) === typeId(field.data_type)))) {
    throw new Error('ACCOUNT_ASSET_COLLECTION_REQUIRED');
  }
  const dense = schema.fields.find(field => field.name === 'dense_vector');
  if (Number(dense.type_params?.find(param => param.key === 'dim')?.value ?? dense.dim) !== dimensions) {
    throw new Error('ACCOUNT_ASSET_COLLECTION_DIMENSIONS_MISMATCH');
  }
  const indexes = await client.describeIndex(request);
  const hasIndex = (field, metric) => indexes.index_descriptions.some(index =>
    index.field_name === field && index.params.some(param => param.key === 'metric_type' && param.value === metric));
  if (indexes.status.error_code !== 'Success' || !hasIndex('dense_vector', 'COSINE') || !hasIndex('sparse_vector', sparse ? 'IP' : 'BM25')) {
    throw new Error('ACCOUNT_ASSET_COLLECTION_INDEX_REQUIRED');
  }
} catch {
  process.stderr.write('ACCOUNT_ASSET_COLLECTION_VERIFICATION_FAILED\n');
  process.exitCode = 1;
} finally {
  await client.closeConnection();
}
