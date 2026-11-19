import { DataType } from '@zilliz/milvus2-sdk-node';
import { loadConfig } from '../../../../dist/config/config.js';
import { createMilvusClient } from '../../../../dist/integrations/search-index/milvus.js';
import { buildMilvusAssetSchema } from '../../../../dist/integrations/search-index/milvus-schema.js';
import { snapshotForSource } from '../../../../dist/modules/kb/profile.js';

const config = loadConfig('api-server');
const client = createMilvusClient(config.milvus);
try {
  await client.connectPromise;
  const { collection: collection_name } = snapshotForSource(config, 'content_asset', 'markdown').target;
  const { schema, status } = await client.describeCollection({ collection_name });
  const expected = buildMilvusAssetSchema(1024);
  if (status.error_code !== 'Success' || schema.enable_dynamic_field || schema.functions?.length
    || schema.fields.length !== expected.length
    || !expected.every(field => schema.fields.some(actual => actual.name === field.name
      && (typeof actual.data_type === 'string' ? DataType[actual.data_type] : actual.data_type) === field.data_type
      && (!field.is_primary_key || (actual.is_primary_key && !actual.autoID))
      && (!field.dim || Number(actual.type_params?.find(param => param.key === 'dim')?.value) === field.dim)))) {
    throw new Error('MILVUS_ASSET_SCHEMA_INVALID');
  }
  const indexes = await client.describeIndex({ collection_name });
  if (indexes.status.error_code !== 'Success' || ![['dense_vector','COSINE'],['sparse_vector','IP']].every(([field, metric]) =>
    indexes.index_descriptions.some(index => index.field_name === field && index.state !== 'Failed'
      && index.params.some(param => param.key === 'metric_type' && param.value === metric)))) throw new Error('MILVUS_ASSET_INDEX_INVALID');
} catch {
  console.error('RELEASE_MILVUS_ASSET_VERIFICATION_FAILED');
  process.exitCode = 1;
} finally {
  await client.closeConnection();
}
