SELECT 'account_asset_schema' AS check_name,
  to_regclass('public.content_asset_workspaces') IS NULL
  AND to_regclass('public.account_content_state') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND column_name='workspace_id'
      AND table_name IN ('content_assets','content_asset_parts','content_asset_resource_refs',
        'asset_tags','asset_folders','content_asset_relations','content_asset_tag_suggestions',
        'content_events','account_content_state','ai_template_runs','kb_content_asset_hybrid_builds')
  ) AS ok
UNION ALL
SELECT 'account_assets_index', EXISTS (
  SELECT 1 FROM pg_index WHERE indexrelid='public.kb_content_asset_hybrid_builds_owner'::regclass AND indisvalid AND indisready
)
UNION ALL
SELECT 'account_build_snapshots', NOT EXISTS (
  SELECT 1 FROM public.kb_content_asset_hybrid_builds
  WHERE snapshot->>'accountScope' IS DISTINCT FROM 'true'
    OR right(snapshot #>> '{target,collection}',11) IS DISTINCT FROM '_account_v1'
)
UNION ALL
SELECT 'account_asset_tasks', NOT EXISTS (
  SELECT 1 FROM public.tasks WHERE kind IN ('content-asset.tag-extract','kb.content-asset-index','kb.content-asset-cleanup')
  AND (user_id IS NULL OR workspace_id IS NOT NULL)
);
