SELECT 'resource_lookup_columns_unchanged'::text AS check_name,
       count(*) = 4 AS ok
FROM pg_attribute
WHERE attrelid = 'public.resources'::regclass
  AND attname IN ('user_id', 'mime_type', 'object_version', 'reference_count')
  AND attnum > 0 AND NOT attisdropped;
