import fastifyStatic from '@fastify/static';
import { join, resolve } from 'node:path';
import { TaskService } from '../modules/tasks/service.js';
import { createDependencies, poolFor } from '../plugins/dependencies.js';
import { buildBase, type BuildOptions } from './base.js';
import { AdminService } from '../modules/admin/service.js';
import { registerAdminRoutes } from '../modules/admin/routes.js';
import { AiTemplateCatalog } from '../modules/ai-templates/catalog.js';
import {RuntimeSettings} from '../modules/runtime-settings/service.js';
import {ProcessingNodes} from '../modules/processing-nodes/service.js';
import {AdminDocumentTrials} from '../modules/admin/document-trials.js';
import {ProcessingNodeJobs} from '../modules/processing-nodes/jobs.js';
export async function buildAdminServer(options: BuildOptions) {
  const { config } = options;
  if (config.role !== 'admin') throw new Error('INVALID_ADMIN_ROLE');
  const secret = config.adminSessionSecret;
  if (!secret) throw new Error('ADMIN_SECRET_MISSING');

  const dependencies = options.dependencies ?? createDependencies(config);
  const pool = dependencies.pool ?? poolFor(config);
  const app = await buildBase({ ...options, dependencies });
  if (!dependencies.pool) app.addHook('onClose', async () => { await pool.end(); });

  const uiRoot = resolve('dist/admin-ui');
  await app.register(fastifyStatic, {
    root: join(uiRoot, 'assets'),
    prefix: '/admin/assets/',
    cacheControl: false,
    dotfiles: 'ignore',
    index: false,
  });
  const nodes=new ProcessingNodes(pool,config);app.addHook('onClose',()=>nodes.close());
  const nodeJobs=new ProcessingNodeJobs(pool,config);app.addHook('onClose',()=>nodeJobs.close());
  const trials=new AdminDocumentTrials(pool,config);app.addHook('preClose',()=>trials.close());
  registerAdminRoutes(app, new AdminService(pool, secret), config, new TaskService(pool, secret), {settings:new RuntimeSettings(pool,config),nodes,nodeJobs,trials,aiTemplates:new AiTemplateCatalog(pool)}, reply => (
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
      .sendFile('index.html', uiRoot)
  ));
  return app;
}
