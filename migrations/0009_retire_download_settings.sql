-- Remove configuration for the retired Server-side source downloader.
-- Bounded inline change: runtime_configuration is a singleton. Keep all other
-- settings and audit ownership; increment its revision so stale Admin edits fail.
-- Old writers are drained before this incompatible release. No runtime aliases.
-- The runner owns the transaction, lock/statement budgets and failure rollback.
UPDATE public.runtime_configuration
SET "values"="values"-'storage.maxSourceBytes'-'tasks.downloadTimeoutMs',
  revision=revision+1,updated_at=now()
WHERE singleton=true AND "values" ?| ARRAY['storage.maxSourceBytes','tasks.downloadTimeoutMs'];
