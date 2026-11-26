import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace';
import { ApplicationTelemetry, currentTelemetryFields, withTelemetryRuntime, withTraceContext } from '../../src/observability/telemetry.js';
import { withApplicationMetrics, type TaskMetrics } from '../../src/plugins/metrics.js';
import { transaction } from '../../src/modules/identity/store.js';
import { finalizeTaskTx, type TerminalOutcome } from '../../src/modules/tasks/lifecycle.js';
import { enqueueIntent, funAsrTaskKind, type TaskRow } from '../../src/modules/tasks/model.js';
import { TaskEngine, type Attempt } from '../../src/modules/tasks/engine.js';
import { taskLogFields, withTaskTrace } from '../../src/modules/tasks/observability.js';
import { TaskScheduler } from '../../src/modules/tasks/scheduler.js';
import { ParserExecutionDeferred } from '../../src/lib/document-parser-machine/index.js';
import type { RagIngestionJobs } from '../../src/modules/rag/jobs.js';

afterEach(()=>vi.useRealTimers());
const parent={traceparent:'00-1234567890abcdef1234567890abcdef-1234567890abcdef-01',tracestate:'fixture=accepted'};
function task():TaskRow{return {
 id:'12345678-1234-1234-1234-123456789abc',user_id:'user',workspace_id:'workspace',kind:'rag.document-ingest',queue:'content',input_id:null,
 state:'running',version:1,attempt_no:1,resume_count:0,max_attempts:3,lease_owner:'worker',reservation_id:null,
 trace_id:'original-correlation',trace_context:null,lease_until:new Date(Date.now()+60000),external_state:'none',result_id:null,
 error_code:null,retryable:false,event_sequence:0,created_at:new Date('2001-01-01'),updated_at:new Date(),
};}
function fixture(){
 const row=task(),recordTaskAttempt=vi.fn(),recordTaskTerminal=vi.fn(),metrics:TaskMetrics={recordTaskAttempt,recordTaskTerminal};
 let live=true,commitFails=false,updateMatches=true;
 const query=vi.fn(async(sql:string,_values?:unknown[])=>{
  void _values;
  if(sql==='COMMIT'&&commitFails)throw Error('COMMIT_FAILED');
  if(sql.includes('WITH locked AS MATERIALIZED'))return {rowCount:live?1:0,rows:live?[row]:[]};
  if(sql.includes('RETURNING extract(epoch'))return {rowCount:updateMatches?1:0,rows:updateMatches?[{elapsed_seconds:7.25}]:[]};
  if(sql.startsWith('UPDATE tasks SET event_sequence'))return {rowCount:1,rows:[{event_sequence:1,state:row.state,kind:row.kind}]};
  return {rowCount:1,rows:[]};
 });
 const release=vi.fn(),client=Object.assign(new EventEmitter(),{query,release}) as unknown as pg.PoolClient;
 const pool={connect:vi.fn(async()=>client),query} as unknown as pg.Pool;
 const attempt:Attempt={task:row,owner:'worker',version:1,attempt:1};
 return {row,query,pool,attempt,release,metrics,recordTaskAttempt,recordTaskTerminal,
  setLive:(value:boolean)=>{live=value;},failCommit:()=>{commitFails=true;},missUpdate:()=>{updateMatches=false;}};
}

