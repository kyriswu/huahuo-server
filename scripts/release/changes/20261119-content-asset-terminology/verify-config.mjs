import { DEFAULT_CONTENT_ASSET_COLLECTION, loadConfig } from '../../../../dist/config/config.js';

const { APP_ENV, SERVICE_ROLE } = process.env;
if (APP_ENV === 'test' && SERVICE_ROLE !== 'migrate'
  && loadConfig(SERVICE_ROLE).kb.contentAssetCollection !== DEFAULT_CONTENT_ASSET_COLLECTION) {
  process.stderr.write('RELEASE_CONTENT_ASSET_COLLECTION_MISMATCH\n');
  process.exitCode = 1;
}
