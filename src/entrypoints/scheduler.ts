import { expireUploads } from '../modules/storage/jobs.js';
import { loadConfig } from '../config/config.js';
import { createDependencies } from '../plugins/dependencies.js';
import { TaskScheduler } from '../modules/tasks/scheduler.js';
import { QueuePublisher } from '../modules/tasks/queue.js';
import { serve } from './runtime.js';
import { buildBase } from '../apps/base.js';
const config=loadConfig('scheduler');const dependencies=createDependencies(config);
const publisher=new QueuePublisher(config);const scheduler=new TaskScheduler(dependencies.pool!,publisher,config.instanceId,config.taskRedeliveryMs);
let stopping=false,lastScan=0,lastWarning=0,timer:NodeJS.Timeout|undefined,inflight:Promise<void>|undefined;
const app=await buildBase({config,dependencies,backgroundHealthy:()=>!stopping&&Date.now()-lastScan<15000});
async function tick(){
 try{await expireUploads(dependencies.pool!);const backlog=await scheduler.tick();lastScan=Date.now();if(backlog.age>60&&Date.now()-lastWarning>60000){app.log.warn({backlog:backlog.count,oldestSeconds:backlog.age},'Task delivery backlog');lastWarning=Date.now();}}
 catch{app.log.warn({code:'SCHEDULER_SCAN_FAILED'},'Task scan failed');}
 finally{if(!stopping)timer=setTimeout(()=>{inflight=tick();},config.schedulerIntervalMs);}
}
inflight=tick();
app.addHook('preClose',async()=>{stopping=true;if(timer)clearTimeout(timer);await inflight;await publisher.close();});
await serve(app,config);
