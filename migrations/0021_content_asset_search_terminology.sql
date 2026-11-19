-- The existing Milvus collection is renamed in place during coordinated
-- maintenance. Point IDs and build fingerprints remain valid.
DO $$
BEGIN
    IF (SELECT count(DISTINCT (snapshot #>> '{target,connectionId}', snapshot #>> '{target,database}'))
        FROM public.kb_content_asset_hybrid_builds
        WHERE snapshot #>> '{target,collection}' = 'huahuo_kb_note_hybrid_chunks') > 1 THEN
        RAISE EXCEPTION 'CONTENT_ASSET_COLLECTION_TARGET_AMBIGUOUS';
    END IF;
END $$;

-- Index attributes retain the original names when a table column is renamed.
-- Rename only direct columns whose backing field has already been migrated.
DO $$
DECLARE
    attribute record;
BEGIN
    FOR attribute IN
        SELECT idx.relname AS index_name, ia.attname AS old_name, ta.attname AS new_name
        FROM pg_index i
        JOIN pg_class idx ON idx.oid = i.indexrelid
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinal)
        JOIN pg_attribute ia ON ia.attrelid = i.indexrelid AND ia.attnum = key.ordinal
        JOIN pg_attribute ta ON ta.attrelid = i.indrelid AND ta.attnum = key.attnum
        WHERE idx.relnamespace = 'public'::regnamespace AND idx.relkind = 'i'
          AND (ia.attname, ta.attname) IN (
              ('note_id', 'content_asset_id'),
              ('note_revision_id', 'content_asset_revision_id'),
              ('source_note_id', 'source_content_asset_id'),
              ('target_note_id', 'target_content_asset_id')
          )
        ORDER BY idx.relname, ia.attnum
    LOOP
        EXECUTE format('ALTER TABLE ONLY public.%I RENAME COLUMN %I TO %I',
            attribute.index_name, attribute.old_name, attribute.new_name);
    END LOOP;
END $$;

UPDATE public.kb_content_asset_hybrid_builds
SET snapshot = jsonb_set(
    CASE WHEN snapshot #>> '{target,collection}' = 'huahuo_kb_note_hybrid_chunks'
         THEN jsonb_set(snapshot, '{target,collection}', '"huahuo_kb_content_asset_hybrid_chunks"', false)
         ELSE snapshot END,
    '{mode}', '"hybrid"', false)
WHERE snapshot #>> '{mode}' IN ('content-asset-hybrid', 'note-hybrid')
   OR snapshot #>> '{target,collection}' = 'huahuo_kb_note_hybrid_chunks';

UPDATE public.kb_document_keyword_builds
SET snapshot = jsonb_set(snapshot, '{mode}', '"keyword"', false)
WHERE snapshot #>> '{mode}' = 'document-keyword';

UPDATE public.rag_ingestion_versions
SET processing_snapshot = jsonb_set(processing_snapshot, '{keyword,mode}', '"keyword"', false)
WHERE processing_snapshot #>> '{keyword,mode}' = 'document-keyword';

WITH inputs AS MATERIALIZED (
    SELECT i.id, CASE WHEN pg_input_is_valid(i.body, 'jsonb') THEN i.body::jsonb END AS body
    FROM public.task_inputs i JOIN public.tasks t
        ON t.input_id = i.id AND t.user_id = i.user_id AND t.workspace_id = i.workspace_id
    WHERE t.kind = 'text.ingest'
)
UPDATE public.task_inputs i
SET body = jsonb_set(inputs.body, '{snapshot,keyword,mode}', '"keyword"', false)::text
FROM inputs
WHERE i.id = inputs.id AND inputs.body #>> '{snapshot,keyword,mode}' = 'document-keyword';

COMMENT ON TABLE public.content_assets IS 'ContentAsset is the account-owned business record for user content.';
COMMENT ON TABLE public.content_asset_parts IS 'Current editable body parts of a ContentAsset.';
COMMENT ON TABLE public.content_asset_workspaces IS 'Workspace visibility membership for a ContentAsset.';
COMMENT ON TABLE public.content_asset_folders IS 'Folder placement for a ContentAsset.';
COMMENT ON TABLE public.content_asset_resource_refs IS 'Ordered binary Resource links owned by a ContentAsset.';
COMMENT ON TABLE public.resources IS 'Account-owned binary Resource metadata and storage identity.';
COMMENT ON TABLE public.kb_content_asset_hybrid_builds IS 'Derived index builds for the raw body of a ContentAsset.';
