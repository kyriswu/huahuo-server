import { loadConfig } from '../config/config.js';
import { createDependencies } from '../plugins/dependencies.js';
import { TaskWorkers } from '../modules/tasks/queue.js';
import { serve } from './runtime.js';
import { buildBase } from '../apps/base.js';
const config=loadConfig('worker');const dependencies=createDependencies(config);
const workers=new TaskWorkers(dependencies.pool!,config);
const app=await buildBase({config,dependencies,backgroundHealthy:()=>workers.healthy()});
// Stop claiming and finish bounded local work before closing shared DB dependencies.
app.addHook('preClose',async()=>{await workers.close();});
await serve(app,config);
