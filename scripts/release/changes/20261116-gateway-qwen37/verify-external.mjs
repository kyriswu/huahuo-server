import { DataType } from '@zilliz/milvus2-sdk-node';
import { loadConfig } from '../../../../dist/config/config.js';
import { createMilvusClient } from '../../../../dist/integrations/search-index/milvus.js';

// Bounded read-only schema check. Never ensureReady/create/drop, read documents,
// generate embeddings, rerank, or start a historical reindex from a release.
const config = loadConfig('api-server'), client = createMilvusClient(config.milvus);
const checked = response => {
  if (response.status?.error_code !== 'Success') throw new Error('QWEN_MILVUS_READ_FAILED');
  return response;
};
try {
  await client.connectPromise;
  const contentAsset = checked(await client.describeCollection({ collection_name: config.kb.contentAssetCollection }));
  const dense = contentAsset.schema.fields.find(field => field.name === 'dense_vector');
  if (!dense || !['Float16Vector', DataType.Float16Vector].includes(dense.data_type)
    || Number(dense.type_params.find(parameter => parameter.key === 'dim')?.value) !== 1024) throw new Error('QWEN_MILVUS_SCHEMA_REQUIRED');
  const indexes = checked(await client.describeIndex({ collection_name: config.kb.contentAssetCollection })).index_descriptions;
  if (!indexes.some(index => index.field_name === 'dense_vector' && index.index_name === 'huahuo_dense_hnsw' && index.state === 'Finished')
    || !indexes.some(index => index.field_name === 'sparse_vector' && index.index_name === 'huahuo_sparse_bm25' && index.state === 'Finished')) throw new Error('QWEN_MILVUS_INDEX_REQUIRED');
  const document = checked(await client.describeCollection({ collection_name: config.kb.documentCollection }));
  if (document.schema.fields.some(field => field.name === 'dense_vector')) throw new Error('QWEN_KEYWORD_SCHEMA_INVALID');
  console.log(JSON.stringify({ check: 'qwen-milvus-fp16-1024', ok: true, modelCalls: 0 }));
} catch { process.stderr.write('QWEN_MILVUS_VERIFICATION_FAILED\n'); process.exitCode = 1; }
finally { await client.closeConnection(); }
