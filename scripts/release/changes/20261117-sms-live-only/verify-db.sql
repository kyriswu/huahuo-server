SELECT 'otp_provider_mode_present' AS check_name, EXISTS (
  SELECT 1 FROM pg_attribute
  WHERE attrelid='public.otp_requests'::regclass AND attname='provider_mode'
    AND atttypid='text'::regtype AND attnotnull AND NOT attisdropped
) AS ok;
