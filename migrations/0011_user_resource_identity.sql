-- Files belong to a user, independent of the workspace of each business reference.
-- Upload identity is UUID-based; no content deduplication or business versions.
-- Target preflight has zero resources/references; old writers must be drained.
LOCK TABLE public.resources,public.resource_refs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.resource_refs rr LEFT JOIN public.resources r ON r.resource_id=rr.resource_id
   WHERE r.resource_id IS NULL OR r.user_id<>rr.user_id) THEN
   RAISE EXCEPTION 'RESOURCE_REFERENCE_OWNER_MISMATCH';
 END IF;
 IF EXISTS(SELECT 1 FROM public.resources WHERE status NOT IN ('ready','deleting')) THEN
   RAISE EXCEPTION 'RESOURCE_LIFECYCLE_REQUIRES_REVIEW';
 END IF;
END $$;
ALTER TABLE public.resources
 DROP COLUMN workspace_id,
 DROP COLUMN upload_id,
 DROP COLUMN processing_status,
 DROP COLUMN deleted_at,
 ADD COLUMN reference_count bigint NOT NULL DEFAULT 0 CHECK(reference_count>=0);
ALTER TABLE public.resources DROP CONSTRAINT resources_status_check;
ALTER TABLE public.resources ADD CONSTRAINT resources_status_check CHECK(status IN ('ready','deleting'));
-- A durable completion receipt lets a delete task resume after the resource row
-- has gone, without retaining a soft-deleted file or repeating occupancy changes.
ALTER TABLE public.storage_jobs ADD COLUMN completed_at timestamptz;
GRANT DELETE ON public.resources TO huahuo_worker;
GRANT UPDATE(completed_at) ON public.storage_jobs TO huahuo_worker;
-- Resource cleanup is user-owned, including avatars with no business workspace.
ALTER TABLE public.tasks DROP CONSTRAINT tasks_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_check CHECK(
 (user_id IS NULL AND workspace_id IS NULL AND kind IN ('maintenance.check','processing.node-start'))
 OR (user_id IS NOT NULL AND (workspace_id IS NOT NULL OR kind='storage.delete'))
);
ALTER TABLE public.resource_refs ALTER COLUMN workspace_id DROP NOT NULL;
UPDATE public.resources r SET reference_count=x.n
FROM (SELECT resource_id,count(*) n FROM public.resource_refs GROUP BY resource_id)x WHERE r.resource_id=x.resource_id;
CREATE INDEX resources_owner_created ON public.resources(user_id,created_at DESC,resource_id);
