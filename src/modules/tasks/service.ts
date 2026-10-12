import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { transaction, assertScope, audit, lock, DomainError, type Scope } from '../identity/store.js';
import { canonical } from '../identity/crypto.js';
import type { AdminScope } from '../admin/service.js';
import { type TaskRow, hash, event, enqueueIntent, taskDto, terminal } from './model.js';
import type { BillingService } from '../billing/service.js';
export async function requestOnce<T>(tx:pg.PoolClient,scope:string,operation:string,key:string,input:unknown,fn:()=>Promise<T>):Promise<T> {
 await lock(tx,`task-request:${scope}:${operation}:${key}`);
 const h=hash(canonical(input));const r=await tx.query('SELECT request_hash,response FROM task_requests WHERE scope=$1 AND operation=$2 AND key=$3',[scope,operation,key]);
 if(r.rows[0]){if(r.rows[0].request_hash!==h)throw new DomainError(409,'IDEMPOTENCY_CONFLICT');return r.rows[0].response as T;}
 const result=await fn();await tx.query('INSERT INTO task_requests(scope,operation,key,request_hash,response) VALUES($1,$2,$3,$4,$5)',[scope,operation,key,h,JSON.stringify(result)]);return result;
}
export class TaskService {
 constructor(readonly pool:pg.Pool, readonly billing?:BillingService){}
 async authorized(tx:pg.PoolClient,scope:Scope,id:string,locking=false) {
  await assertScope(tx,scope);
  const r=await tx.query<TaskRow>(`SELECT t.* FROM tasks t JOIN workspaces w ON w.id=t.workspace_id AND w.user_id=t.user_id WHERE t.id=$1 AND t.user_id=$2 AND w.state='ready' ${locking?'FOR UPDATE OF t':''}`,[id,scope.userId]);
  if(!r.rows[0])throw new DomainError(404,'TASK_NOT_FOUND');return r.rows[0];
 }
 async create(scope:Scope,input:{workspaceId:string;text:string},key:string) {
  return transaction(this.pool,async tx=>{
   await assertScope(tx,scope);
   const w=await tx.query("SELECT id FROM workspaces WHERE id=$1 AND user_id=$2 AND state='ready' FOR SHARE",[input.workspaceId,scope.userId]);if(!w.rowCount)throw new DomainError(404,'WORKSPACE_NOT_FOUND');
   return requestOnce(tx,`${scope.userId}:${input.workspaceId}`,'demo.create',key,input,async()=>{
    const id=randomUUID(),ref=randomUUID();
    await tx.query('INSERT INTO task_inputs(id,user_id,workspace_id,body) VALUES($1,$2,$3,$4)',[ref,scope.userId,input.workspaceId,input.text]);
    const r=await tx.query<TaskRow>("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,input_id,state) VALUES($1,$2,$3,'demo.digest','content',$4,'queued') RETURNING *",[id,scope.userId,input.workspaceId,ref]);
    if (this.billing) { await this.billing.assertCanRun(scope.userId,1n); const reservation=await this.billing.reserveCreditsTx(tx,{userId:scope.userId,reservationKey:`task:${id}`,requestedCredits:1n,taskId:id}); await tx.query('UPDATE tasks SET reservation_id=$2 WHERE id=$1',[id,reservation.reservationId]); }
    await enqueueIntent(tx,id);await event(tx,id);await audit(tx,scope,'task.create',id);return {task:taskDto(r.rows[0]!)};
   });
  });
 }
 async detail(scope:Scope,id:string){return transaction(this.pool,async tx=>{const t=await this.authorized(tx,scope,id);return {task:taskDto(t),retryActions:[{action:'runtime',title:'重试',allowed:t.state==='failed'&&t.retryable&&t.external_state==='none'&&t.attempt_no<9}]};});}
 async running(scope:Scope){return transaction(this.pool,async tx=>{await assertScope(tx,scope);const r=await tx.query<TaskRow>("SELECT t.* FROM tasks t JOIN workspaces w ON w.id=t.workspace_id WHERE t.user_id=$1 AND w.state='ready' AND t.state NOT IN ('succeeded','failed','cancelled') ORDER BY t.created_at LIMIT 100",[scope.userId]);return {items:r.rows.map(taskDto)};});}
 async events(scope:Scope,id:string,after:number,limit:number){return transaction(this.pool,async tx=>{await this.authorized(tx,scope,id);const r=await tx.query('SELECT sequence,state,created_at FROM task_events WHERE task_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3',[id,after,limit+1]);const items=r.rows.slice(0,limit).map(e=>({sequence:e.sequence,state:e.state,createdAt:e.created_at.toISOString()}));return {taskId:id,items,nextSequence:items.at(-1)?.sequence??after,hasMore:r.rows.length>limit};});}
 async result(scope:Scope,id:string){return transaction(this.pool,async tx=>{const t=await this.authorized(tx,scope,id);if(t.state!=='succeeded')throw new DomainError(409,'TASK_RESULT_NOT_READY');const r=await tx.query('SELECT id,digest,byte_count FROM task_results WHERE task_id=$1 AND id=$2',[id,t.result_id]);if(!r.rows[0])throw new DomainError(409,'TASK_RESULT_NOT_READY');return {taskId:id,resultId:r.rows[0].id,digest:r.rows[0].digest,byteCount:r.rows[0].byte_count};});}
 async mutate(scope:Scope,id:string,action:'cancel'|'retry',key:string,input:unknown){return transaction(this.pool,async tx=>{
  // Serialize idempotency before the task lock, consistently across all mutations.
  await assertScope(tx,scope);
  return requestOnce(tx,scope.userId,`task.${action}:${id}`,key,input,async()=>{
   const t=await this.authorized(tx,scope,id,true);await this.change(tx,t,action);await audit(tx,scope,`task.${action}`,id);
   const r=await tx.query<TaskRow>('SELECT * FROM tasks WHERE id=$1',[id]);return {task:taskDto(r.rows[0]!)};
  });
 });}
 async change(tx:pg.PoolClient,t:TaskRow,action:'cancel'|'retry') {
  if(action==='retry'){
   if(t.state!=='failed'||!t.retryable||t.external_state!=='none'||t.kind!=='demo.digest')throw new DomainError(409,'TASK_RETRY_NOT_ALLOWED');
   await tx.query("UPDATE tasks SET state='queued',version=version+1,max_attempts=LEAST(attempt_no+3,9),error_code=NULL,retryable=false,available_at=now() WHERE id=$1 AND attempt_no<9",[t.id]);
   // A bounded lifetime attempt budget prevents unlimited automated/admin retries.
   if(t.attempt_no>=9)throw new DomainError(409,'TASK_ATTEMPT_LIMIT');
   await enqueueIntent(tx,t.id);
  } else {
   if(terminal(t.state))return;
   const next=t.external_state!=='none'||t.state==='running'?'cancel_requested':'cancelled';
   await tx.query('UPDATE tasks SET state=$2,cancel_requested_at=now(),version=version+1,retryable=false WHERE id=$1',[t.id,next]);
  }
  await event(tx,t.id);
 }
 async adminDetail(scope:AdminScope,id:string){if(!scope.adminId)throw new DomainError(403,'ADMIN_FORBIDDEN');const r=await this.pool.query<TaskRow>('SELECT * FROM tasks WHERE id=$1',[id]);if(!r.rows[0])throw new DomainError(404,'TASK_NOT_FOUND');return {task:taskDto(r.rows[0])};}
 async adminRetry(scope:AdminScope,id:string,key:string,reason:string,trace:string){if(scope.role!=='superadmin')throw new DomainError(403,'ADMIN_FORBIDDEN');return transaction(this.pool,tx=>requestOnce(tx,scope.adminId,`admin.retry:${id}`,key,{reason},async()=>{
  const r=await tx.query<TaskRow>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[id]);if(!r.rows[0])throw new DomainError(404,'TASK_NOT_FOUND');await this.change(tx,r.rows[0],'retry');
  await tx.query('INSERT INTO admin_audit_events(id,admin_id,action,target_id,reason,trace_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),scope.adminId,'task.retry',id,reason,trace]);
  return {task:taskDto((await tx.query<TaskRow>('SELECT * FROM tasks WHERE id=$1',[id])).rows[0]!)};
 }));}
}
