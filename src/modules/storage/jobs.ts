import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { transaction } from '../identity/store.js';
import { event, enqueueIntent } from '../tasks/model.js';
import type { Attempt } from '../tasks/engine.js';
import type { StoragePort } from './port.js';
export async function storageJob(tx:pg.PoolClient,user:string,workspace:string,operation:'inspect'|'delete'|'expire',target:string){
 const id=randomUUID();await tx.query("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,state) VALUES($1,$2,$3,$4,$5,'queued')",[id,user,workspace,`storage.${operation}`,operation==='inspect'?'content':'maintenance']);
 await tx.query(`INSERT INTO storage_jobs(task_id,${operation==='expire'?'upload_id':'resource_id'},operation) VALUES($1,$2,$3)`,[id,target,operation]);await enqueueIntent(tx,id);await event(tx,id);return id;
}
export async function expireUploads(pool:pg.Pool){return transaction(pool,async tx=>{
 const r=await tx.query("SELECT * FROM upload_sessions u WHERE (status IN ('failed','expired') OR (status IN ('initiated','uploading','uploaded') AND expires_at<now())) AND NOT EXISTS(SELECT 1 FROM storage_jobs j WHERE j.upload_id=u.upload_id AND operation='expire') ORDER BY expires_at LIMIT 50 FOR UPDATE SKIP LOCKED");
 for(const s of r.rows){await tx.query("UPDATE upload_sessions SET status=CASE WHEN status='failed' THEN 'failed' ELSE 'expired' END,updated_at=now() WHERE upload_id=$1",[s.upload_id]);await tx.query("UPDATE storage_reservations SET status='released',updated_at=now() WHERE reservation_id=$1 AND status='reserved'",[s.reservation_id]);await storageJob(tx,s.user_id,s.workspace_id,'expire',s.upload_id);}return r.rowCount;
});}
/** All effects are immutable/idempotent. Only the active durable task lease can publish state changes. */
export class StorageJobs {
 constructor(readonly pool:pg.Pool,readonly storage:StoragePort){}
 async execute(a:Attempt){
 const j=(await this.pool.query('SELECT * FROM storage_jobs WHERE task_id=$1',[a.task.id])).rows[0];if(!j)throw new Error('STORAGE_JOB_NOT_FOUND');
 const s=(await this.pool.query(j.operation==='expire'?'SELECT *,resource_id AS object_key FROM upload_sessions WHERE upload_id=$1':'SELECT * FROM resources WHERE resource_id=$1',[j.operation==='expire'?j.upload_id:j.resource_id])).rows[0];if(!s)throw new Error('STORAGE_TARGET_NOT_FOUND');
 if(j.operation==='inspect'){
  if(s.status!=='ready')return {digest:s.sha256,bytes:0};
  const meta=await this.storage.stat(s.object_key,s.mime_type);const valid=meta.sha256===s.sha256&&meta.bytes===Number(s.size_bytes);
  await transaction(this.pool,async tx=>{if(!await this.fence(tx,a))return;await tx.query("UPDATE resources SET processing_status=$2,status=CASE WHEN $3 THEN status ELSE 'quarantined' END WHERE resource_id=$1 AND status='ready'",[s.resource_id,valid?'inspected':'failed',valid]);});if(!valid)throw new Error('RESOURCE_INTEGRITY_FAILED');return {digest:meta.sha256,bytes:meta.bytes};
 }
 return transaction(this.pool,async tx=>{
  if(!await this.fence(tx,a))throw new Error('STORAGE_LEASE_LOST');
  if(j.operation==='delete'){
   const locked=(await tx.query('SELECT status FROM resources WHERE resource_id=$1 FOR UPDATE',[s.resource_id])).rows[0];
   if(locked.status==='deleted')return {digest:s.sha256,bytes:0};
   if(locked.status!=='deleting'||(await tx.query('SELECT 1 FROM resource_refs WHERE resource_id=$1',[s.resource_id])).rowCount)throw new Error('RESOURCE_REFERENCED');
  }
  await this.storage.remove(s.object_key,s.object_version);
  // Local partial files are removed only by the Worker after upload expiry.
  if('cleanup' in this.storage && typeof this.storage.cleanup==='function')await this.storage.cleanup(s.object_key);
  if(j.operation==='delete'){
   await tx.query("UPDATE resources SET status='deleted',deleted_at=now() WHERE resource_id=$1",[s.resource_id]);await tx.query('UPDATE resource_delete_requests SET completed_at=now() WHERE resource_id=$1',[s.resource_id]);
   await tx.query("UPDATE storage_reservations SET status='released',updated_at=now() WHERE user_id=$1 AND resource_key=$2",[s.user_id,`resource:${s.resource_id}`]);
  }
  return {digest:s.sha256??s.received_sha256??'expired',bytes:0};
 });
 }
 private async fence(tx:pg.PoolClient,a:Attempt){return Boolean((await tx.query("SELECT id FROM tasks WHERE id=$1 AND state='running' AND version=$2 AND lease_owner=$3 AND attempt_no=$4 AND lease_until>now() FOR UPDATE",[a.task.id,a.version,a.owner,a.attempt])).rowCount);}
}
