-- Add one optional runtime setting; old readers preserve unknown optional keys.
-- Bounded inline data change: at most the existing singleton row. Preserve any
-- operator-supplied value. The migration runner owns the transaction and timeout.
UPDATE public.runtime_configuration
SET "values" = "values" || '{"deployment.drainTimeoutMs":600000}'::jsonb,
    revision = revision + 1,
    updated_at = now()
WHERE singleton = true AND NOT ("values" ? 'deployment.drainTimeoutMs');
