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
import { NoteIndexService } from '../modules/ingestion/service.js';
import { registerRagRoutes } from '../modules/rag/routes.js';
import { RagIngestionRepository } from '../modules/rag/repository.js';
import { RagQueryService, type RagQueryDependencies } from '../modules/rag/query-service.js';
import { RagImageLinks } from '../modules/rag/image-links.js';
import {RuntimeSettings} from '../modules/runtime-settings/service.js';
import {DocumentCallbacks} from '../modules/ingestion/document-callbacks.js';
import {registerDocumentCallbacks} from '../modules/ingestion/document-callback-routes.js';
export async function buildApiServer(options: BuildOptions & IdentityOptions & { ragQueryDependencies?: Omit<RagQueryDependencies, 'resolveImages'> }) {
 if(options.config.role!=='api-server')throw new Error('INVALID_API_ROLE');
 const dependencies=options.dependencies??createDependencies(options.config);
 const pool=dependencies.pool??poolFor(options.config);
 const app=await buildBase({...options,dependencies});
 const settings=new RuntimeSettings(pool,options.config);
 app.addHook('onRequest',(req,_reply,done)=>{const path=req.routeOptions.url;if(path?.startsWith('/api/v1/')&&!path.startsWith('/api/v1/auth/')&&!path.startsWith('/api/v1/document-parser/callbacks/'))void settings.enter(done);else done();});
 const callbacks=new DocumentCallbacks(pool,options.config);registerDocumentCallbacks(app,callbacks);
 if(!dependencies.pool)app.addHook('onClose',async()=>{await pool.end();});
 const identity=new IdentityService(pool,options.config,options);
 registerIdentityRoutes(app,identity,new WorkspaceService(pool,options.config.appTokenSecret!));
 const billing=new BillingService(pool,options.config);
 if (options.config.billingMode !== 'disabled') registerBillingRoutes(app,identity,billing);
 const storageService = new StorageService(pool,options.config);
 registerStorageRoutes(app,identity,storageService);
 registerIngestionRoutes(app,identity,new NoteIndexService(pool,options.config));
 const textIngestion=new TextIngestionService(pool,options.config);
 registerTextIngestionRoutes(app,identity,textIngestion);
 const imageLinks=new RagImageLinks(pool,options.config,storageService);
 const ragQuery = new RagQueryService(pool,options.config,{
  ...options.ragQueryDependencies,
  resolveImages: (scope,images)=>imageLinks.resolve(scope,images),
 });
 app.addHook('onClose',async()=>{await ragQuery.close();});
 registerAssetRoutes(app,identity,new AssetService(pool,options.config.appTokenSecret!,options.config,ragQuery),storageService);
 registerRagRoutes(app,identity,new RagIngestionRepository(pool,options.config),storageService.storage,ragQuery);
 registerTaskRoutes(app,identity,new TaskService(pool,options.config.appTokenSecret!,options.config.billingMode === 'disabled' ? undefined : billing),options.config.demoTasks);return app;
}
