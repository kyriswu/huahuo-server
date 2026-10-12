import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { transaction } from '../identity/store.js';
import { type TaskRow, type QueueName, enqueueIntent,event,retryDelay } from './model.js';
export interface Delivery {id:string;task_id:string;queue:QueueName;attempts:number;}
export interface TaskPublisher {publish(delivery:Delivery):Promise<void>;}
export class TaskScheduler {
 constructor(readonly pool:pg.Pool,readonly publisher:TaskPublisher,readonly owner:string=randomUUID(),readonly redeliveryMs=30000){}
 async recover(){return transaction(this.pool,async tx=>{
  const r=await tx.query<TaskRow>("SELECT * FROM tasks WHERE (state IN ('running','cancel_requested') AND (lease_until<now() OR lease_until IS NULL)) OR (state='waiting_external' AND updated_at<now()-interval '30 seconds') ORDER BY updated_at LIMIT 50 FOR UPDATE SKIP LOCKED");
  for(const t of r.rows){
   const state=t.external_state!=='none'?'reconciling':t.state==='cancel_requested'?'cancelled':t.attempt_no>=t.max_attempts?'failed':'queued';
   await tx.query("UPDATE tasks SET state=$2,version=version+1,lease_owner=NULL,lease_until=NULL,available_at=now(),error_code=$3,retryable=$4 WHERE id=$1",[t.id,state,state==='failed'?'ATTEMPTS_EXHAUSTED':null,state==='failed']);
   await tx.query("UPDATE task_attempts SET state='abandoned',finished_at=now() WHERE task_id=$1 AND attempt_no=$2 AND state='running'",[t.id,t.attempt_no]);
   if(state==='queued')await enqueueIntent(tx,t.id);await event(tx,t.id);
  }
  // Redis is a delivery mechanism; periodic PG repair also covers acknowledged-but-lost jobs.
  const pending=await tx.query<{id:string}>(`SELECT t.id FROM tasks t WHERE t.state IN ('queued','retry_scheduled') AND t.external_state='none' AND t.available_at<=now()
   AND NOT EXISTS(SELECT 1 FROM task_outbox o WHERE o.task_id=t.id AND (o.status IN ('pending','delivering') OR o.sent_at>now()-$1*interval '1 millisecond'))
   ORDER BY t.created_at LIMIT 50 FOR UPDATE SKIP LOCKED`,[this.redeliveryMs]);
  for(const t of pending.rows)await enqueueIntent(tx,t.id);
  return r.rowCount;
 });}
 async schedules(){return transaction(this.pool,async tx=>{
  const r=await tx.query<{id:string;window:string}>(`SELECT id,floor(extract(epoch from now())/interval_seconds)::bigint::text AS window FROM task_schedules
   WHERE enabled AND (last_window IS NULL OR last_window<floor(extract(epoch from now())/interval_seconds)) AND (lease_until IS NULL OR lease_until<now()) FOR UPDATE SKIP LOCKED`);
  for(const s of r.rows){
   await tx.query("UPDATE task_schedules SET lease_owner=$2,lease_until=now()+interval '10 seconds' WHERE id=$1",[s.id,this.owner]);
   const id=randomUUID();await tx.query("INSERT INTO tasks(id,kind,queue,state) VALUES($1,'maintenance.check','maintenance','queued')",[id]);
   await tx.query('INSERT INTO task_schedule_windows(schedule_id,window_id,task_id) VALUES($1,$2,$3)',[s.id,s.window,id]);
   await enqueueIntent(tx,id);await event(tx,id);await tx.query('UPDATE task_schedules SET last_window=$2,lease_owner=NULL,lease_until=NULL WHERE id=$1',[s.id,s.window]);
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
 async tick(){await this.recover();await this.schedules();await this.dispatch();return this.backlog();}
}
