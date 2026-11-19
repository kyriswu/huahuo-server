import { DEFAULT_CONTENT_ASSET_COLLECTION, loadConfig } from '../../../../dist/config/config.js';
import { createMilvusClient } from '../../../../dist/integrations/search-index/milvus.js';

const config = loadConfig('api-server');
const client = createMilvusClient(config.milvus);
const target = config.kb.contentAssetCollection;
try {
  await client.connectPromise;
  const result = await client.describeCollection({ collection_name: target });
  if (result.status?.error_code !== 'Success' || result.collection_name !== target || !result.collectionID) {
    throw new Error('CONTENT_ASSET_COLLECTION_MISSING');
  }
  if (target === DEFAULT_CONTENT_ASSET_COLLECTION) {
    const previous = await client.hasCollection({ collection_name: 'huahuo_kb_note_hybrid_chunks' });
    if (previous.status?.error_code !== 'Success' || previous.value) {
      throw new Error('CONTENT_ASSET_COLLECTION_RENAME_INCOMPLETE');
    }
  }
} catch {
  process.stderr.write('CONTENT_ASSET_MILVUS_VERIFICATION_FAILED\n');
  process.exitCode = 1;
} finally {
  await client.closeConnection();
}
