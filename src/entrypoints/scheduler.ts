import { loadConfig } from '../config/config.js';
import { createDependencies } from '../plugins/dependencies.js';
import { TaskScheduler } from '../modules/tasks/scheduler.js';
import { QueuePublisher } from '../modules/tasks/publisher.js';
import { serve } from './runtime.js';
import { buildBase } from '../apps/base.js';
import { ParserMachineError } from '../lib/document-parser-machine/index.js';
import {ProcessingNodes} from '../modules/processing-nodes/service.js';
import { EcsPowerError } from '../integrations/ecs-power.js';
import { RuntimeSettings } from '../modules/runtime-settings/service.js';
import { tracedOperation, currentTelemetryFields } from '../observability/telemetry.js';
import { withApplicationMetrics } from '../plugins/metrics.js';
const config=loadConfig('scheduler');const dependencies=createDependencies(config);
const publisher=new QueuePublisher(config);
const settings=new RuntimeSettings(dependencies.pool!,config);
let stopping=false,active=false,closingMonitors=false,lastScan=0,lastWarning=0,timer:NodeJS.Timeout|undefined,inflight:Promise<void>|undefined;
const app=await buildBase({config,dependencies,backgroundHealthy:()=>!stopping&&Date.now()-lastScan<15000,backgroundActive:()=>Number(active)+Number(closingMonitors)});
const scheduler=new TaskScheduler(dependencies.pool!,publisher,config.instanceId,config.taskRedeliveryMs,app.metrics);
// Keep cloud RPC latency out of the durable task/outbox scan.
const parserMachine=new ProcessingNodes(dependencies.pool!,config);
let monitorsClosed:Promise<void>|undefined;
const closeMonitors=()=>{if(!monitorsClosed){closingMonitors=true;monitorsClosed=parserMachine.close().finally(()=>{closingMonitors=false;});}return monitorsClosed;};
app.lifecycle.onDrain(()=>{stopping=true;if(timer)clearTimeout(timer);return closeMonitors();});
await parserMachine.startMonitors(error=>{app.log.warn({code:error instanceof ParserMachineError||error instanceof EcsPowerError?error.code:'PROCESSING_NODE_SCAN_FAILED'},'Processing node scan failed');});
async function tick(){
 active=true;
 let scanFields:ReturnType<typeof currentTelemetryFields>={};
 try{
  // One validated snapshot for this entire durable task scheduling round.
  const backlog=await withApplicationMetrics(app.metrics,()=>tracedOperation('scheduler.tick',{},()=>{scanFields=currentTelemetryFields();return settings.run(()=>scheduler.tick());}));lastScan=Date.now();
  app.metrics.recordTaskRecoveryFailures(backlog.recoveryFailures.length);
  for(const failure of backlog.recoveryFailures)app.log.error({...failure,...scanFields},'Task recovery invariant failed; task retained for investigation');
  if(backlog.age>60&&Date.now()-lastWarning>60000){app.log.warn({backlog:backlog.count,oldestSeconds:backlog.age,...scanFields},'Task delivery backlog');lastWarning=Date.now();}}
 catch{app.log.warn({code:'SCHEDULER_SCAN_FAILED',...scanFields},'Task scan failed');}
 finally{active=false;if(!stopping)timer=setTimeout(()=>{inflight=tick();},config.schedulerIntervalMs);}
}
inflight=tick();
app.addHook('preClose',async()=>{stopping=true;if(timer)clearTimeout(timer);await Promise.all([inflight,closeMonitors()]);await publisher.close();});
await serve(app,config);
