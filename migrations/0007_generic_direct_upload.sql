-- Generic direct uploads own transfer/verification only, not downstream business intent.
-- Incompatible with old API/Worker binaries: stop old upload admission and drain them first.
-- Data change: retire PG upload sessions and unused resource business fields; preserve resources, identities,
-- references, measured resource hashes and confirmed storage occupancy unchanged.
-- No backfill, remote object deletion, quota release or legacy upload conversion occurs here.
-- Target precheck must confirm old signatures and in-flight PUTs are no longer usable;
-- the expiry guard alone cannot prove that an earlier-started OSS request has finished.
-- Table locks make admission/reservation guards atomic with this DDL. The migration
-- runner's lock/statement budgets bound waiting and roll this entire file back on failure.
LOCK TABLE public.upload_sessions, public.resources IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.storage_reservations IN SHARE ROW EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.upload_sessions
    WHERE status NOT IN ('completed','failed','expired')) THEN
    RAISE EXCEPTION 'GENERIC_UPLOAD_ACTIVE_LEGACY_UPLOADS';
  END IF;
  IF EXISTS (SELECT 1 FROM public.storage_reservations r JOIN public.upload_sessions u ON u.reservation_id=r.reservation_id WHERE r.status='reserved') THEN
    RAISE EXCEPTION 'GENERIC_UPLOAD_LEGACY_RESERVATIONS_PENDING';
  END IF;
  IF EXISTS (SELECT 1 FROM public.upload_sessions WHERE expires_at>now()) THEN
    RAISE EXCEPTION 'GENERIC_UPLOAD_LEGACY_AUTHORIZATION_ACTIVE';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tasks WHERE kind IN ('storage.expire','storage.inspect')
    AND state NOT IN ('succeeded','failed','cancelled')) THEN
    RAISE EXCEPTION 'GENERIC_UPLOAD_LEGACY_CLEANUP_PENDING';
  END IF;
  -- Failed/cancelled cleanup may leave a real object behind even after quota was
  -- released. Preserve its locator until the original cleanup succeeds.
  IF EXISTS (SELECT 1 FROM public.upload_sessions u WHERE u.status IN ('failed','expired')
    AND NOT EXISTS (SELECT 1 FROM public.storage_jobs j JOIN public.tasks t ON t.id=j.task_id
      WHERE j.upload_id=u.upload_id AND j.operation='expire' AND t.kind='storage.expire' AND t.state='succeeded')) THEN
    RAISE EXCEPTION 'GENERIC_UPLOAD_LEGACY_CLEANUP_UNCONFIRMED';
  END IF;
END $$;

DROP TABLE public.upload_sessions;

ALTER TABLE public.resources
  DROP COLUMN source_scene,
  DROP COLUMN duration_seconds;

-- Admission/claim aggregates need active occupancy, never released history.
CREATE INDEX storage_reservations_active_user ON public.storage_reservations(user_id,status)
  INCLUDE(requested_bytes,confirmed_bytes) WHERE status IN ('reserved','confirmed');
-- Business edits replace references by their owner; resource_id-leading indexes
-- remain responsible for deletion checks and direct resource lookups.
CREATE INDEX resource_refs_owner ON public.resource_refs(user_id,ref_kind,ref_id_external,workspace_id);
