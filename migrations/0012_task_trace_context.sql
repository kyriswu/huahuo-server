-- Persist only producer W3C trace metadata across task retries and process restarts.
-- Additive nullable column: existing tasks remain NULL; no historical data backfill.
-- Existing table-level task grants include this column. No relation or lookup index
-- is needed: workers already load their task by its primary key.
-- The runner owns the transaction and bounded DDL lock/statement timeouts.
ALTER TABLE public.tasks ADD COLUMN trace_context jsonb;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_trace_context_check CHECK (
 trace_context IS NULL OR (
  jsonb_typeof(trace_context)='object'
  AND trace_context-'traceparent'-'tracestate'='{}'::jsonb
  AND trace_context?'traceparent'
  AND jsonb_typeof(trace_context->'traceparent')='string'
  AND length(trace_context->>'traceparent')=55
  AND (NOT (trace_context?'tracestate') OR (
   jsonb_typeof(trace_context->'tracestate')='string'
   AND length(trace_context->>'tracestate') BETWEEN 1 AND 512
  ))
 )
);
