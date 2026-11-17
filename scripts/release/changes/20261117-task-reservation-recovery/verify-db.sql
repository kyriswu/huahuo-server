SELECT 'scheduler_can_release_task_reservations' AS check_name,
  has_column_privilege('huahuo_scheduler','public.credit_reservations','status','UPDATE')
  AND has_column_privilege('huahuo_scheduler','public.credit_reservations','updated_at','UPDATE')
  AND has_column_privilege('huahuo_scheduler','public.credit_lots','available_credits','UPDATE')
  AND has_column_privilege('huahuo_scheduler','public.credit_lots','reserved_credits','UPDATE')
  AND has_column_privilege('huahuo_scheduler','public.credit_ledger_entries','entry_id','INSERT')
  AND has_column_privilege('huahuo_scheduler','public.credit_ledger_entries','user_id','INSERT')
  AND has_column_privilege('huahuo_scheduler','public.credit_ledger_entries','reservation_id','INSERT')
  AND has_column_privilege('huahuo_scheduler','public.credit_ledger_entries','lot_id','INSERT')
  AND has_column_privilege('huahuo_scheduler','public.credit_ledger_entries','entry_type','INSERT')
  AND has_column_privilege('huahuo_scheduler','public.credit_ledger_entries','credits','INSERT') AS ok
UNION ALL
SELECT 'scheduler_cannot_create_or_settle_credits',
  NOT has_table_privilege('huahuo_scheduler','public.credit_lots','INSERT')
  AND NOT has_table_privilege('huahuo_scheduler','public.credit_reservations','INSERT')
  AND NOT has_table_privilege('huahuo_scheduler','public.account_memberships','INSERT')
  AND NOT has_column_privilege('huahuo_scheduler','public.credit_lots','granted_credits','UPDATE')
  AND NOT has_column_privilege('huahuo_scheduler','public.credit_lots','settled_credits','UPDATE')
UNION ALL
SELECT 'reservation_task_lookup_index', EXISTS (
  SELECT 1 FROM pg_index i JOIN pg_attribute a
    ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
  WHERE i.indrelid='public.credit_reservations'::regclass AND i.indisvalid AND a.attname='task_id'
)
UNION ALL
SELECT 'task_trace_id_column', EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='tasks' AND column_name='trace_id'
    AND data_type='text' AND is_nullable='NO' AND column_default IS NULL
)
UNION ALL
SELECT 'task_trace_id_role_access',
  has_column_privilege('huahuo_api','public.tasks','trace_id','UPDATE')
  AND has_column_privilege('huahuo_admin','public.tasks','trace_id','UPDATE')
  AND has_column_privilege('huahuo_worker','public.tasks','trace_id','UPDATE')
  AND has_column_privilege('huahuo_scheduler','public.tasks','trace_id','UPDATE')
UNION ALL
SELECT 'resource_measured_hash_nullable', EXISTS (
  SELECT 1 FROM pg_attribute WHERE attrelid='public.resources'::regclass
    AND attname='sha256' AND NOT attnotnull AND NOT attisdropped
)
UNION ALL
SELECT 'removed_inspection_jobs_retired', NOT EXISTS (
  SELECT 1 FROM tasks WHERE kind='storage.inspect' AND state NOT IN ('succeeded','failed','cancelled')
) AND NOT EXISTS (
  SELECT 1 FROM task_outbox o JOIN tasks t ON t.id=o.task_id
    WHERE t.kind='storage.inspect' AND o.status IN ('pending','delivering')
)
UNION ALL
SELECT 'resource_processing_state_removed', NOT EXISTS (
 SELECT 1 FROM pg_attribute WHERE attrelid='public.resources'::regclass AND attname='processing_status' AND NOT attisdropped
)
UNION ALL
SELECT 'generic_upload_business_fields_removed', NOT EXISTS (
  SELECT 1 FROM pg_attribute WHERE NOT attisdropped AND attrelid='public.resources'::regclass
    AND attname IN ('source_scene','duration_seconds')
)
UNION ALL
SELECT 'temporary_uploads_not_stored_in_postgres', to_regclass('public.upload_sessions') IS NULL
UNION ALL
SELECT 'claimed_resource_role_access',
  has_column_privilege('huahuo_api','public.resources','resource_id','INSERT')
  AND has_column_privilege('huahuo_api','public.storage_reservations','confirmed_bytes','INSERT')
  AND has_column_privilege('huahuo_worker','public.resources','status','UPDATE')
