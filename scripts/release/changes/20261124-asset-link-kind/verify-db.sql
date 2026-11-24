SELECT 'asset_kind_accepts_link' AS check_name, EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid='public.content_assets'::regclass AND conname='content_assets_asset_kind_check'
    AND contype='c' AND convalidated AND pg_get_constraintdef(oid) LIKE '%''link''::text%'
) AS ok
UNION ALL
SELECT 'asset_chunk_lookup_ready', EXISTS (
  SELECT 1 FROM pg_index WHERE indrelid='public.kb_content_asset_hybrid_chunks'::regclass
    AND indisvalid AND indisready AND pg_get_indexdef(indexrelid) LIKE '%(point_id)'
)
UNION ALL
SELECT 'zero_physical_foreign_keys', NOT EXISTS (
  SELECT 1 FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace
);
