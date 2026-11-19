SELECT 'single_asset_folder_schema' AS check_name,
  to_regclass('public.content_asset_folders') IS NULL
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='content_assets'
      AND column_name='folder_id' AND data_type='uuid' AND is_nullable='YES'
  )
  AND EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid=to_regclass('public.content_assets_folder_page') AND indisvalid AND indisready
  ) AS ok
UNION ALL
SELECT 'same_account_asset_folders', NOT EXISTS (
  SELECT 1 FROM public.content_assets a
  LEFT JOIN public.asset_folders f ON f.folder_id=a.folder_id
  WHERE a.folder_id IS NOT NULL AND f.user_id IS DISTINCT FROM a.user_id
)
UNION ALL
SELECT 'zero_physical_foreign_keys', NOT EXISTS (
  SELECT 1 FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace
);
