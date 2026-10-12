import type pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
export const queues = ['content','ai','commercial','maintenance'] as const;
export type QueueName = typeof queues[number];
export type TaskState = 'queued'|'running'|'retry_scheduled'|'waiting_external'|'reconciling'|'cancel_requested'|'succeeded'|'failed'|'cancelled';
export interface TaskRow {
 id:string; user_id:string|null; workspace_id:string|null; kind:string; queue:QueueName; input_id:string|null;
 state:TaskState; version:number; attempt_no:number; max_attempts:number; lease_owner:string|null;
 reservation_id:string|null;
 lease_until:Date|null; external_state:'none'|'submitted'|'unknown'; result_id:string|null;
 error_code:string|null; retryable:boolean; event_sequence:number; created_at:Date; updated_at:Date;
}
export const terminal = (s:TaskState) => ['succeeded','failed','cancelled'].includes(s);
export const retryDelay = (attempt:number, random=Math.random) => Math.min(60000,1000*2**Math.min(attempt,6))*(0.75+random()*0.5);
export const hash = (text:string) => createHash('sha256').update(text).digest('hex');
export async function event(tx:pg.PoolClient,id:string) {
 const r=await tx.query('UPDATE tasks SET event_sequence=event_sequence+1,updated_at=now() WHERE id=$1 RETURNING event_sequence,state',[id]);
 if(r.rows[0])await tx.query('INSERT INTO task_events(task_id,sequence,state) VALUES($1,$2,$3)',[id,r.rows[0].event_sequence,r.rows[0].state]);
}
export async function enqueueIntent(tx:pg.PoolClient,id:string,delayMs=0) {
 await tx.query("INSERT INTO task_outbox(id,task_id,available_at) VALUES($1,$2,now()+$3*interval '1 millisecond') ON CONFLICT DO NOTHING",[randomUUID(),id,delayMs]);
}
// WorkAiTaskInfo only treats succeeded/failed as terminal. Preserve raw state separately.
export function taskDto(t:TaskRow) {
 const status=t.state==='cancelled'?'failed':t.state==='retry_scheduled'?'queued':['waiting_external','reconciling','cancel_requested'].includes(t.state)?'running':t.state;
 return {taskId:t.id,taskType:t.kind,status,state:t.state,workspaceId:t.workspace_id,version:t.version,
  attempt:t.attempt_no,resultId:t.result_id,createdAt:t.created_at.toISOString(),updatedAt:t.updated_at.toISOString(),
  ...(t.error_code||t.state==='cancelled'?{error:{code:t.error_code??'TASK_CANCELLED',userMessage:t.state==='cancelled'?'任务已取消':'任务暂未完成',retryable:t.retryable}}:{})};
}
