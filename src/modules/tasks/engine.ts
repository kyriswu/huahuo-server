import type { TextIngestionJobs } from '../text-ingestion/jobs.js';
import type pg from 'pg';
import type { StorageJobs } from '../storage/jobs.js';
import { randomUUID } from 'node:crypto';
import { transaction } from '../identity/store.js';
import { type TaskRow, hash, event, enqueueIntent, retryDelay,parserRequestId } from './model.js';
import {ParserExecutionDeferred} from '../../lib/document-parser-machine/index.js';
import type {ProcessingNodeJobs} from '../processing-nodes/jobs.js';
import { UnavailableTagExtractor, extractBoundedTags, validateTagLabels, type TagExtractor } from '../assets/tag-extractor.js';
import type { RagIngestionJobs } from '../rag/jobs.js';
import type { NoteIndexJobs } from '../ingestion/jobs.js';
import type { TaskMetrics, TaskResult } from '../../plugins/metrics.js';
import { finalizeTaskTx, lockOwnedAttemptTx } from './lifecycle.js';
import { finalizeUnsuccessfulTaskTx } from './reservations.js';
import type { BillingService } from '../billing/service.js';
export interface Attempt {task:TaskRow;owner:string;version:number;attempt:number;signal?:AbortSignal;}
export class TaskEngine {
 constructor(readonly pool:pg.Pool,readonly leaseMs=15000,readonly billing?:BillingService,readonly storage?:StorageJobs,readonly tagExtractor:TagExtractor=new UnavailableTagExtractor('disabled'),readonly rag?:RagIngestionJobs,readonly noteIndex?:NoteIndexJobs,readonly textIngestion?:TextIngestionJobs,readonly nodeJobs?:ProcessingNodeJobs,readonly metrics?:TaskMetrics){}
 async claim(id:string,owner:string):Promise<Attempt|null>{return transaction(this.pool,async tx=>{
  const r=await tx.query<TaskRow>(`SELECT * FROM tasks WHERE id=$1 AND available_at<=now() AND (
   (state IN ('queued','retry_scheduled') AND external_state='none') OR
   (state IN ('waiting_external','reconciling','cancel_requested') AND (lease_until IS NULL OR lease_until<now()) AND (
    (kind IN ('rag.document-ingest','text.ingest') AND (external_reference LIKE 'xberg-bound:%' OR external_reference LIKE 'xberg-job:%' OR external_reference LIKE 'xberg-cancelling:%')) OR
    (kind='processing.node-start' AND external_reference LIKE 'node-start:%')))
  ) FOR UPDATE`,[id]);const t=r.rows[0];if(!t)return null;
  const continuation=Boolean(parserRequestId((t as TaskRow&{external_reference:string}).external_reference))||t.kind==='processing.node-start'&&t.attempt_no>0;
  if(!continuation&&t.attempt_no-t.resume_count>=t.max_attempts){await finalizeUnsuccessfulTaskTx(tx,t,{state:'failed',errorCode:'ATTEMPTS_EXHAUSTED',retryable:true});return null;}
  const updated=await tx.query<TaskRow>("UPDATE tasks SET state='running',attempt_no=attempt_no+1,resume_count=resume_count+$4,version=version+1,lease_owner=$2,lease_until=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1 RETURNING *",[id,owner,this.leaseMs,continuation?1:0]);
  const task=updated.rows[0]!;await tx.query("INSERT INTO task_attempts(task_id,attempt_no,version,owner,state) VALUES($1,$2,$3,$4,'running')",[id,task.attempt_no,task.version,owner]);await event(tx,id);
  return {task,owner,version:task.version,attempt:task.attempt_no};
 });}
 async heartbeat(a:Attempt){const r=await this.pool.query(`WITH locked AS MATERIALIZED (
  SELECT id,lease_owner,version,attempt_no,state,lease_until FROM tasks WHERE id=$1 FOR UPDATE
 ) UPDATE tasks t SET lease_until=clock_timestamp()+$5*interval '1 millisecond' FROM locked l
 WHERE t.id=l.id AND l.lease_owner=$2 AND l.version=$3 AND l.attempt_no=$4
  AND l.state='running' AND l.lease_until>clock_timestamp()`,[a.task.id,a.owner,a.version,a.attempt,this.leaseMs]);return r.rowCount===1;}
 async finish(a:Attempt,digest:string,byteCount:number,apply?:(tx:pg.PoolClient)=>Promise<void>){const applied=await transaction(this.pool,async tx=>{
  const t=await lockOwnedAttemptTx(tx,a);if(!t)return false;
  if(apply)await apply(tx);
  const resultId=randomUUID();await tx.query('INSERT INTO task_results(id,task_id,attempt_no,digest,byte_count) VALUES($1,$2,$3,$4,$5)',[resultId,t.id,a.attempt,digest,byteCount]);
  await tx.query("UPDATE task_attempts SET state='succeeded',finished_at=now() WHERE task_id=$1 AND attempt_no=$2",[t.id,a.attempt]);
  await finalizeTaskTx(tx,t,{state:'succeeded',resultId},async()=>{
   if(this.billing&&t.reservation_id)await this.billing.commitReservationTx(tx,t.reservation_id);
  });return true;
 });if(applied)this.metrics?.recordTaskAttempt(a.task.kind,'success');return applied;}
 async fail(a:Attempt,code:string,retryable:boolean){const outcome=await transaction(this.pool,async tx=>{
  const t=await lockOwnedAttemptTx(tx,a);if(!t)return {applied:false,result:null};
  const retry=retryable&&t.attempt_no-t.resume_count<t.max_attempts&&t.external_state==='none',delay=retryDelay(t.attempt_no-t.resume_count);
  const state=t.external_state!=='none'?'reconciling':retry?'retry_scheduled':'failed';
  await tx.query("UPDATE task_attempts SET state='failed',error_code=$3,finished_at=now() WHERE task_id=$1 AND attempt_no=$2",[t.id,a.attempt,code]);
  if(state==='failed')await finalizeUnsuccessfulTaskTx(tx,t,{state,errorCode:code,retryable});
  else{
   await tx.query("UPDATE tasks SET state=$2,error_code=$3,retryable=$4,lease_until=NULL,lease_owner=NULL,version=version+1,available_at=now()+$5*interval '1 millisecond' WHERE id=$1",[t.id,state,code,retryable,delay]);
   if(retry)await enqueueIntent(tx,t.id,delay);await event(tx,t.id);
  }
  return {applied:true,result:state==='reconciling'?null:'failure' as TaskResult};
 });if(outcome.result)this.metrics?.recordTaskAttempt(a.task.kind,outcome.result);return outcome.applied;}
 // Future provider adapters must record intent BEFORE the external call. Recovery never resubmits it.
 async markExternal(a:Attempt,reference:string|null){return transaction(this.pool,async tx=>{
  if(!await lockOwnedAttemptTx(tx,a))return false;
  await tx.query("UPDATE tasks SET external_state='unknown',external_reference=$2 WHERE id=$1",[a.task.id,reference]);return true;
 });}
 async waitingExternal(a:Attempt,reference:string){return transaction(this.pool,async tx=>{
  if(!await lockOwnedAttemptTx(tx,a))return false;
  await tx.query("UPDATE tasks SET state='waiting_external',external_state='submitted',external_reference=$2,lease_owner=NULL,lease_until=NULL,version=version+1 WHERE id=$1",[a.task.id,reference]);
  await tx.query("UPDATE task_attempts SET state='waiting_external',finished_at=now() WHERE task_id=$1 AND attempt_no=$2",[a.task.id,a.attempt]);await event(tx,a.task.id);return true;
 });}
 async defer(a:Attempt,delayMs:number){return transaction(this.pool,async tx=>{
  const row=(await tx.query<TaskRow&{external_reference:string;cancel_requested_at:Date|null}>(`WITH locked AS MATERIALIZED (
   SELECT * FROM tasks WHERE id=$1 FOR UPDATE
  ) SELECT * FROM locked WHERE lease_owner=$2 AND attempt_no=$3 AND lease_until>clock_timestamp()`,[a.task.id,a.owner,a.attempt])).rows[0];
  if(!row)return false;
  const requestId=parserRequestId(row.external_reference);
  // Cancellation fences business writes by advancing version. The same live
  // attempt may still hand off its durable parser receipt after its local step
  // ends; it may neither clear cancellation nor hand off an unknown POST intent.
  const cancelling=row.state==='cancel_requested'&&row.version>a.version&&Boolean(row.cancel_requested_at)&&Boolean(requestId)&&['rag.document-ingest','text.ingest'].includes(row.kind);
  if(!cancelling&&(row.state!=='running'||row.version!==a.version))return false;
  const ready=requestId&&(await tx.query('SELECT 1 FROM document_parse_callbacks WHERE request_id=$1 AND terminal_state IS NOT NULL AND NOT consumed',[requestId])).rowCount;
  const delay=cancelling||ready?0:delayMs;
  await tx.query("UPDATE tasks SET state=$3,lease_until=NULL,lease_owner=NULL,version=version+1,available_at=now()+$2*interval '1 millisecond',error_code=NULL WHERE id=$1",[a.task.id,delay,cancelling?'cancel_requested':'waiting_external']);
  await tx.query("UPDATE task_attempts SET state='waiting_external',finished_at=now() WHERE task_id=$1 AND attempt_no=$2",[a.task.id,a.attempt]);
  await enqueueIntent(tx,a.task.id,delay);await event(tx,a.task.id);return false;
 });}
 async execute(a:Attempt){
  try{return await this.executeOwned(a);}catch(error){if(error instanceof ParserExecutionDeferred)return this.defer(a,error.delayMs);throw error;}
 }
 private async executeOwned(a:Attempt){
  if(a.task.kind==='processing.node-start'&&this.nodeJobs){const result=await this.nodeJobs.execute(a);return this.finish(a,result.digest,result.bytes);}
  if(a.task.kind==='text.ingest'&&this.textIngestion){const result=await this.textIngestion.execute(a);return this.finish(a,result.digest,result.bytes);}
  if(a.task.kind.startsWith('storage.')&&this.storage){const result=await this.storage.execute(a);return this.finish(a,result.digest,result.bytes);}
  if(a.task.kind==='kb.note-cleanup'&&this.noteIndex){const result=await this.noteIndex.executeCleanup(a);return this.finish(a,result.digest,result.bytes);}
  if(['rag.document-ingest','rag.toc-refresh','rag.document-cleanup'].includes(a.task.kind)&&this.rag){const result=await this.rag.execute(a);return this.finish(a,result.digest,result.bytes);}
  if(a.task.kind==='kb.note-index'&&this.noteIndex){const result=await this.noteIndex.execute(a);return this.finish(a,result.digest,result.bytes);}
  if(a.task.kind==='asset.tag-extract'){
   if(!await this.heartbeat(a))return false;
   const input=(await this.pool.query('SELECT body FROM task_inputs WHERE id=$1 AND user_id=$2 AND workspace_id=$3',[a.task.input_id,a.task.user_id,a.task.workspace_id])).rows[0];
   if(!input)return this.fail(a,'INPUT_UNAVAILABLE',false);
   const spec=JSON.parse(String(input.body)) as {noteId:string;revisionId:string;tagSetVersion?:number};
   const n=(await this.pool.query(`SELECT n.*,p.content_markdown FROM notes n
     JOIN workspaces w ON w.id=n.workspace_id AND w.user_id=$3 AND w.state='ready'
     LEFT JOIN note_parts p ON p.note_id=n.note_id AND p.part='raw'
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
