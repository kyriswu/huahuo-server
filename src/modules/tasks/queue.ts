import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import { queues, type QueueName } from './model.js';
import type { Delivery, TaskPublisher } from './scheduler.js';
import { TaskEngine } from './engine.js';
import { StorageJobs } from '../storage/jobs.js';
import { storageFor } from '../storage/port.js';
import { BillingService } from '../billing/service.js';
import { tagExtractorFor } from '../assets/tag-extractor.js';
export const concurrency:Record<QueueName,number>={content:2,ai:1,commercial:1,maintenance:1};
export class QueuePublisher implements TaskPublisher {
 readonly connection:Redis;readonly queues:Map<QueueName,Queue>;
 constructor(config:AppConfig){
  this.connection=new Redis(config.redisQueueUrl,{maxRetriesPerRequest:1,enableOfflineQueue:false,connectTimeout:1500,commandTimeout:2000});
  this.connection.on('error',()=>undefined);
  this.queues=new Map(queues.map(name=>{const q=new Queue(name,{connection:this.connection,prefix:config.queuePrefix});q.on('error',()=>undefined);return [name,q];}));
 }
 async publish(d:Delivery){await this.queues.get(d.queue)!.add('execute',{taskId:d.task_id},{jobId:d.id,attempts:1,removeOnComplete:{age:3600,count:1000},removeOnFail:{age:86400,count:1000}});}
 async close(){await Promise.all([...this.queues.values()].map(q=>q.close()));this.connection.disconnect();}
}
export class TaskWorkers {
 readonly connection:Redis;readonly workers:Worker[];private stopping=false;
 constructor(pool:pg.Pool,config:AppConfig){
  this.connection=new Redis(config.redisQueueUrl,{maxRetriesPerRequest:null,connectTimeout:1500,retryStrategy:n=>Math.min(n*200,2000)});
  this.connection.on('error',()=>undefined);const engine=new TaskEngine(pool,config.taskLeaseMs,new BillingService(pool,config),new StorageJobs(pool,storageFor(config)),tagExtractorFor(config.tagExtractorProvider));
  this.workers=config.workerQueues.map(name=>{
   const w=new Worker(name,async job=>{
    if(typeof job.data.taskId!=='string'||!/^[a-f0-9-]{36}$/.test(job.data.taskId))return;
    const a=await engine.claim(job.data.taskId,config.instanceId);if(!a)return;
    let lost=false;let heartbeatRunning=false;
    const timer=setInterval(()=>{if(heartbeatRunning)return;heartbeatRunning=true;void engine.heartbeat(a).then(ok=>{if(!ok)lost=true;}).catch(()=>{lost=true;}).finally(()=>{heartbeatRunning=false;});},Math.max(250,config.taskLeaseMs/3));
    try{
     // Explicit test-only processing barrier for kill/SIGTERM acceptance; never enabled in production.
     if(config.testTaskDelayMs&&a.task.kind==='demo.digest')await new Promise(r=>setTimeout(r,config.testTaskDelayMs));
     if(!lost)await engine.execute(a);
    }catch{await engine.fail(a,'TASK_EXECUTION_FAILED',true);}
    finally{clearInterval(timer);}
   },{connection:this.connection,prefix:config.queuePrefix,concurrency:concurrency[name],lockDuration:config.taskLeaseMs*2,maxStalledCount:1});
   w.on('error',()=>undefined);return w;
  });
 }
 healthy(){return !this.stopping&&this.workers.every(w=>w.isRunning());}
 async close(){this.stopping=true;await Promise.all(this.workers.map(w=>w.close()));this.connection.disconnect();}
}
