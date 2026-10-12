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
export async function buildApiServer(options: BuildOptions & IdentityOptions) {
 if(options.config.role!=='api-server')throw new Error('INVALID_API_ROLE');
 const dependencies=options.dependencies??createDependencies(options.config);
 const pool=dependencies.pool??poolFor(options.config);
 const app=await buildBase({...options,dependencies});
 if(!dependencies.pool)app.addHook('onClose',async()=>{await pool.end();});
 const identity=new IdentityService(pool,options.config,options);
 registerIdentityRoutes(app,identity,new WorkspaceService(pool,options.config.appTokenSecret!));
 const billing=new BillingService(pool,options.config);
 if (options.config.billingMode !== 'disabled') registerBillingRoutes(app,identity,billing);
 registerStorageRoutes(app,identity,new StorageService(pool,options.config));
 registerAssetRoutes(app,identity,new AssetService(pool,options.config.appTokenSecret!));
 registerTaskRoutes(app,identity,new TaskService(pool,options.config.billingMode === 'disabled' ? undefined : billing),options.config.demoTasks);return app;
}
