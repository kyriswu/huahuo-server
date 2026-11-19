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
import { RedisTemporaryUploads } from '../modules/storage/temporary-uploads.js';
import { ResourceClaims } from '../modules/storage/resource-claims.js';
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
import { registerInternalRoutes } from '../http/internal-routes.js';
import { AiTemplateAgentClient } from '../modules/ai-templates/agent-client.js';
import { registerAiTemplateRoutes } from '../modules/ai-templates/routes.js';
import { AiTemplateRuns } from '../modules/ai-templates/runs.js';
import { BearerCache } from '../modules/identity/bearer-cache.js';
import { PgEvents } from '../lib/pg-events.js';
export async function buildApiServer(options: BuildOptions & IdentityOptions & { ragQueryDependencies?: Omit<RagQueryDependencies, 'resolveImages'> }) {
 if(options.config.role!=='api-server')throw new Error('INVALID_API_ROLE');
 const dependencies=options.dependencies??createDependencies(options.config);
 const pool=dependencies.pool??poolFor(options.config);
 const app=await buildBase({...options,dependencies});
 const settings=new RuntimeSettings(pool,options.config);
 app.addHook('onRequest',(req,_reply,done)=>{const path=req.routeOptions.url;if(path?.startsWith('/api/v1/')&&!path.startsWith('/api/v1/auth/'))void settings.enter(done);else done();});
 const callbacks=new DocumentCallbacks(pool,options.config);
 if(!dependencies.pool)app.addHook('onClose',async()=>{await pool.end();});
 const uploads=new RedisTemporaryUploads(options.config);
 const resourceClaims=new ResourceClaims(options.config,uploads);
 app.addHook('onClose',async()=>{await uploads.close();});
 let nextCacheWarning = 0;
 const cacheWarning = () => {
  if (Date.now() < nextCacheWarning) return;
  nextCacheWarning = Date.now() + 60_000;
  app.log.warn({ event: 'auth.bearer_cache_unavailable' }, 'Bearer session cache unavailable');
 };
 const bearerCache = dependencies.bearerCache &&
  new BearerCache(dependencies.bearerCache, options.config.queuePrefix, options.config.jwt.keyId, cacheWarning);
 const identity=new IdentityService(pool,options.config,options,bearerCache);
 if (bearerCache) {
  const eventPool = poolFor({ ...options.config, poolMax: 1 });
  eventPool.on('error', cacheWarning);
  const events = new PgEvents(eventPool, ['bearer_auth_cache']);
  app.addHook('onReady', async () => {
   await events.subscribe('bearer_auth_cache', null, payload => {
    if (payload) void identity.invalidateBearerEvent(payload).catch(cacheWarning);
   });
  });
  app.addHook('preClose', async () => { await events.close(); await eventPool.end(); });
 }
 registerIdentityRoutes(app,identity,new WorkspaceService(pool,options.config.appTokenSecret!,resourceClaims));
 const billing=new BillingService(pool,options.config);
 if (options.config.billingMode !== 'disabled') registerBillingRoutes(app,billing);
 const storageService = new StorageService(pool,options.config,undefined,uploads);
 registerStorageRoutes(app,storageService);
 registerIngestionRoutes(app,new NoteIndexService(pool,options.config));
 const textIngestion=new TextIngestionService(pool,options.config,resourceClaims);
 registerTextIngestionRoutes(app,textIngestion,storageService);
 const imageLinks=new RagImageLinks(pool,options.config,storageService);
 const ragQuery = new RagQueryService(pool,options.config,{
  ...options.ragQueryDependencies,
  resolveImages: (scope,images)=>imageLinks.resolve(scope,images),
 });
 app.addHook('onClose',async()=>{await ragQuery.close();});
 registerInternalRoutes(app,{identity,callbacks,ragQuery,settings});
 registerAiTemplateRoutes(app, new AiTemplateRuns(pool), new AiTemplateAgentClient(options.config.agentBaseUrl));
 registerAssetRoutes(app,new AssetService(pool,options.config.appTokenSecret!,options.config,ragQuery,resourceClaims),storageService);
 registerRagRoutes(app,new RagIngestionRepository(pool,options.config,resourceClaims),storageService.storage,ragQuery);
 registerTaskRoutes(app,new TaskService(pool,options.config.appTokenSecret!,options.config.billingMode === 'disabled' ? undefined : billing),options.config.demoTasks);return app;
}
