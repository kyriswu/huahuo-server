import { loadConfig } from '../config/config.js';
import { createDependencies } from '../plugins/dependencies.js';
import { createTaskWorkers } from '../apps/worker.js';
import { serve } from './runtime.js';
import { buildBase } from '../apps/base.js';
import { ApplicationMetrics } from '../plugins/metrics.js';
const config=loadConfig('worker');const dependencies=createDependencies(config);
const metrics=new ApplicationMetrics(config);
const background:{workers?:ReturnType<typeof createTaskWorkers>}={};
const app=await buildBase({config,dependencies,metrics,backgroundHealthy:()=>background.workers?.healthy()??false,backgroundActive:()=>background.workers?.activeJobs()??0});
const workers=createTaskWorkers(dependencies.pool!,config,metrics,app.log);background.workers=workers;
app.lifecycle.onDrain(()=>workers.drain());
// Stop claiming and finish bounded local work before closing shared DB dependencies.
app.addHook('preClose',async()=>{await workers.close();});
await serve(app,config);
