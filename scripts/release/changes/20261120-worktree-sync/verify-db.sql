SELECT 'resource_playback_size_bytes' AS check_name,
       EXISTS (
         SELECT 1
         FROM pg_attribute
         WHERE attrelid = 'public.resources'::regclass
           AND attname = 'size_bytes'
           AND atttypid = 'bigint'::regtype
           AND attnotnull
           AND NOT attisdropped
       ) AS ok;
