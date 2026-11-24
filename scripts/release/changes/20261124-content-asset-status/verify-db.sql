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
SELECT 'asset_content_status_values', EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid='public.content_assets'::regclass AND conname='content_assets_processing_status_check'
    AND contype='c' AND convalidated
    AND ARRAY(
      SELECT status[1]
      FROM regexp_matches(pg_get_constraintdef(oid), $pattern$'([^']+)'::text$pattern$, 'g') AS status
      ORDER BY status[1]
    ) = ARRAY['draft','failed','processing','ready']
)
UNION ALL
SELECT 'asset_content_status_required_default', EXISTS (
  SELECT 1 FROM pg_attribute a
  JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid='public.content_assets'::regclass AND a.attname='processing_status'
    AND a.atttypid='text'::regtype AND a.attnotnull AND NOT a.attisdropped
    AND pg_get_expr(d.adbin,d.adrelid) = '''ready''::text'
)
UNION ALL
SELECT 'zero_physical_foreign_keys', NOT EXISTS (
  SELECT 1 FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace
);
