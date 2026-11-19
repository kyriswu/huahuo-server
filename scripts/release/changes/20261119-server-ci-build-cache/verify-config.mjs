import { loadConfig } from '../../../../dist/config/config.js';

const { SERVICE_ROLE, APP_ENV, KB_CONTENT_ASSET_HYBRID_COLLECTION, KB_NOTE_HYBRID_COLLECTION } = process.env;
if (APP_ENV === 'test' && SERVICE_ROLE !== 'migrate') {
  const collection = 'huahuo_kb_note_hybrid_chunks';
  if (KB_NOTE_HYBRID_COLLECTION !== undefined || KB_CONTENT_ASSET_HYBRID_COLLECTION !== collection
    || loadConfig(SERVICE_ROLE).kb.contentAssetCollection !== collection) {
    process.stderr.write('RELEASE_CONTENT_ASSET_COLLECTION_MISMATCH\n');
    process.exitCode = 1;
  }
}