describe('durable task trace metadata',()=>{
 it('captures only canonical W3C carrier in the existing outbox SQL, never correlation IDs',async()=>{
  const query=vi.fn(async()=>({rowCount:1,rows:[]})),tx={query} as unknown as pg.PoolClient;
  await withTraceContext({...parent,authorization:'private'},()=>enqueueIntent(tx,'task-id',123));
  expect(query).toHaveBeenCalledOnce();
  const [sql,values]=query.mock.calls[0] as unknown as [string,unknown[]];
  expect(sql).toContain('WITH producer_context AS');
  expect(sql).toContain('attempt_no=0 AND trace_context IS NULL');
  expect(sql).toContain('INSERT INTO task_outbox');
  expect(values.slice(1,3)).toEqual(['task-id',123]);
  expect(JSON.parse(String(values[3]))).toEqual(parent);
  await withTraceContext({traceparent:'invalid',tracestate:'private'},()=>enqueueIntent(tx,'legacy-id'));
  expect((query.mock.calls[1] as unknown as [string,unknown[]])[1][3]).toBeNull();
 });
 it('restores the producer after a restarted consumer and uses a new child for every retry',async()=>{
  const spans:ReadableSpan[]=[],exporter:SpanExporter={export(items,done){spans.push(...items);done({code:0});},shutdown:async()=>{},forceFlush:async()=>{}};
  const runtime=new ApplicationTelemetry({env:'test',service:'fixture',role:'worker',version:'fixture',service_instance_id:'worker-instance'},{exporter});
  try{
   const a:Attempt={task:{...task(),trace_context:JSON.parse(JSON.stringify(parent))},owner:'restarted-worker',version:2,attempt:2};
   const first=await withTelemetryRuntime(runtime,()=>withTaskTrace(a,async()=>taskLogFields(a)));
   const second=await withTelemetryRuntime(runtime,()=>withTaskTrace({...a,attempt:3},async()=>taskLogFields({...a,attempt:3})));
   expect(first).toMatchObject({taskId:a.task.id,kind:a.task.kind,queue:'content',attempt:2,traceId:'original-correlation',trace_id:'1234567890abcdef1234567890abcdef'});
   expect(first.span_id).toMatch(/^[a-f0-9]{16}$/);expect(second.span_id).not.toBe(first.span_id);
   expect(currentTelemetryFields()).toEqual({});
   await runtime.provider.forceFlush();
   expect(spans).toHaveLength(2);
   for(const span of spans){expect(span.name).toBe('task.process');expect(span.parentSpanContext?.spanId).toBe('1234567890abcdef');}
   expect(JSON.stringify(spans.map(span=>span.attributes))).not.toContain(a.task.id);
  }finally{await runtime.shutdown();}
 });
 it('starts an unparented trace for old NULL tasks instead of treating correlation as a span parent',async()=>{
  const a:Attempt={task:task(),owner:'worker',version:1,attempt:1};
  const result=await withTraceContext(parent,()=>withTaskTrace(a,async()=>taskLogFields(a)));
  expect(result.traceId).toBe('original-correlation');
  expect(result.trace_id).toMatch(/^[a-f0-9]{32}$/);
  expect(result.trace_id).not.toBe(parent.traceparent.split('-')[1]);
 });
});

