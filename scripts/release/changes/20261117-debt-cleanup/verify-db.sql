SELECT 'node_flag_removed'::text AS check_name,
 NOT EXISTS(SELECT 1 FROM public.processing_nodes WHERE config ? 'enabled')
 AND NOT EXISTS(SELECT 1 FROM public.processing_node_assignments WHERE snapshot ? 'enabled') AS ok
UNION ALL SELECT 'node_config_constraint', EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.processing_nodes'::regclass AND conname='processing_nodes_config_shape' AND contype='c' AND convalidated)
UNION ALL SELECT 'folder_deletion_provenance', (SELECT count(*)=2 FROM pg_attribute WHERE attrelid IN ('public.notes'::regclass,'public.asset_folders'::regclass) AND attname='deleted_by_folder_id' AND atttypid='uuid'::regtype AND NOT attnotnull AND NOT attisdropped)
UNION ALL SELECT 'folder_deletion_indexes', (SELECT count(*)=2 FROM pg_index WHERE indexrelid IN ('public.notes_deletion_origin_idx'::regclass,'public.asset_folders_deletion_origin_idx'::regclass) AND indisvalid AND indisready)
UNION ALL SELECT 'runtime_current_keys', EXISTS(SELECT 1 FROM public.runtime_configuration WHERE singleton=true AND jsonb_typeof("values")='object') AND NOT EXISTS(SELECT 1 FROM public.runtime_configuration, jsonb_object_keys("values") k WHERE k NOT IN ('deployment.drainTimeoutMs','rag.denseCandidates','rag.bm25Candidates','rag.hybridCandidates','rag.rrfK','rag.searchConcurrency','rag.embeddingBatchSize','rag.indexConcurrency','rag.embeddingTimeoutMs','rag.embeddingMaxRetries','rag.rerankTimeoutMs','rag.noteRerankBudgetMs','rag.plainTextMaxChars','tasks.maxAttempts','tasks.retryBaseMs','tasks.retryMaxMs','tasks.concurrency.content','tasks.concurrency.ai','tasks.concurrency.commercial','tasks.concurrency.maintenance','storage.maxUploadBytes','storage.quotaBytes','billing.policyVersion','features.documentIngestion','features.noteIndexing','features.tagProvider'))
UNION ALL SELECT 'runtime_primary_index', EXISTS(SELECT 1 FROM pg_index WHERE indrelid='public.runtime_configuration'::regclass AND indisprimary AND indisvalid AND indisready)
UNION ALL SELECT 'runtime_select_access', has_table_privilege(current_user,'public.runtime_configuration','SELECT')
UNION ALL SELECT 'runtime_admin_update', current_user<>'huahuo_admin' OR has_table_privilege(current_user,'public.runtime_configuration','UPDATE')
UNION ALL SELECT 'folder_provenance_access', has_column_privilege(current_user,'public.notes','deleted_by_folder_id','SELECT') AND has_column_privilege(current_user,'public.asset_folders','deleted_by_folder_id','SELECT')
UNION ALL SELECT 'ai_templates_schema', to_regclass('public.ai_template_scenes') IS NOT NULL AND to_regclass('public.ai_template_versions') IS NOT NULL AND to_regclass('public.ai_template_runs') IS NOT NULL AND to_regclass('public.ai_template_published') IS NOT NULL
UNION ALL SELECT 'bearer_auth_cache_events', (
  SELECT count(*)=4 FROM pg_trigger
  WHERE NOT tgisinternal AND tgenabled='O'
    AND tgfoid='public.notify_bearer_auth_cache_change()'::regprocedure
    AND ((tgrelid='public.users'::regclass AND tgname IN ('users_bearer_auth_cache_status','users_bearer_auth_cache_delete'))
      OR (tgrelid='public.user_sessions'::regclass AND tgname IN ('sessions_bearer_auth_cache_status','sessions_bearer_auth_cache_delete')))
)
UNION ALL SELECT 'no_physical_foreign_keys', NOT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.contype='f');
