-- Retire the per-node admission toggle. Existing catalog is tiny and bounded by
-- deployment review; one UPDATE, no external calls or new objects/foreign keys.
-- Keep the retired JSON key true for the still-running old binary during rollout.
-- New API omits it and new selection ignores it; it is no longer configurable.
-- Successful old tasks/snapshots remain untouched. Transaction rollback is atomic.
UPDATE public.processing_nodes SET config=jsonb_set(config,'{enabled}','true'),
 revision=revision+1,updated_at=now() WHERE config->'enabled' IS DISTINCT FROM 'true'::jsonb;
