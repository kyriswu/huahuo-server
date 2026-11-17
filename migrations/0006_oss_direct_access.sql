-- Client objects are confirmed by OSS HEAD. No byte inspection or background recheck.
-- Existing measured hashes remain valid history; new uploads have no measured SHA-256.
-- Old workers must be drained before this migration; no runtime compatibility branch.
-- Data change: retire only the removed inspection jobs and pending inspection labels.
-- All statements share the migration runner transaction and lock/statement budgets.
ALTER TABLE public.resources ALTER COLUMN sha256 DROP NOT NULL;
ALTER TABLE public.resources DROP CONSTRAINT resources_processing_status_check;
ALTER TABLE public.resources ALTER COLUMN processing_status SET DEFAULT 'metadata_confirmed';
ALTER TABLE public.resources ADD CONSTRAINT resources_processing_status_check
  CHECK (processing_status IN ('metadata_confirmed','inspected','failed')) NOT VALID;
UPDATE public.resources SET processing_status='metadata_confirmed' WHERE processing_status='inspection_pending';
ALTER TABLE public.resources VALIDATE CONSTRAINT resources_processing_status_check;

-- Inspection never owns credits or an external request. Refuse unexpected state.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.tasks WHERE kind='storage.inspect'
    AND state NOT IN ('succeeded','failed','cancelled')
    AND (reservation_id IS NOT NULL OR external_state<>'none')) THEN
    RAISE EXCEPTION 'STORAGE_INSPECTION_RETIREMENT_REQUIRES_REVIEW';
  END IF;
END $$;
WITH retired AS (
  UPDATE public.tasks SET state='cancelled',version=version+1,
    lease_owner=NULL,lease_until=NULL,retryable=false,
    error_code='STORAGE_INSPECTION_REMOVED',cancel_requested_at=coalesce(cancel_requested_at,now()),
    event_sequence=event_sequence+1,updated_at=now()
  WHERE kind='storage.inspect' AND state NOT IN ('succeeded','failed','cancelled')
  RETURNING id,event_sequence
)
INSERT INTO public.task_events(task_id,sequence,state)
SELECT id,event_sequence,'cancelled' FROM retired;
UPDATE public.task_attempts a SET state='cancelled',error_code='STORAGE_INSPECTION_REMOVED',finished_at=now()
FROM public.tasks t WHERE a.task_id=t.id AND t.kind='storage.inspect'
  AND t.error_code='STORAGE_INSPECTION_REMOVED' AND a.finished_at IS NULL;
UPDATE public.task_outbox o SET status='superseded',lease_owner=NULL,lease_until=NULL,
  last_error='STORAGE_INSPECTION_REMOVED'
FROM public.tasks t WHERE o.task_id=t.id AND t.kind='storage.inspect'
  AND o.status IN ('pending','delivering');
