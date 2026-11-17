import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { transaction } from '../identity/store.js';
import { event, enqueueIntent, newTaskMaxAttempts } from '../tasks/model.js';
import type { Attempt } from '../tasks/engine.js';
import type { StoragePort } from './port.js';
import {resolveTraceId} from '../../lib/trace.js';
import type { AppConfig } from '../../config/config.js';
export async function storageJob(tx:pg.PoolClient,user:string,workspace:string,operation:'delete',target:string){
 const source=await tx.query('SELECT 1 FROM resources WHERE resource_id=$1 AND user_id=$2 AND workspace_id=$3 FOR SHARE',[target,user,workspace]);
 if(!source.rowCount)throw new Error('STORAGE_TARGET_NOT_FOUND');
 const id=randomUUID();await tx.query("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,state,trace_id,max_attempts) VALUES($1,$2,$3,$4,'maintenance','queued',$5,$6)",[id,user,workspace,`storage.${operation}`,resolveTraceId(),newTaskMaxAttempts()]);
 await tx.query('INSERT INTO storage_jobs(task_id,resource_id,operation) VALUES($1,$2,$3)',[id,target,operation]);await enqueueIntent(tx,id);await event(tx,id);return id;
}
/** All effects are immutable/idempotent. Only the active durable task lease can publish state changes. */
export class StorageJobs {
 constructor(readonly pool:pg.Pool,readonly storage:StoragePort,readonly config:AppConfig){}
 async execute(a:Attempt){
 const j=(await this.pool.query('SELECT * FROM storage_jobs WHERE task_id=$1',[a.task.id])).rows[0];if(!j)throw new Error('STORAGE_JOB_NOT_FOUND');
 if(j.operation!=='delete'||a.task.kind!=='storage.delete')throw new Error('STORAGE_OPERATION_INVALID');
 const s=(await this.pool.query('SELECT * FROM resources WHERE resource_id=$1',[j.resource_id])).rows[0];if(!s||s.user_id!==a.task.user_id||s.workspace_id!==a.task.workspace_id)throw new Error('STORAGE_TARGET_NOT_FOUND');
 const removed=await transaction(this.pool,async tx=>{
  if(!await this.fence(tx,a))throw new Error('STORAGE_LEASE_LOST');
  const locked=(await tx.query('SELECT status FROM resources WHERE resource_id=$1 FOR UPDATE',[s.resource_id])).rows[0];
  if(locked.status==='deleted')return true;
  if(locked.status!=='deleting'||(await tx.query('SELECT 1 FROM resource_refs WHERE resource_id=$1',[s.resource_id])).rowCount)throw new Error('RESOURCE_REFERENCED');
  return false;
 });
 if(!removed){
  const bucket=this.config.storageDriver==='aliyun-oss'?this.config.storageAliyunOss?.bucket:this.config.storageDriver==='s3'?this.config.storageS3?.bucket:null;
  if(s.storage_driver!==this.config.storageDriver||s.storage_bucket!==bucket)throw new Error('RESOURCE_STORAGE_MISMATCH');
  // A deleting resource cannot acquire new references. No transaction or task
  // row lock is held across the object-storage request and lease heartbeats.
  await this.storage.remove(s.object_key,s.object_version);
  await transaction(this.pool,async tx=>{
   // Account before task/resource, including callers that attach billing to a task.
   await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[s.user_id]);
   if(!await this.fence(tx,a))throw new Error('STORAGE_LEASE_LOST');
   const changed=await tx.query("UPDATE resources SET status='deleted',deleted_at=now() WHERE resource_id=$1 AND status='deleting' RETURNING resource_id",[s.resource_id]);
   if(changed.rowCount){
    const released=await tx.query<{confirmed_bytes:string}>("UPDATE storage_reservations SET status='released',updated_at=now() WHERE user_id=$1 AND resource_key=$2 AND status='confirmed' RETURNING confirmed_bytes",[s.user_id,`resource:${s.resource_id}`]);
    if(released.rowCount!==1)throw new Error('STORAGE_USAGE_INCONSISTENT');
    const counted=await tx.query('UPDATE users SET storage_used_bytes=storage_used_bytes-$2::bigint WHERE id=$1 AND storage_used_bytes>=$2::bigint RETURNING id',[s.user_id,released.rows[0]!.confirmed_bytes]);
    if(!counted.rowCount)throw new Error('STORAGE_USAGE_INCONSISTENT');
   }
  });
 }
 return {digest:s.object_version,bytes:0};
 }
 private async fence(tx:pg.PoolClient,a:Attempt){return Boolean((await tx.query("SELECT id FROM tasks WHERE id=$1 AND state='running' AND version=$2 AND lease_owner=$3 AND attempt_no=$4 AND lease_until>now() FOR UPDATE",[a.task.id,a.version,a.owner,a.attempt])).rowCount);}
}