UNION ALL
SELECT 'claimed_resource_owner_index', EXISTS (
  SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE i.indrelid='public.resources'::regclass AND c.relname='resources_owner_created' AND i.indisvalid AND i.indpred IS NULL
)
UNION ALL
SELECT 'storage_active_occupancy_index', EXISTS (
  SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.storage_reservations_active_user')
    AND i.indrelid='public.storage_reservations'::regclass AND i.indisvalid AND i.indnkeyatts=2
    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)
      = ARRAY['user_id','status','requested_bytes','confirmed_bytes']
    AND pg_get_expr(i.indpred,i.indrelid) = '(status = ANY (ARRAY[''reserved''::text, ''confirmed''::text]))'
)
UNION ALL
SELECT 'resource_reference_owner_index', EXISTS (
  SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.resource_refs_owner')
    AND i.indrelid='public.resource_refs'::regclass AND i.indisvalid AND i.indnkeyatts=4 AND i.indpred IS NULL
    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)
      = ARRAY['user_id','ref_kind','ref_id_external','workspace_id']
)
UNION ALL
SELECT 'user_storage_counter_columns', (
  SELECT count(*)=2 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.users'::regclass AND NOT a.attisdropped AND a.attnotnull
      AND a.atttypid='bigint'::regtype AND a.attname IN ('storage_used_bytes','storage_reserved_bytes')
      AND pg_get_expr(d.adbin,d.adrelid)='0'
)
UNION ALL
SELECT 'user_storage_counter_checks', (
  SELECT count(*)=2 FROM pg_constraint
    WHERE conrelid='public.users'::regclass AND contype='c' AND convalidated
      AND ((conname='users_storage_used_bytes_nonnegative' AND pg_get_constraintdef(oid)='CHECK ((storage_used_bytes >= 0))')
        OR (conname='users_storage_reserved_bytes_nonnegative' AND pg_get_constraintdef(oid)='CHECK ((storage_reserved_bytes >= 0))'))
)
UNION ALL
SELECT 'user_storage_counter_role_access',
  has_column_privilege('huahuo_api','public.users','storage_used_bytes','UPDATE')
  AND has_column_privilege('huahuo_api','public.users','storage_reserved_bytes','UPDATE')
  AND has_column_privilege('huahuo_worker','public.users','storage_used_bytes','UPDATE')
  AND has_column_privilege('huahuo_worker','public.users','storage_reserved_bytes','UPDATE')
  AND NOT has_table_privilege('huahuo_worker','public.users','UPDATE')
  AND NOT has_table_privilege('huahuo_worker','public.users','INSERT')
  AND NOT has_table_privilege('huahuo_worker','public.users','DELETE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid='public.users'::regclass AND attnum>0 AND NOT attisdropped
      AND attname NOT IN ('storage_used_bytes','storage_reserved_bytes')
      AND has_column_privilege('huahuo_worker',attrelid,attnum,'UPDATE')
  )
UNION ALL
SELECT 'user_profile_timestamp_trigger_restored', EXISTS (
  SELECT 1 FROM pg_trigger WHERE tgrelid='public.users'::regclass AND tgname='users_set_updated_at' AND tgenabled='O'
)
UNION ALL
SELECT 'retired_download_settings_removed', NOT EXISTS (
  SELECT 1 FROM public.runtime_configuration
  WHERE "values" ?| ARRAY['storage.maxSourceBytes','tasks.downloadTimeoutMs']
)
UNION ALL
SELECT 'notes_current_parts_only', to_regclass('public.note_part_revisions') IS NULL
  AND to_regclass('public.note_parts') IS NOT NULL
  AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.note_parts'::regclass AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (note_id, part)')
  AND has_table_privilege('huahuo_api','public.note_parts','UPDATE')
  AND has_table_privilege('huahuo_worker','public.note_parts','SELECT')
UNION ALL
SELECT 'resources_user_owned_only', NOT EXISTS (
 SELECT 1 FROM pg_attribute WHERE attrelid='public.resources'::regclass AND attname IN ('workspace_id','upload_id','deleted_at') AND NOT attisdropped
) AND EXISTS (
 SELECT 1 FROM pg_attribute WHERE attrelid='public.resources'::regclass AND attname='reference_count' AND attnotnull AND NOT attisdropped
)
UNION ALL
SELECT 'resource_hard_delete_role_access',
 has_table_privilege('huahuo_worker','public.resources','DELETE')
 AND NOT has_table_privilege('huahuo_api','public.resources','DELETE')
 AND has_column_privilege('huahuo_worker','public.storage_jobs','completed_at','UPDATE')
 AND NOT has_column_privilege('huahuo_worker','public.storage_jobs','resource_id','UPDATE')
UNION ALL
SELECT 'resource_user_delete_task_scope', EXISTS (
 SELECT 1 FROM pg_constraint WHERE conrelid='public.tasks'::regclass AND conname='tasks_check' AND convalidated
  AND pg_get_constraintdef(oid) LIKE '%storage.delete%'
);
