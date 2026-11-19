-- Replace implicit version/unknown-field compatibility with the current registry.
-- Bounded inline change: runtime_configuration contains one singleton row. Lock it
-- before checking; preserve current settings, revision CAS and role grants.
-- Unknown keys/versions require review: never drop arbitrary persisted data.
-- The migration runner owns the transaction and lock/statement time budgets.
DO $migration$
DECLARE
  stored jsonb;
  allowed_keys text[] := ARRAY[
    'deployment.drainTimeoutMs',
    'rag.denseCandidates','rag.bm25Candidates','rag.hybridCandidates','rag.rrfK',
    'rag.searchConcurrency','rag.embeddingBatchSize','rag.indexConcurrency',
    'rag.embeddingTimeoutMs','rag.embeddingMaxRetries','rag.rerankTimeoutMs',
    'rag.noteRerankBudgetMs','rag.plainTextMaxChars',
    'tasks.maxAttempts','tasks.retryBaseMs','tasks.retryMaxMs',
    'tasks.concurrency.content','tasks.concurrency.ai','tasks.concurrency.commercial','tasks.concurrency.maintenance',
    'storage.maxUploadBytes','storage.quotaBytes','billing.policyVersion',
    'features.documentIngestion','features.noteIndexing','features.tagProvider',
    '$schemaVersion','storage.maxSourceBytes','tasks.downloadTimeoutMs'
  ];
BEGIN
  SELECT "values" INTO stored FROM public.runtime_configuration WHERE singleton=true FOR UPDATE;
  IF NOT FOUND OR jsonb_typeof(stored) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'RUNTIME_CONFIGURATION_INVALID';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(stored) AS fields(key) WHERE NOT (key=ANY(allowed_keys))) THEN
    RAISE EXCEPTION 'RUNTIME_CONFIGURATION_UNKNOWN_KEY_REVIEW_REQUIRED';
  END IF;
  IF stored ? '$schemaVersion' AND stored->'$schemaVersion' IS DISTINCT FROM '1'::jsonb THEN
    RAISE EXCEPTION 'RUNTIME_CONFIGURATION_VERSION_REVIEW_REQUIRED';
  END IF;
  UPDATE public.runtime_configuration
    SET "values"="values"-'$schemaVersion'-'storage.maxSourceBytes'-'tasks.downloadTimeoutMs',
        revision=revision+1,updated_at=now()
    WHERE singleton=true AND "values" ?| ARRAY['$schemaVersion','storage.maxSourceBytes','tasks.downloadTimeoutMs'];
END
$migration$;
