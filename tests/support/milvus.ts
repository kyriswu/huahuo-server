import type { AppConfig, Env } from '../../src/config/config.js';

export function configureTestMilvus(config: AppConfig, env: Env = process.env): void {
  if (!env.TEST_MILVUS_ADDRESS) return;
  const database = env.TEST_MILVUS_DATABASE;
  if (!env.TEST_MILVUS_USERNAME || !env.TEST_MILVUS_PASSWORD || !database || !['true', 'false'].includes(env.TEST_MILVUS_TLS ?? '')) throw new Error('TEST_MILVUS_CONFIG_REQUIRED');
  if (env.TEST_MILVUS_MODE === 'cloud' && (!/^huahuo_test_[a-f0-9]{32}$/u.test(database)
    || env.TEST_MILVUS_NOTE_COLLECTION !== database.replace('huahuo_test_', 'huahuo_test_note_')
    || env.TEST_MILVUS_DOCUMENT_COLLECTION !== database.replace('huahuo_test_', 'huahuo_test_document_'))) throw new Error('ISOLATED_CLOUD_MILVUS_REQUIRED');
  Object.assign(config.milvus, {
    address: env.TEST_MILVUS_ADDRESS, username: env.TEST_MILVUS_USERNAME, password: env.TEST_MILVUS_PASSWORD,
    tls: env.TEST_MILVUS_TLS === 'true', database, createIfMissing: true,
  });
  if (env.TEST_MILVUS_NOTE_COLLECTION) config.kb.noteCollection = env.TEST_MILVUS_NOTE_COLLECTION;
  if (env.TEST_MILVUS_DOCUMENT_COLLECTION) config.kb.documentCollection = env.TEST_MILVUS_DOCUMENT_COLLECTION;
}