describe('terminal observations follow the actual committed transition',()=>{
 it('delegates ASR failures so asset and allocation state can settle with the task',async()=>{
  const f=fixture();
  f.attempt.task.kind=funAsrTaskKind;
  const fail=vi.fn(async()=>true);
  const engine=new TaskEngine(f.pool,60000,undefined,undefined,undefined,undefined,undefined,undefined,undefined,f.metrics,
   {execute:async()=>false,fail});
  expect(await engine.fail(f.attempt,'TEMPORARY_PROVIDER_FAILURE',true)).toBe(true);
  expect(fail).toHaveBeenCalledExactlyOnceWith(f.attempt,'TEMPORARY_PROVIDER_FAILURE',true);
  expect(f.query).not.toHaveBeenCalled();
 });
 it.each<TerminalOutcome>([{state:'succeeded',resultId:'result'},{state:'failed',errorCode:'FAILED',retryable:false},{state:'cancelled'}])('counts $state after COMMIT using DB-returned duration',async outcome=>{
  const f=fixture();
  f.recordTaskTerminal.mockImplementation(()=>{expect(f.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');expect(f.release).toHaveBeenCalledOnce();});
  await withApplicationMetrics(f.metrics,()=>transaction(f.pool,async tx=>{
   await finalizeTaskTx(tx,f.row,outcome);expect(f.recordTaskTerminal).not.toHaveBeenCalled();
  }));
  expect(f.recordTaskTerminal).toHaveBeenCalledExactlyOnceWith(f.row.kind,outcome.state,7.25);
   const update=f.query.mock.calls.find(([sql])=>sql.includes('RETURNING extract(epoch'))?.[0];
  expect(update).toContain('clock_timestamp()-created_at');
  expect(f.query.mock.calls.filter(([sql])=>sql.trimStart().startsWith('SELECT')&&!sql.includes('pg_notify'))).toEqual([]);
 });
 it.each(['rollback','commit','stale'] as const)('does not count an uncommitted %s transition',async failure=>{
  const f=fixture();if(failure==='commit')f.failCommit();if(failure==='stale')f.missUpdate();
  await expect(withApplicationMetrics(f.metrics,()=>transaction(f.pool,async tx=>{
   await finalizeTaskTx(tx,f.row,{state:'cancelled'});if(failure==='rollback')throw Error('BUSINESS_ROLLBACK');
  }))).rejects.toThrow();
  expect(f.recordTaskTerminal).not.toHaveBeenCalled();
 });
 it('keeps the committed business result when the terminal observer fails',async()=>{
  const f=fixture();f.recordTaskTerminal.mockImplementation(()=>{throw Error('METRICS_FAILED');});
  await expect(withApplicationMetrics(f.metrics,()=>transaction(f.pool,async tx=>{await finalizeTaskTx(tx,f.row,{state:'cancelled'});return 'committed';}))).resolves.toBe('committed');
 });
 it('inherits background metrics through the restored trace and nested engine transaction',async()=>{
  const f=fixture();f.attempt.task.trace_context=parent;
  const engine=new TaskEngine(f.pool);
  await withApplicationMetrics(f.metrics,()=>withTaskTrace(f.attempt,async()=>{
   expect(await engine.finish(f.attempt,'committed',0)).toBe(true);
  }));
  expect(f.recordTaskTerminal).toHaveBeenCalledExactlyOnceWith(f.row.kind,'succeeded',7.25);
 });
 it('keeps a recorded attempt successful if either metric observer throws',async()=>{
  const f=fixture();f.recordTaskTerminal.mockImplementation(()=>{throw Error('TERMINAL_METRIC_FAILED');});
  f.recordTaskAttempt.mockImplementation(()=>{throw Error('ATTEMPT_METRIC_FAILED');});
  const engine=new TaskEngine(f.pool,60000,undefined,undefined,undefined,undefined,undefined,undefined,undefined,f.metrics);
  await expect(engine.finish(f.attempt,'committed',0)).resolves.toBe(true);expect(f.attempt.stepOutcome).toBe('recorded');
 });
 it('keeps attempt counters distinct from a deferred step and stale lease',async()=>{
  const f=fixture(),rag={execute:async()=>{throw new ParserExecutionDeferred('external',1000);}} as unknown as RagIngestionJobs;
  const engine=new TaskEngine(f.pool,60000,undefined,undefined,undefined,rag,undefined,undefined,undefined,f.metrics);
  expect(await engine.execute(f.attempt)).toBe(false);expect(f.attempt.stepOutcome).toBe('deferred');
  expect(f.recordTaskAttempt).not.toHaveBeenCalled();expect(f.recordTaskTerminal).not.toHaveBeenCalled();
  f.setLive(false);expect(await engine.finish(f.attempt,'late',0)).toBe(false);expect(f.attempt.stepOutcome).toBe('stale');
  expect(f.recordTaskAttempt).not.toHaveBeenCalled();expect(f.recordTaskTerminal).not.toHaveBeenCalled();
 });
 it('records a retry attempt without calling it a terminal failure',async()=>{
  const f=fixture(),engine=new TaskEngine(f.pool,60000,undefined,undefined,undefined,undefined,undefined,undefined,undefined,f.metrics);
  expect(await engine.fail(f.attempt,'TEMPORARY',true)).toBe(true);expect(f.attempt.stepOutcome).toBe('retry_scheduled');
  expect(f.recordTaskAttempt).toHaveBeenCalledExactlyOnceWith(f.row.kind,'failure');expect(f.recordTaskTerminal).not.toHaveBeenCalled();
 });
});

it('reuses one low-frequency backlog query and clears empty queue gauges',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-17'));
 const query=vi.fn().mockResolvedValueOnce({rows:[{count:2,age:30,queues:[{queue:'content',pendingCount:3,oldestWaitingSeconds:12.5}]}]})
  .mockResolvedValueOnce({rows:[{count:0,age:0,queues:[]}]});
 const observeTaskBacklog=vi.fn(),scheduler=new TaskScheduler({query} as unknown as pg.Pool,{publish:async()=>{}},'owner',30000,{recordTaskAttempt:vi.fn(),observeTaskBacklog});
 expect((await scheduler.backlog()).queues.find(row=>row.queue==='content')).toMatchObject({pendingCount:3,oldestWaitingSeconds:12.5});
 await scheduler.backlog();expect(query).toHaveBeenCalledOnce();expect(observeTaskBacklog).toHaveBeenCalledTimes(4);
 await vi.advanceTimersByTimeAsync(10000);await scheduler.backlog();expect(query).toHaveBeenCalledTimes(2);
 expect(observeTaskBacklog).toHaveBeenLastCalledWith('maintenance',{queue:'maintenance',pendingCount:0,oldestWaitingSeconds:0});
 expect(observeTaskBacklog).toHaveBeenCalledWith('content',{queue:'content',pendingCount:0,oldestWaitingSeconds:0});
 const sql=query.mock.calls[0]?.[0] as string;expect(sql).toContain("state IN ('queued','retry_scheduled') AND available_at<=now()");expect(sql).toContain('GROUP BY queue');
});
