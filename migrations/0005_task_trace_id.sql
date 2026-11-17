-- Preserve the originating HTTP trace across queue deliveries and callbacks.
-- Initialize the existing small test dataset once, then require every producer
-- to provide its trace at creation. No default or runtime historical repair.
-- Read-only precheck: 172 task rows, total relation size 196608 bytes.
-- Existing table-level role privileges include the new column. No foreign keys.
-- Normal migration transaction/lock budgets apply; failure rolls back atomically.
ALTER TABLE public.tasks ADD COLUMN trace_id text
  CHECK (trace_id ~ '^[A-Za-z0-9._:-]{6,96}$');
UPDATE public.tasks SET trace_id=gen_random_uuid()::text;
ALTER TABLE public.tasks ALTER COLUMN trace_id SET NOT NULL;
