import type pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import {currentRuntimeConfig} from '../runtime-settings/service.js';
import { captureTraceContext, normalizeTraceContext, type TraceCarrier } from '../../observability/telemetry.js';
export const queues = ['content','ai','commercial','maintenance'] as const;
export type QueueName = typeof queues[number];
export type TaskState = 'queued'|'running'|'retry_scheduled'|'waiting_external'|'reconciling'|'cancel_requested'|'succeeded'|'failed'|'cancelled';
export interface TaskRow {
 id:string; user_id:string|null; workspace_id:string|null; kind:string; queue:QueueName; input_id:string|null;
 state:TaskState; version:number; attempt_no:number; resume_count:number;max_attempts:number; lease_owner:string|null;
 reservation_id:string|null;trace_id:string;trace_context:TraceCarrier|null;
 lease_until:Date|null; external_state:'none'|'submitted'|'unknown'; result_id:string|null;
 external_reference?:string|null; cancel_requested_at?:Date|null;
 error_code:string|null; retryable:boolean; event_sequence:number; created_at:Date; updated_at:Date;
}
export const terminal = (s:TaskState) => ['succeeded','failed','cancelled'].includes(s);
export const funAsrTaskKind = 'content-asset.transcribe';
export const funAsrTaskReference = (taskId:string) => 'funasr:'+taskId;
export const isFunAsrTask = (t:TaskRow) => t.kind===funAsrTaskKind&&t.external_reference===funAsrTaskReference(t.id);
// Capture policy only on INSERT; redelivery must preserve the task's original limit.
export const newTaskMaxAttempts = () => currentRuntimeConfig()?.taskPolicy.maxAttempts ?? 3;
export const retryDelay = (attempt:number, random=Math.random) => {const p=currentRuntimeConfig()?.taskPolicy;return Math.min(p?.retryMaxMs??60000,(p?.retryBaseMs??1000)*2**Math.min(attempt,20))*(0.75+random()*0.5);};
export const hash = (text:string) => createHash('sha256').update(text).digest('hex');
export function parserRequestId(reference:unknown):string|undefined{
 if(typeof reference!=='string')return;
 const match=/^xberg-(?:bound|job|cancelling):([A-Za-z0-9_-]+)$/.exec(reference);
 try{const id=match?JSON.parse(Buffer.from(match[1]!,'base64url').toString()).requestId:undefined;return typeof id==='string'?id:undefined;}catch{return;}
}
export async function event(tx:pg.PoolClient,id:string) {
 const r=await tx.query('UPDATE tasks SET event_sequence=event_sequence+1,updated_at=now() WHERE id=$1 RETURNING event_sequence,state,kind,external_reference',[id]);
 if(r.rows[0])await tx.query('INSERT INTO task_events(task_id,sequence,state) VALUES($1,$2,$3)',[id,r.rows[0].event_sequence,r.rows[0].state]);
 if(r.rows[0])await tx.query("SELECT pg_notify('task_events',$1)",[id]);
 if(r.rows[0]?.kind==='processing.node-start'&&r.rows[0].external_reference?.startsWith('node-start:'))await tx.query("SELECT pg_notify('processing_node_events',$1)",[r.rows[0].external_reference.slice('node-start:'.length)]);
}
export async function enqueueIntent(tx:pg.PoolClient,id:string,delayMs=0) {
 const carrier=normalizeTraceContext(captureTraceContext());
 await tx.query(`WITH producer_context AS (
   UPDATE tasks SET trace_context=$4::jsonb
   WHERE id=$2 AND attempt_no=0 AND trace_context IS NULL AND $4::jsonb IS NOT NULL
   RETURNING id
  ) INSERT INTO task_outbox(id,task_id,available_at) VALUES($1,$2,now()+$3*interval '1 millisecond')
  ON CONFLICT(task_id) WHERE status IN ('pending','delivering') DO UPDATE SET available_at=least(task_outbox.available_at,excluded.available_at)`,[randomUUID(),id,delayMs,carrier.traceparent?JSON.stringify(carrier):null]);
}
export const accountAssetTaskKinds = ['content-asset.tag-extract','kb.content-asset-index','kb.content-asset-cleanup',funAsrTaskKind];
export function taskDto(t:TaskRow) {
 return {taskId:t.id,taskType:t.kind,state:t.state,...(accountAssetTaskKinds.includes(t.kind)?{}:{workspaceId:t.workspace_id}),version:t.version,
  attempt:t.attempt_no-t.resume_count,resultId:t.result_id,createdAt:t.created_at.toISOString(),updatedAt:t.updated_at.toISOString(),
  ...(t.error_code||t.state==='cancelled'?{error:{code:t.error_code??'TASK_CANCELLED',userMessage:t.state==='cancelled'?'任务已取消':'任务暂未完成',retryable:t.retryable}}:{})};
}
