import type pg from 'pg';
import type { StorageJobs } from '../storage/jobs.js';
import { randomUUID } from 'node:crypto';
import { transaction } from '../identity/store.js';
import { type TaskRow, hash, event, enqueueIntent, retryDelay } from './model.js';
import type { BillingService } from '../billing/service.js';
import { UnavailableTagExtractor, extractBoundedTags, validateTagLabels, type TagExtractor } from '../assets/tag-extractor.js';
export interface Attempt {task:TaskRow;owner:string;version:number;attempt:number;}
export class TaskEngine {
 constructor(readonly pool:pg.Pool,readonly leaseMs=15000,readonly billing?:BillingService,readonly storage?:StorageJobs,readonly tagExtractor:TagExtractor=new UnavailableTagExtractor('disabled')){}
 async claim(id:string,owner:string):Promise<Attempt|null>{return transaction(this.pool,async tx=>{
  const r=await tx.query<TaskRow>("SELECT * FROM tasks WHERE id=$1 AND state IN ('queued','retry_scheduled') AND available_at<=now() AND external_state='none' FOR UPDATE",[id]);const t=r.rows[0];if(!t)return null;
  if(t.attempt_no>=t.max_attempts){await tx.query("UPDATE tasks SET state='failed',error_code='ATTEMPTS_EXHAUSTED',retryable=true WHERE id=$1",[id]);if(this.billing&&t.reservation_id)await this.billing.releaseReservationTx(tx,t.reservation_id);await event(tx,id);return null;}
  const updated=await tx.query<TaskRow>("UPDATE tasks SET state='running',attempt_no=attempt_no+1,version=version+1,lease_owner=$2,lease_until=now()+$3*interval '1 millisecond' WHERE id=$1 RETURNING *",[id,owner,this.leaseMs]);
  const task=updated.rows[0]!;await tx.query("INSERT INTO task_attempts(task_id,attempt_no,version,owner,state) VALUES($1,$2,$3,$4,'running')",[id,task.attempt_no,task.version,owner]);await event(tx,id);
  return {task,owner,version:task.version,attempt:task.attempt_no};
 });}
 async heartbeat(a:Attempt){const r=await this.pool.query("UPDATE tasks SET lease_until=now()+$5*interval '1 millisecond' WHERE id=$1 AND lease_owner=$2 AND version=$3 AND attempt_no=$4 AND state='running' AND lease_until>now()",[a.task.id,a.owner,a.version,a.attempt,this.leaseMs]);return r.rowCount===1;}
 async finish(a:Attempt,digest:string,byteCount:number,apply?:(tx:pg.PoolClient)=>Promise<void>){return transaction(this.pool,async tx=>{
  const r=await tx.query<TaskRow>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[a.task.id]);const t=r.rows[0];
  if(!t||t.state!=='running'||t.version!==a.version||t.attempt_no!==a.attempt||t.lease_owner!==a.owner||!t.lease_until||t.lease_until.getTime()<=Date.now())return false;
  if(apply)await apply(tx);
  const resultId=randomUUID();await tx.query('INSERT INTO task_results(id,task_id,attempt_no,digest,byte_count) VALUES($1,$2,$3,$4,$5)',[resultId,t.id,a.attempt,digest,byteCount]);
  await tx.query("UPDATE tasks SET state='succeeded',result_id=$2,version=version+1,lease_until=NULL,lease_owner=NULL,error_code=NULL,retryable=false WHERE id=$1",[t.id,resultId]);
  await tx.query("UPDATE task_attempts SET state='succeeded',finished_at=now() WHERE task_id=$1 AND attempt_no=$2",[t.id,a.attempt]);
  if (this.billing && t.reservation_id) await this.billing.commitReservationTx(tx,t.reservation_id);
  await event(tx,t.id);return true;
 });}
 async fail(a:Attempt,code:string,retryable:boolean){return transaction(this.pool,async tx=>{
  const r=await tx.query<TaskRow>("SELECT * FROM tasks WHERE id=$1 AND version=$2 AND lease_owner=$3 AND state='running' AND lease_until>now() FOR UPDATE",[a.task.id,a.version,a.owner]);const t=r.rows[0];if(!t)return false;
  const retry=retryable&&t.attempt_no<t.max_attempts&&t.external_state==='none',delay=retryDelay(t.attempt_no);
  const state=t.external_state!=='none'?'reconciling':retry?'retry_scheduled':'failed';
  await tx.query("UPDATE tasks SET state=$2,error_code=$3,retryable=$4,lease_until=NULL,lease_owner=NULL,version=version+1,available_at=now()+$5*interval '1 millisecond' WHERE id=$1",[t.id,state,code,retryable,delay]);
  await tx.query("UPDATE task_attempts SET state='failed',error_code=$3,finished_at=now() WHERE task_id=$1 AND attempt_no=$2",[t.id,a.attempt,code]);
  if(retry)await enqueueIntent(tx,t.id,delay); if (!retry && t.external_state === 'none' && this.billing && t.reservation_id) await this.billing.releaseReservationTx(tx,t.reservation_id); await event(tx,t.id);return true;
 });}
 // Future provider adapters must record intent BEFORE the external call. Recovery never resubmits it.
 async markExternal(a:Attempt,reference:string|null){const r=await this.pool.query("UPDATE tasks SET external_state='unknown',external_reference=$5 WHERE id=$1 AND version=$2 AND lease_owner=$3 AND attempt_no=$4 AND state='running' AND lease_until>now()",[a.task.id,a.version,a.owner,a.attempt,reference]);return r.rowCount===1;}
 async waitingExternal(a:Attempt,reference:string){return transaction(this.pool,async tx=>{
  const r=await tx.query("UPDATE tasks SET state='waiting_external',external_state='submitted',external_reference=$5,lease_owner=NULL,lease_until=NULL,version=version+1 WHERE id=$1 AND version=$2 AND lease_owner=$3 AND attempt_no=$4 AND state='running' AND lease_until>now()",[a.task.id,a.version,a.owner,a.attempt,reference]);
  if(r.rowCount){await tx.query("UPDATE task_attempts SET state='waiting_external',finished_at=now() WHERE task_id=$1 AND attempt_no=$2",[a.task.id,a.attempt]);await event(tx,a.task.id);}return r.rowCount===1;
 });}
 async execute(a:Attempt){
  if(a.task.kind.startsWith('storage.')&&this.storage){const result=await this.storage.execute(a);return this.finish(a,result.digest,result.bytes);}
  if(a.task.kind==='asset.tag-extract'){
   if(!await this.heartbeat(a))return false;
   const input=(await this.pool.query('SELECT body FROM task_inputs WHERE id=$1 AND user_id=$2 AND workspace_id=$3',[a.task.input_id,a.task.user_id,a.task.workspace_id])).rows[0];
   if(!input)return this.fail(a,'INPUT_UNAVAILABLE',false);
   const spec=JSON.parse(String(input.body)) as {noteId:string;revisionId:string;tagSetVersion?:number};
   const n=(await this.pool.query(`SELECT n.*,p.content_markdown FROM notes n
     JOIN workspaces w ON w.id=n.workspace_id AND w.user_id=$3 AND w.state='ready'
     LEFT JOIN LATERAL (SELECT content_markdown FROM note_part_revisions WHERE note_id=n.note_id AND part='raw' ORDER BY revision DESC LIMIT 1) p ON true
     WHERE n.note_id=$1 AND n.workspace_id=$2`,[spec.noteId,a.task.workspace_id,a.task.user_id])).rows[0];
   const outcome=(status:string)=>this.finish(a,hash(status),0,async tx=>{
     await tx.query('UPDATE content_jobs SET outcome=$2,provider=$3 WHERE task_id=$1',[a.task.id,status,this.tagExtractor.provider]);
   });
   if(!n||n.state!=='active'||n.note_revision_id!==spec.revisionId||spec.tagSetVersion!==Number(n.tag_set_version))return outcome('stale');
   if(!n.content_markdown?.trim())return outcome('needs-readable-text');
   let extracted:{provider:string;labels:unknown};
   try { extracted=await extractBoundedTags(this.tagExtractor,{noteId:spec.noteId,noteRevisionId:spec.revisionId,title:n.title,rawText:n.content_markdown}); }
   catch(error) { const invalid=error instanceof Error && /TAG_(OUTPUT|INPUT)_/.test(error.message);return this.fail(a,invalid?'TAG_OUTPUT_INVALID':'TAG_PROVIDER_UNAVAILABLE',!invalid&&!(this.tagExtractor instanceof UnavailableTagExtractor)); }
   let labels:string[];
   try { labels=validateTagLabels(extracted.labels); } catch { return this.fail(a,'TAG_OUTPUT_INVALID',false); }
   return this.finish(a,hash(JSON.stringify({labels,provider:extracted.provider})),labels.length,async tx=>{
     const locked=(await tx.query(`SELECT n.* FROM notes n JOIN workspaces w ON w.id=n.workspace_id AND w.user_id=$3 AND w.state='ready'
       WHERE note_id=$1 AND workspace_id=$2 FOR UPDATE OF n`,[spec.noteId,a.task.workspace_id,a.task.user_id])).rows[0];
     let status='stale';
     if(locked?.state==='active' && locked.note_revision_id===spec.revisionId){
       // Only the first automatic extraction may write the effective set. Legacy
       // tasks without a captured tag version are never allowed to overwrite it.
       const automatic=spec.tagSetVersion===0 && Number(locked.tag_set_version)===0 && !locked.tag_manual_override;
       if(automatic){
         await tx.query("DELETE FROM note_tags WHERE note_id=$1 AND source='extracted'",[spec.noteId]);
         for(const displayName of [...labels].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()))){
           const normalized=displayName.normalize('NFKC').trim().toLowerCase();
           const tag=(await tx.query(`INSERT INTO asset_tags(tag_id,workspace_id,normalized_name,display_name,source)
             VALUES($1,$2,$3,$4,'extracted') ON CONFLICT(workspace_id,normalized_name) DO UPDATE SET display_name=asset_tags.display_name RETURNING tag_id`,
             [randomUUID(),locked.workspace_id,normalized,displayName])).rows[0];
           await tx.query("INSERT INTO note_tags(note_id,tag_id,source) VALUES($1,$2,'extracted') ON CONFLICT DO NOTHING",[spec.noteId,tag.tag_id]);
         }
         await tx.query('UPDATE notes SET tag_set_version=tag_set_version+1 WHERE note_id=$1',[spec.noteId]);
         await tx.query('INSERT INTO workspace_content_state(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',[locked.workspace_id]);
         const cursor=(await tx.query('UPDATE workspace_content_state SET next_cursor=next_cursor+1,updated_at=now() WHERE workspace_id=$1 RETURNING next_cursor',[locked.workspace_id])).rows[0].next_cursor;
         await tx.query(`INSERT INTO content_events(event_id,workspace_id,cursor,operation_id,object_kind,object_id,change_type) VALUES($1,$2,$3,$4,'hnote',$5,'updated')`,[randomUUID(),locked.workspace_id,cursor,randomUUID(),spec.noteId]);
         status='applied';
       }else if(spec.tagSetVersion===Number(locked.tag_set_version)){
         await tx.query(`INSERT INTO note_tag_suggestions(suggestion_id,workspace_id,note_id,task_id,note_revision_id,expected_tag_set_version,labels,provider)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(task_id) DO NOTHING`,
           [randomUUID(),locked.workspace_id,spec.noteId,a.task.id,spec.revisionId,spec.tagSetVersion,JSON.stringify(labels),extracted.provider]);
         status='suggested';
       }
     }
     await tx.query('UPDATE content_jobs SET outcome=$2,provider=$3 WHERE task_id=$1',[a.task.id,status,extracted.provider]);
   });
  }
  if(a.task.kind==='demo.digest'){
   const r=await this.pool.query('SELECT body FROM task_inputs WHERE id=$1 AND user_id=$2 AND workspace_id=$3',[a.task.input_id,a.task.user_id,a.task.workspace_id]);
   if(!r.rows[0])return this.fail(a,'INPUT_UNAVAILABLE',false);
   const body=String(r.rows[0].body);return this.finish(a,hash(body),Buffer.byteLength(body));
  }
  if(a.task.kind==='maintenance.check'){
   const r=await this.pool.query("SELECT count(*)::int AS n FROM tasks WHERE state='failed'");
   return this.finish(a,hash(JSON.stringify({failedTasks:r.rows[0].n})),0);
  }
  return this.fail(a,'TASK_KIND_UNSUPPORTED',false);
 }
}
