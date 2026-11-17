import { withTraceId } from '../../lib/trace.js';
import { currentTelemetryFields, normalizeTraceContext, setCurrentSpanAttributes, tracedOperation, withTraceContext } from '../../observability/telemetry.js';
import type { Attempt } from './engine.js';

/** Correlation and task IDs belong in logs, never in metric labels or span names. */
export function taskLogFields(attempt:Attempt){
 return {taskId:attempt.task.id,kind:attempt.task.kind,queue:attempt.task.queue,attempt:attempt.attempt,
  traceId:attempt.task.trace_id,...currentTelemetryFields()};
}

/** Every delivery gets a child of the durable producer, including resumed work. */
export function withTaskTrace<T>(attempt:Attempt,operation:()=>Promise<T>):Promise<T>{
 return withTraceId(attempt.task.trace_id,()=>withTraceContext(normalizeTraceContext(attempt.task.trace_context),()=>
  tracedOperation('task.process',{'task.kind':attempt.task.kind,'task.queue':attempt.task.queue,
   'task.attempt':attempt.attempt,'task.resume_count':attempt.task.resume_count},async()=>{
    const result=await operation();setCurrentSpanAttributes({'task.result':attempt.stepOutcome??'stale'});return result;
   })));
}
