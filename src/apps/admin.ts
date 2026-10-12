import { TaskService } from '../modules/tasks/service.js';
import { createDependencies, poolFor } from '../plugins/dependencies.js';
import { buildBase, type BuildOptions } from './base.js';
import { AdminService } from '../modules/admin/service.js';
import { registerAdminRoutes } from '../modules/admin/routes.js';
export async function buildAdminServer(options: BuildOptions) {
 if(options.config.role!=='admin')throw new Error('INVALID_ADMIN_ROLE');
 const dependencies=options.dependencies??createDependencies(options.config);
 const pool=dependencies.pool??poolFor(options.config);
 const app=await buildBase({...options,dependencies});
 if(!dependencies.pool)app.addHook('onClose',async()=>{await pool.end();});
 if(!options.config.adminSessionSecret)throw new Error('ADMIN_SECRET_MISSING');
 registerAdminRoutes(app,new AdminService(pool,options.config.adminSessionSecret),options.config,new TaskService(pool));return app;
}
