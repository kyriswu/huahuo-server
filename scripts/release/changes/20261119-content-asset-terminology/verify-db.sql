SELECT 'content_asset_owner'::text AS check_name,
  to_regclass('public.notes') IS NULL
  AND EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid='public.content_assets'::regclass AND attname='user_id'
      AND atttypid='uuid'::regtype AND attnotnull AND NOT attisdropped
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid='public.content_assets'::regclass
      AND attname IN ('workspace_id','folder_id','deleted_by_folder_id','note_id') AND NOT attisdropped
  ) AS ok
UNION ALL
SELECT 'content_asset_relations', to_regclass('public.content_asset_parts') IS NOT NULL
  AND to_regclass('public.content_asset_resource_refs') IS NOT NULL
  AND to_regclass('public.content_asset_relations') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid='public.content_asset_folders'::regclass AND attname='deleted_by_folder_id' AND NOT attisdropped
  )
UNION ALL
SELECT 'content_asset_membership_indexes', (
  SELECT count(*)=4 FROM pg_index
  WHERE indexrelid IN (
    'public.content_asset_folders_pkey'::regclass,
    'public.content_asset_workspaces_pkey'::regclass,
    'public.content_asset_folders_content_asset_id_idx'::regclass,
    'public.content_asset_workspaces_content_asset_id_idx'::regclass
  ) AND indisvalid AND indisready
)
UNION ALL
SELECT 'content_asset_membership_access',
  has_table_privilege(current_user,'public.content_asset_folders','SELECT')
  AND has_table_privilege(current_user,'public.content_asset_workspaces','SELECT')
UNION ALL
SELECT 'content_asset_runtime_keys', EXISTS (
  SELECT 1 FROM public.runtime_configuration
  WHERE singleton=true AND jsonb_typeof("values")='object'
    AND NOT ("values" ?| ARRAY['features.noteIndexing','rag.noteRerankBudgetMs'])
)
UNION ALL
SELECT 'content_asset_search_schema',
  to_regclass('public.kb_content_asset_hybrid_builds') IS NOT NULL
  AND to_regclass('public.kb_content_asset_hybrid_chunks') IS NOT NULL
  AND to_regclass('public.kb_note_hybrid_builds') IS NULL
UNION ALL
SELECT 'content_asset_ai_schema', EXISTS (
  SELECT 1 FROM pg_attribute
  WHERE attrelid='public.ai_template_runs'::regclass AND attname='content_asset_id' AND NOT attisdropped
)
UNION ALL
SELECT 'search_snapshot_names', NOT EXISTS (
  SELECT 1 FROM public.kb_content_asset_hybrid_builds
  WHERE snapshot #>> '{target,collection}' = 'huahuo_kb_note_hybrid_chunks'
     OR snapshot #>> '{mode}' IN ('content-asset-hybrid','note-hybrid')
) AND NOT EXISTS (
  SELECT 1 FROM public.kb_document_keyword_builds
  WHERE snapshot #>> '{mode}' = 'document-keyword'
) AND NOT EXISTS (
  SELECT 1 FROM public.rag_ingestion_versions
  WHERE processing_snapshot #>> '{keyword,mode}' = 'document-keyword'
)
UNION ALL
SELECT 'content_asset_catalog_names', NOT EXISTS (
  SELECT 1 FROM (
    SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace='public'::regnamespace
    UNION ALL
    SELECT c.conname FROM pg_constraint c WHERE c.connamespace='public'::regnamespace
    UNION ALL
    SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      WHERE c.relnamespace='public'::regnamespace AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL
    SELECT p.proname FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
    UNION ALL
    SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal
  ) AS objects
  WHERE name ~* '(^|_)(note|notes|hnote)(_|$)'
);
