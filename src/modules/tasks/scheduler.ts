import type pg from 'pg';
import {resolveTraceId} from '../../lib/trace.js';
import { randomUUID } from 'node:crypto';
import { DomainError, transaction } from '../identity/store.js';
import { type TaskRow, type QueueName, enqueueIntent,event,retryDelay,newTaskMaxAttempts } from './model.js';
import { finalizeUnsuccessfulTaskTx } from './reservations.js';
export interface Delivery {id:string;task_id:string;queue:QueueName;attempts:number;}
export interface TaskPublisher {publish(delivery:Delivery):Promise<void>;}
export interface RecoveryFailure {taskId:string;code:string;}
export class TaskScheduler {
 private recoveryAfter?:{id:string;updated_at:string};
 constructor(readonly pool:pg.Pool,readonly publisher:TaskPublisher,readonly owner:string=randomUUID(),readonly redeliveryMs=30000){}
 async recover(){
  // Walk stable keyset pages so even a full page of broken reservations cannot
  // starve later tasks. This cursor is only a scan optimization; PG owns state.
  const candidates=()=>this.pool.query<{id:string;updated_at:string}>(`SELECT id,updated_at::text AS updated_at FROM tasks
   WHERE state IN ('running','cancel_requested') AND (lease_until<now() OR lease_until IS NULL)
    AND ($1::timestamptz IS NULL OR (updated_at,id)>($1,$2::uuid))
   ORDER BY updated_at,id LIMIT 50`,[this.recoveryAfter?.updated_at??null,this.recoveryAfter?.id??null]);
  let page=await candidates();
  if(!page.rowCount&&this.recoveryAfter){this.recoveryAfter=undefined;page=await candidates();}
  this.recoveryAfter=page.rows.at(-1);
  let recovered=0;const failures:RecoveryFailure[]=[];
  for(const candidate of page.rows){
   try{if(await this.recoverOne(candidate.id))recovered++;}
   catch(error){
    // Infrastructure errors still fail the scan. A bad task's invariant failure
    // is reported and rolled back independently, without stopping other work.
    if(error instanceof DomainError)failures.push({taskId:candidate.id,code:error.code});
    else if((error as {code?:string})?.code==='23505')failures.push({taskId:candidate.id,code:'TASK_RECOVERY_CONFLICT'});
    else throw error;
   }
  }
  await this.repairDeliveries();
  return {recovered,failures};
 }
 private async recoverOne(id:string){return transaction(this.pool,async tx=>{
  const row=(await tx.query<TaskRow>(`SELECT * FROM tasks WHERE id=$1 AND state IN ('running','cancel_requested')
   AND (lease_until<clock_timestamp() OR lease_until IS NULL) FOR UPDATE SKIP LOCKED`,[id])).rows[0];
  if(!row)return false;
  const managed=(row as TaskRow&{external_reference:string}).external_reference?.match(/^(xberg-(bound|job|cancelling):|node-start:)/);
  const state=managed?'reconciling':row.external_state!=='none'?'reconciling':row.state==='cancel_requested'?'cancelled':row.attempt_no-row.resume_count>=row.max_attempts?'failed':'queued';
  await tx.query("UPDATE task_attempts SET state='abandoned',finished_at=now() WHERE task_id=$1 AND attempt_no=$2 AND state='running'",[row.id,row.attempt_no]);
  if(state==='failed')await finalizeUnsuccessfulTaskTx(tx,row,{state,errorCode:'ATTEMPTS_EXHAUSTED',retryable:true});
  else if(state==='cancelled')await finalizeUnsuccessfulTaskTx(tx,row,{state});
  else{
   await tx.query("UPDATE tasks SET state=$2,version=version+1,lease_owner=NULL,lease_until=NULL,available_at=now(),error_code=NULL,retryable=false WHERE id=$1",[row.id,state]);
   if(state==='queued'||managed)await enqueueIntent(tx,row.id);await event(tx,row.id);
  }
  return true;
 });}
 private async repairDeliveries(){return transaction(this.pool,async tx=>{
  // Redis is a delivery mechanism; periodic PG repair also covers acknowledged-but-lost jobs.
  const pending=await tx.query<{id:string}>(`SELECT t.id FROM tasks t WHERE t.available_at<=now() AND (
   (t.state IN ('queued','retry_scheduled') AND t.external_state='none') OR
   (t.state IN ('waiting_external','reconciling') AND (
    (t.kind IN ('rag.document-ingest','text.ingest') AND (t.external_reference LIKE 'xberg-bound:%' OR t.external_reference LIKE 'xberg-job:%' OR t.external_reference LIKE 'xberg-cancelling:%')) OR
    (t.kind='processing.node-start' AND t.external_reference LIKE 'node-start:%'))))
   AND NOT EXISTS(SELECT 1 FROM task_outbox o WHERE o.task_id=t.id AND (o.status IN ('pending','delivering') OR o.sent_at>now()-$1*interval '1 millisecond'))
   ORDER BY t.created_at LIMIT 50 FOR UPDATE SKIP LOCKED`,[this.redeliveryMs]);
  for(const t of pending.rows)await enqueueIntent(tx,t.id);
 });}
 async schedules(){return transaction(this.pool,async tx=>{
  const r=await tx.query<{id:string;window:string}>(`SELECT id,floor(extract(epoch from now())/interval_seconds)::bigint::text AS window FROM task_schedules
   WHERE enabled AND (last_window IS NULL OR last_window<floor(extract(epoch from now())/interval_seconds)) FOR UPDATE SKIP LOCKED`);
  for(const s of r.rows){
   const id=randomUUID();await tx.query("INSERT INTO tasks(id,kind,queue,state,trace_id,max_attempts) VALUES($1,'maintenance.check','maintenance','queued',$2,$3)",[id,resolveTraceId(),newTaskMaxAttempts()]);
   await tx.query('INSERT INTO task_schedule_windows(schedule_id,window_id,task_id) VALUES($1,$2,$3)',[s.id,s.window,id]);
   await enqueueIntent(tx,id);await event(tx,id);await tx.query('UPDATE task_schedules SET last_window=$2 WHERE id=$1',[s.id,s.window]);
  }return r.rowCount;
 });}
 async claim():Promise<Delivery|null>{return transaction(this.pool,async tx=>{
  const r=await tx.query<Delivery>(`SELECT o.id,o.task_id,t.queue,o.attempts FROM task_outbox o JOIN tasks t ON t.id=o.task_id
   WHERE ((o.status='pending' AND o.available_at<=now()) OR (o.status='delivering' AND o.lease_until<now()))
   ORDER BY o.created_at LIMIT 1 FOR UPDATE OF o SKIP LOCKED`);const d=r.rows[0];if(!d)return null;
  await tx.query("UPDATE task_outbox SET status='delivering',lease_owner=$2,lease_until=now()+interval '10 seconds',attempts=attempts+1 WHERE id=$1",[d.id,this.owner]);return d;
 });}
 async acknowledge(d:Delivery){await this.pool.query("UPDATE task_outbox SET status='sent',sent_at=now(),lease_until=NULL,lease_owner=NULL,last_error=NULL WHERE id=$1 AND lease_owner=$2 AND status='delivering'",[d.id,this.owner]);}
 async dispatch(){for(let n=0;n<20;n++){
  const d=await this.claim();if(!d)break;
  try{await this.publisher.publish(d);await this.acknowledge(d);}
  catch{await this.pool.query("UPDATE task_outbox SET status='pending',available_at=now()+$3*interval '1 millisecond',lease_until=NULL,lease_owner=NULL,last_error='QUEUE_UNAVAILABLE' WHERE id=$1 AND lease_owner=$2",[d.id,this.owner,retryDelay(d.attempts)]);break;}
 }}
 async backlog(){const r=await this.pool.query("SELECT count(*)::int count,coalesce(extract(epoch from now()-min(created_at)),0)::int age FROM task_outbox WHERE status IN ('pending','delivering')");return r.rows[0] as {count:number;age:number};}
 async tick(){const recovery=await this.recover();await this.schedules();await this.dispatch();return {...await this.backlog(),recoveryFailures:recovery.failures};}
}
