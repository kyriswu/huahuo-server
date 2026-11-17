-- Infrastructure storage counters, maintained with reservation changes in the same transaction.
-- Temporary upload metadata stays in Redis and does not count toward user space; only PostgreSQL occupancy is initialized here.
-- Old writers do not maintain these columns and must be drained before this migration.
-- Candidate only: inspect target user/reservation counts and aggregate/lock duration before
-- approving inline execution. An unknown target size is not permission to deploy this file.
-- One file is one transaction under the migration runner's lock/statement budgets.
-- Orphaned ownership, overflow or any failure rolls back columns, counters and grants together.
LOCK TABLE public.users IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.storage_reservations IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.storage_reservations r
    LEFT JOIN public.users u ON u.id=r.user_id
    WHERE u.id IS NULL
  ) THEN
    RAISE EXCEPTION 'STORAGE_COUNTER_ORPHAN_RESERVATIONS';
  END IF;
END;
$$;

ALTER TABLE public.users
  ADD COLUMN storage_used_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN storage_reserved_bytes bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT users_storage_used_bytes_nonnegative CHECK (storage_used_bytes >= 0),
  ADD CONSTRAINT users_storage_reserved_bytes_nonnegative CHECK (storage_reserved_bytes >= 0);

-- Preserve the existing profile timestamps while initializing derived infrastructure data.
-- This changes no trigger definition and is restored before the transaction can commit.
ALTER TABLE public.users DISABLE TRIGGER users_set_updated_at;
UPDATE public.users u
SET storage_used_bytes=s.used_bytes, storage_reserved_bytes=s.reserved_bytes
FROM (
  SELECT user_id,
    COALESCE(SUM(confirmed_bytes) FILTER (WHERE status='confirmed'),0)::bigint AS used_bytes,
    COALESCE(SUM(requested_bytes) FILTER (WHERE status='reserved'),0)::bigint AS reserved_bytes
  FROM public.storage_reservations
  WHERE status IN ('confirmed','reserved')
  GROUP BY user_id
) s
WHERE u.id=s.user_id;
ALTER TABLE public.users ENABLE TRIGGER users_set_updated_at;

GRANT UPDATE(storage_used_bytes,storage_reserved_bytes) ON public.users TO huahuo_worker;
