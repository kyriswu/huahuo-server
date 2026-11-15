-- A single read-only SELECT, evaluated separately as migrate and each runtime role.
-- Generic history/checksum and zero-foreign-key assertions run in the gate too.
SELECT 'migration_history_readable' AS check_name,
       has_table_privilege(current_user, 'public.schema_migrations', 'SELECT') AS ok
UNION ALL
SELECT 'runtime_configuration_readable',
       has_table_privilege(current_user, 'public.runtime_configuration', 'SELECT')
UNION ALL
SELECT 'runtime_configuration_present',
       EXISTS (SELECT 1 FROM public.runtime_configuration WHERE singleton=true)
UNION ALL
SELECT 'task_resume_count_contract', EXISTS (
  SELECT 1 FROM pg_attribute
  WHERE attrelid='public.tasks'::regclass AND attname='resume_count'
    AND atttypid='integer'::regtype AND attnotnull AND NOT attisdropped
)
UNION ALL
SELECT 'task_owner_lookup_index', EXISTS (
  SELECT 1 FROM pg_index
  WHERE indexrelid=to_regclass('public.tasks_scope') AND indisvalid AND indisready
)
UNION ALL
SELECT 'deployment_drain_budget', EXISTS (
  SELECT 1 FROM public.runtime_configuration
  WHERE singleton=true
    AND jsonb_typeof("values"->'deployment.drainTimeoutMs')='number'
    AND ("values"->>'deployment.drainTimeoutMs')::numeric BETWEEN 600000 AND 3600000
    AND mod(("values"->>'deployment.drainTimeoutMs')::numeric,1)=0
);
