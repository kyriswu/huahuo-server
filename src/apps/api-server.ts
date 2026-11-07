import { TextIngestionService } from '../modules/text-ingestion/service.js';
import { registerTextIngestionRoutes } from '../modules/text-ingestion/routes.js';
import { registerTaskRoutes } from '../modules/tasks/routes.js';
import { TaskService } from '../modules/tasks/service.js';
import { createDependencies, poolFor } from '../plugins/dependencies.js';
import { buildBase, type BuildOptions } from './base.js';
import { IdentityService, type IdentityOptions } from '../modules/identity/service.js';
import { WorkspaceService } from '../modules/workspaces/service.js';
import { registerIdentityRoutes } from '../modules/identity/routes.js';
import { BillingService } from '../modules/billing/service.js';
import { registerBillingRoutes } from '../modules/billing/routes.js';
import { StorageService } from '../modules/storage/service.js';
import { registerAssetRoutes } from '../modules/assets/routes.js';
import { AssetService } from '../modules/assets/service.js';
import { registerStorageRoutes } from '../modules/storage/routes.js';
import { registerIngestionRoutes } from '../modules/ingestion/routes.js';
import { DocumentIngestionService } from '../modules/ingestion/service.js';
import { registerRagRoutes } from '../modules/rag/routes.js';
import { RagIngestionRepository } from '../modules/rag/repository.js';
import { RagQueryService, type RagQueryDependencies } from '../modules/rag/query-service.js';
export async function buildApiServer(options: BuildOptions & IdentityOptions & { ragQueryDependencies?: Omit<RagQueryDependencies, 'resolveAssets'> }) {
 if(options.config.role!=='api-server')throw new Error('INVALID_API_ROLE');
 const dependencies=options.dependencies??createDependencies(options.config);
 const pool=dependencies.pool??poolFor(options.config);
 const app=await buildBase({...options,dependencies});
 if(!dependencies.pool)app.addHook('onClose',async()=>{await pool.end();});
 const identity=new IdentityService(pool,options.config,options);
 registerIdentityRoutes(app,identity,new WorkspaceService(pool,options.config.appTokenSecret!));
 const billing=new BillingService(pool,options.config);
 if (options.config.billingMode !== 'disabled') registerBillingRoutes(app,identity,billing);
 const storageService = new StorageService(pool,options.config);
 registerStorageRoutes(app,identity,storageService);
 registerAssetRoutes(app,identity,new AssetService(pool,options.config.appTokenSecret!,options.config));
 registerIngestionRoutes(app,identity,new DocumentIngestionService(pool,options.config.appTokenSecret!,options.config));
 const textIngestion=new TextIngestionService(pool,options.config);
 registerTextIngestionRoutes(app,identity,textIngestion);
 const ragQuery = new RagQueryService(pool,options.config,{
  ...options.ragQueryDependencies,
  resolveTextAssets: (content,id,scope)=>textIngestion.renderAssets(scope,id,content,storageService.storage),
  resolveAssets: async (content, versionId, scope) => {
   const assets = await pool.query<{asset_ref:string;object_key:string}>('SELECT a.asset_ref,a.object_key FROM rag_document_assets a JOIN rag_ingestion_versions v ON v.id=a.version_id WHERE a.version_id=$1 AND v.user_id=$2 AND v.workspace_id=(SELECT id FROM workspaces WHERE user_id=$2 AND is_default AND state=\'ready\')',[versionId,scope.userId]);
   let resolved = content;
   for (const asset of assets.rows) {
    const signed = storageService.storage.signUrl ? await storageService.storage.signUrl(asset.object_key, 900) : asset.asset_ref;
    resolved = resolved.replaceAll(asset.asset_ref, signed);
   }
   return resolved;
  },
 });
 app.addHook('onClose',async()=>{await ragQuery.close();});
 registerRagRoutes(app,identity,new RagIngestionRepository(pool,options.config.rag,options.config.appEnv,options.config.milvus.collection,options.config),storageService.storage,ragQuery);
 registerTaskRoutes(app,identity,new TaskService(pool,options.config.appTokenSecret!,options.config.billingMode === 'disabled' ? undefined : billing),options.config.demoTasks);return app;
}
