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
);
