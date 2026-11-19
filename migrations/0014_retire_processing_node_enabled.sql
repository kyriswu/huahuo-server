-- Remove the retired node admission flag after the old binaries have drained.
-- Bounded configuration-only rewrite; refuse large catalogs for separate review.
-- Assignments retain every routing/identity field; only the unused flag is removed.
-- Requires the candidate writer: old writers still add enabled and will be rejected.
DO $$
DECLARE old_constraint text;
BEGIN
 IF (SELECT count(*) FROM public.processing_nodes WHERE config ? 'enabled') > 10000
 OR (SELECT count(*) FROM public.processing_node_assignments WHERE snapshot ? 'enabled') > 10000 THEN
  RAISE EXCEPTION 'PROCESSING_NODE_FLAG_CLEANUP_REQUIRES_SEPARATE_REVIEW';
 END IF;
 SELECT conname INTO STRICT old_constraint FROM pg_constraint
 WHERE conrelid='public.processing_nodes'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%''enabled''%';
 EXECUTE format('ALTER TABLE public.processing_nodes DROP CONSTRAINT %I',old_constraint);
END $$;
UPDATE public.processing_nodes SET config=config-'enabled' WHERE config ? 'enabled';
UPDATE public.processing_node_assignments SET snapshot=snapshot-'enabled' WHERE snapshot ? 'enabled';
ALTER TABLE public.processing_nodes ADD CONSTRAINT processing_nodes_config_shape CHECK ((
 NOT (config ? 'enabled')
 AND jsonb_typeof(config->'capabilities')='array'
 AND jsonb_array_length(config->'capabilities') BETWEEN 1 AND 2
 AND config->'capabilities' <@ '["document","audio"]'::jsonb
 AND jsonb_typeof(config->'concurrency')='number' AND (config->>'concurrency')::integer BETWEEN 1 AND 16
 AND ((config->>'mode'='ecs' AND config->>'regionId' IS NOT NULL AND config->>'instanceId' IS NOT NULL AND config->>'privateIp' IS NOT NULL)
 OR (config->>'mode'='always-on' AND config->>'regionId' IS NULL AND config->>'instanceId' IS NULL AND config->>'privateIp' IS NULL AND config->>'baseUrl' IS NOT NULL))
) IS TRUE);
