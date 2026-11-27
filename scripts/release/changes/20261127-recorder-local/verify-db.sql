WITH expected_indexes(table_name, index_name) AS (
  VALUES ('content_jobs', 'content_jobs_content_asset_idx'),
         ('recorder_bindings', 'recorder_bindings_active_device'),
         ('recorder_bindings', 'recorder_bindings_active_user'),
         ('recorder_bindings', 'recorder_bindings_user_device_history'),
         ('content_assets', 'content_assets_recorder_source'),
         ('content_assets', 'content_assets_recorder_list'),
         ('tasks', 'tasks_recording_outline_input'),
         ('funasr_jobs', 'funasr_jobs_active_input'),
         ('funasr_jobs', 'funasr_jobs_input_history'),
         ('funasr_jobs', 'funasr_jobs_allocation'),
         ('funasr_allocations', 'funasr_allocations_active'),
         ('funasr_allocations', 'funasr_allocations_releasing'),
         ('funasr_transcript_edits', 'funasr_transcript_edits_pkey'),
         ('content_asset_audio_transcripts', 'content_asset_audio_transcripts_pkey'),
         ('content_asset_audio_transcripts', 'content_asset_audio_transcripts_transcription_id_key')
), expected_roles(table_name, role_name, allow_access) AS (
  VALUES ('recorder_bindings', 'huahuo_api', true),
         ('recorder_bindings', 'huahuo_worker', false),
         ('recorder_bindings', 'huahuo_admin', false),
         ('recorder_bindings', 'huahuo_scheduler', false),
         ('funasr_jobs', 'huahuo_api', true),
         ('funasr_jobs', 'huahuo_worker', true),
         ('funasr_jobs', 'huahuo_admin', false),
         ('funasr_jobs', 'huahuo_scheduler', false),
         ('funasr_allocations', 'huahuo_worker', true),
         ('funasr_allocations', 'huahuo_api', false),
         ('funasr_allocations', 'huahuo_admin', false),
         ('funasr_allocations', 'huahuo_scheduler', false),
         ('funasr_transcript_edits', 'huahuo_api', true),
         ('funasr_transcript_edits', 'huahuo_worker', false),
         ('funasr_transcript_edits', 'huahuo_admin', false),
         ('funasr_transcript_edits', 'huahuo_scheduler', false),
         ('content_asset_audio_transcripts', 'huahuo_api', true),
         ('content_asset_audio_transcripts', 'huahuo_worker', true),
         ('content_asset_audio_transcripts', 'huahuo_admin', false),
         ('content_asset_audio_transcripts', 'huahuo_scheduler', false)
)
SELECT 'link_import_uses_asset_results' AS check_name,
  to_regclass('public.link_extraction_jobs') IS NULL AND
  has_column_privilege('huahuo_worker','public.content_jobs','source_platform','INSERT') AND
  has_column_privilege('huahuo_api','public.content_jobs','source_content_type','SELECT') AS ok
UNION ALL
SELECT 'asr_tasks_account_scoped' AS check_name, EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid='public.tasks'::regclass AND conname='tasks_check' AND convalidated
    AND pg_get_constraintdef(oid) LIKE '%''content-asset.link-extract''::text%'
    AND pg_get_constraintdef(oid) LIKE '%''content-asset.transcribe''::text%'
    AND pg_get_constraintdef(oid) LIKE '%''content-asset.recording-outline''::text%'
) AS ok
UNION ALL
SELECT 'recorder_and_asr_lookup_indexes_ready', NOT EXISTS (
  SELECT 1 FROM expected_indexes e
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid=to_regclass('public.' || e.table_name)
      AND i.indexrelid=to_regclass('public.' || e.index_name)
      AND i.indisvalid AND i.indisready
  )
)
UNION ALL
SELECT 'asr_runtime_table_permissions', NOT EXISTS (
  SELECT 1 FROM expected_roles e
  CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE')) AS p(permission)
  WHERE has_table_privilege(e.role_name, 'public.' || e.table_name, p.permission) IS DISTINCT FROM e.allow_access
    OR has_table_privilege(e.role_name, 'public.' || e.table_name, 'DELETE, TRUNCATE')
)
UNION ALL
SELECT 'asr_worker_can_enqueue_asset_tags',
  has_table_privilege('huahuo_worker', 'public.task_inputs', 'INSERT')
UNION ALL
SELECT 'outline_worker_can_read_templates_and_store_results',
  has_table_privilege('huahuo_worker', 'public.ai_template_published', 'SELECT') AND
  NOT EXISTS (SELECT FROM (VALUES ('scene_key'),('revision'),('catalog')) c(col)
    WHERE NOT has_column_privilege('huahuo_worker', 'public.ai_template_versions', c.col, 'SELECT')) AND
  NOT EXISTS (SELECT FROM (VALUES ('SELECT'),('INSERT'),('UPDATE')) p(priv)
    WHERE NOT has_table_privilege('huahuo_worker', 'public.ai_template_runs', p.priv));
