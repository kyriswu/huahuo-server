SELECT 'task_trace_context_nullable'::text AS check_name,
       EXISTS (SELECT 1 FROM pg_attribute
               WHERE attrelid='public.tasks'::regclass AND attname='trace_context'
                 AND atttypid='jsonb'::regtype AND NOT attnotnull AND NOT attisdropped) AS ok
UNION ALL
SELECT 'task_trace_context_check',
       EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.tasks'::regclass
               AND conname='tasks_trace_context_check' AND contype='c' AND convalidated)
UNION ALL
SELECT 'task_identity_lookup_index',
       EXISTS (SELECT 1 FROM pg_index WHERE indrelid='public.tasks'::regclass
               AND indisprimary AND indisvalid AND indisready)
UNION ALL
SELECT 'task_trace_context_access',
       has_column_privilege(current_user, 'public.tasks', 'trace_context', 'SELECT')
       AND has_column_privilege(current_user, 'public.tasks', 'trace_context', 'UPDATE');
