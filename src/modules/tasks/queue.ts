import { TextIngestionJobs } from '../text-ingestion/jobs.js';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import type { QueueName } from './model.js';
import { TaskEngine } from './engine.js';
import { StorageJobs } from '../storage/jobs.js';
import { storageFor } from '../storage/port.js';
import { BillingService } from '../billing/service.js';
import { tagExtractorFor } from '../assets/tag-extractor.js';
import { RagIngestionJobs, type RagJobError } from '../rag/jobs.js';
import { NoteIndexJobs } from '../ingestion/jobs.js';
import {RuntimeSettings} from '../runtime-settings/service.js';
import {ProcessingNodeJobs} from '../processing-nodes/jobs.js';
import { withApplicationMetrics, type TaskMetrics } from '../../plugins/metrics.js';
import type {FastifyBaseLogger} from 'fastify';
import { taskLogFields, withTaskTrace } from './observability.js';
import { RedisTemporaryUploads } from '../storage/temporary-uploads.js';
import { TemporaryUploadCleaner } from '../storage/temporary-upload-cleaner.js';
export const concurrency:Record<QueueName,number>={content:2,ai:1,commercial:1,maintenance:1};
export class TaskWorkers {
 private refreshTimer?:NodeJS.Timeout;private refresh?:Promise<void>;
 private cleanupTimer?:NodeJS.Timeout;private cleanup?:Promise<void>;private cleanupActive=false;
 private readonly uploads?:RedisTemporaryUploads;private readonly uploadCleaner?:TemporaryUploadCleaner;
 private draining?:Promise<void>;private closing?:Promise<void>;private active=0;
 private readonly nodeJobs:ProcessingNodeJobs;
 readonly connection:Redis;readonly workers:Worker[];private stopping=false;private readonly rag: RagIngestionJobs;private readonly noteIndex:NoteIndexJobs;private readonly textIngestion:TextIngestionJobs;
 constructor(pool:pg.Pool,config:AppConfig,metrics?:TaskMetrics,private readonly logger?:FastifyBaseLogger){
  this.nodeJobs=new ProcessingNodeJobs(pool,config);
  this.connection=new Redis(config.redisQueueUrl,{maxRetriesPerRequest:null,connectTimeout:1500,retryStrategy:n=>Math.min(n*200,2000)});
  this.connection.on('error',()=>undefined);this.rag=new RagIngestionJobs(pool,config,storageFor(config));this.noteIndex=new NoteIndexJobs(pool,config);this.textIngestion=new TextIngestionJobs(pool,config);const settings=new RuntimeSettings(pool,config);
  this.workers=config.workerQueues.map(name=>{
   const w=new Worker(name,async job=>{
    // A delivery already fetched during pause remains recoverable from the PG outbox.
    if(this.stopping)return;
    this.active++;
    try{return await withApplicationMetrics(metrics,()=>settings.run(async()=>{
    const engine=new TaskEngine(pool,config.taskLeaseMs,new BillingService(pool,config),new StorageJobs(pool,storageFor(config),config),tagExtractorFor(config.tagExtractorProvider),this.rag,this.noteIndex,this.textIngestion,this.nodeJobs,metrics);
    if(typeof job.data.taskId!=='string'||!/^[a-f0-9-]{36}$/.test(job.data.taskId))return;
    if(this.stopping)return;
    const a=await engine.claim(job.data.taskId,config.instanceId);if(!a)return;
    return withTaskTrace(a,async()=>{
    const log=this.logger;log?.info({event:'task.step.started',...taskLogFields(a)},'Task step started');
    let lost=false;let heartbeatRunning=false;const controller=new AbortController();a.signal=controller.signal;
    const timer=setInterval(()=>{if(heartbeatRunning)return;heartbeatRunning=true;void engine.heartbeat(a).then(ok=>{if(!ok){lost=true;controller.abort();}}).catch(()=>{lost=true;controller.abort();}).finally(()=>{heartbeatRunning=false;});},Math.max(250,config.taskLeaseMs/3));
    try{
     // Explicit test-only processing barrier for kill/SIGTERM acceptance; never enabled in production.
     if(config.testTaskDelayMs&&a.task.kind==='demo.digest')await new Promise(r=>setTimeout(r,config.testTaskDelayMs));
     if(!lost){await engine.execute(a);log?.info({event:'task.step.finished',...taskLogFields(a),'step.outcome':a.stepOutcome??'stale'},'Task step returned');}
     else log?.info({event:'task.step.finished',...taskLogFields(a),'step.outcome':'stale'},'Task step lease lost');
    }catch(error){const ragError=error as Partial<RagJobError>;let outcome='unrecorded';
     try{await engine.fail(a,typeof ragError.code==='string'?ragError.code:'TASK_EXECUTION_FAILED',ragError.retryable!==false);outcome=a.stepOutcome??'stale';}
     finally{log?.error({event:'task.step.error',...taskLogFields(a),err:error,errorCode:typeof ragError.code==='string'?ragError.code:'TASK_EXECUTION_FAILED','step.outcome':outcome},'Task step error');}
    }
    finally{clearInterval(timer);}
    });
   }));}finally{this.active--;}
   },{connection:this.connection,prefix:config.queuePrefix,autorun:false,concurrency:config.taskPolicy.concurrency[name],lockDuration:config.taskLeaseMs*2,maxStalledCount:1});
   w.on('error',()=>undefined);return w;
  });
  const refresh=async()=>{try{await settings.run(async()=>{for(const w of this.workers){w.concurrency=config.taskPolicy.concurrency[w.name as QueueName];if(!w.isRunning()&&!this.stopping)void w.run().catch(()=>undefined);}});}catch{/* Keep last validated limits; task execution still requires a current DB snapshot. */}finally{if(!this.stopping){this.refreshTimer=setTimeout(()=>{this.refresh=refresh();},5000);this.refreshTimer.unref();}}};
  this.refresh=refresh();
  if(config.storageDriver==='aliyun-oss'&&config.workerQueues.includes('maintenance')){
   this.uploads=new RedisTemporaryUploads(config);
   this.uploadCleaner=new TemporaryUploadCleaner(pool,storageFor(config),this.uploads,config);
   const cleanup=async()=>{
    if(this.stopping)return;
    this.cleanupActive=true;
    try{
     const result=await this.uploadCleaner!.sweep(10);
     for(const failure of result.failures)this.logger?.warn({resourceId:failure.resourceId,code:failure.code},'Temporary upload cleanup deferred');
    }catch{this.logger?.warn({code:'UPLOAD_CLEANUP_UNAVAILABLE'},'Temporary upload cleanup unavailable');}
    finally{this.cleanupActive=false;if(!this.stopping){this.cleanupTimer=setTimeout(()=>{this.cleanup=cleanup();},60_000);this.cleanupTimer.unref();}}
   };
   this.cleanupTimer=setTimeout(()=>{this.cleanup=cleanup();},5000);this.cleanupTimer.unref();
  }
 }
 healthy(){return !this.stopping&&this.workers.every(w=>w.isRunning());}
 activeJobs(){return this.active+Number(this.cleanupActive);}
 drain(){
  if(this.draining)return this.draining;
  this.stopping=true;if(this.refreshTimer)clearTimeout(this.refreshTimer);
  if(this.cleanupTimer)clearTimeout(this.cleanupTimer);this.uploadCleaner?.stop();
  // Local pause stops fetching immediately, while preserving active job lock/lease renewal.
  this.draining=Promise.all(this.workers.map(w=>w.pause(true))).then(()=>undefined);
  return this.draining;
 }
 close(){
  this.closing??=(async()=>{await this.drain();await this.refresh;await this.cleanup;await Promise.all(this.workers.map(w=>w.close()));await this.uploads?.close();await this.rag.close();await this.textIngestion.close();await this.nodeJobs.close();this.connection.disconnect();})();
  return this.closing;
 }
}
