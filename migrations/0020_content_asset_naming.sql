-- Rename the stored content-asset model in place while retaining IDs, row
-- grants and references. API, Admin and Worker must cut over together.
ALTER TABLE public.notes RENAME TO content_assets;
ALTER TABLE public.content_assets RENAME COLUMN note_id TO content_asset_id;
ALTER TABLE public.content_assets RENAME COLUMN note_revision TO content_asset_revision;
ALTER TABLE public.content_assets RENAME COLUMN note_revision_id TO content_asset_revision_id;

ALTER TABLE public.note_parts RENAME TO content_asset_parts;
ALTER TABLE public.content_asset_parts RENAME COLUMN note_id TO content_asset_id;
ALTER TABLE public.note_folders RENAME TO content_asset_folders;
ALTER TABLE public.content_asset_folders RENAME COLUMN note_id TO content_asset_id;
ALTER TABLE public.content_asset_folders DROP COLUMN deleted_by_folder_id;
ALTER TABLE public.note_workspaces RENAME TO content_asset_workspaces;
ALTER TABLE public.content_asset_workspaces RENAME COLUMN note_id TO content_asset_id;
ALTER TABLE public.note_relations RENAME TO content_asset_relations;
ALTER TABLE public.content_asset_relations RENAME COLUMN source_note_id TO source_content_asset_id;
ALTER TABLE public.content_asset_relations RENAME COLUMN target_note_id TO target_content_asset_id;
ALTER TABLE public.note_resource_refs RENAME TO content_asset_resource_refs;
ALTER TABLE public.content_asset_resource_refs RENAME COLUMN note_id TO content_asset_id;
ALTER TABLE public.note_tags RENAME TO content_asset_tags;
ALTER TABLE public.content_asset_tags RENAME COLUMN note_id TO content_asset_id;
ALTER TABLE public.note_tag_suggestions RENAME TO content_asset_tag_suggestions;
ALTER TABLE public.content_asset_tag_suggestions RENAME COLUMN note_id TO content_asset_id;
ALTER TABLE public.content_asset_tag_suggestions RENAME COLUMN note_revision_id TO content_asset_revision_id;
ALTER TABLE public.content_jobs RENAME COLUMN note_id TO content_asset_id;
ALTER TABLE public.content_jobs RENAME COLUMN note_revision_id TO content_asset_revision_id;
ALTER TABLE public.kb_note_hybrid_builds RENAME TO kb_content_asset_hybrid_builds;
ALTER TABLE public.kb_note_hybrid_chunks RENAME TO kb_content_asset_hybrid_chunks;
ALTER TABLE public.ai_template_runs RENAME COLUMN note_id TO content_asset_id;

ALTER TABLE public.content_assets RENAME CONSTRAINT notes_pkey TO content_assets_pkey;
ALTER TABLE public.content_assets RENAME CONSTRAINT notes_processing_status_check TO content_assets_processing_status_check;
ALTER TABLE public.content_assets RENAME CONSTRAINT notes_state_check TO content_assets_state_check;
ALTER TABLE public.content_assets RENAME CONSTRAINT notes_title_check TO content_assets_title_check;
ALTER TABLE public.content_asset_parts RENAME CONSTRAINT note_parts_pkey TO content_asset_parts_pkey;
ALTER TABLE public.content_asset_parts RENAME CONSTRAINT note_parts_part_check TO content_asset_parts_part_check;
ALTER TABLE public.content_asset_parts RENAME CONSTRAINT note_parts_revision_check TO content_asset_parts_revision_check;
ALTER TABLE public.content_asset_folders RENAME CONSTRAINT note_folders_pkey TO content_asset_folders_pkey;
ALTER TABLE public.content_asset_workspaces RENAME CONSTRAINT note_workspaces_pkey TO content_asset_workspaces_pkey;
ALTER TABLE public.content_asset_relations RENAME CONSTRAINT note_relations_pkey TO content_asset_relations_pkey;
ALTER TABLE public.content_asset_relations RENAME CONSTRAINT note_relations_check TO content_asset_relations_distinct_check;
ALTER TABLE public.content_asset_relations RENAME CONSTRAINT note_relations_origin_check TO content_asset_relations_origin_check;
ALTER TABLE public.content_asset_relations RENAME CONSTRAINT note_relations_relation_type_check TO content_asset_relations_relation_type_check;
ALTER TABLE public.content_asset_relations RENAME CONSTRAINT note_relations_workspace_id_source_note_id_target_note_id_r_key TO content_asset_relations_scope_edge_key;
ALTER TABLE public.content_asset_resource_refs RENAME CONSTRAINT note_resource_refs_pkey TO content_asset_resource_refs_pkey;
ALTER TABLE public.content_asset_resource_refs RENAME CONSTRAINT note_resource_refs_ref_order_check TO content_asset_resource_refs_ref_order_check;
ALTER TABLE public.content_asset_resource_refs RENAME CONSTRAINT note_resource_refs_note_id_resource_id_usage_anchor_key TO content_asset_resource_refs_resource_usage_anchor_key;
ALTER TABLE public.content_asset_tags RENAME CONSTRAINT note_tags_pkey TO content_asset_tags_pkey;
ALTER TABLE public.content_asset_tags RENAME CONSTRAINT note_tags_source_check TO content_asset_tags_source_check;
ALTER TABLE public.content_asset_tag_suggestions RENAME CONSTRAINT note_tag_suggestions_pkey TO content_asset_tag_suggestions_pkey;
ALTER TABLE public.content_asset_tag_suggestions RENAME CONSTRAINT note_tag_suggestions_status_check TO content_asset_tag_suggestions_status_check;
ALTER TABLE public.content_asset_tag_suggestions RENAME CONSTRAINT note_tag_suggestions_task_id_key TO content_asset_tag_suggestions_task_id_key;

ALTER INDEX public.notes_scope RENAME TO content_assets_scope;
ALTER INDEX public.notes_graph_page RENAME TO content_assets_graph_page;
ALTER INDEX public.note_folders_note_id_idx RENAME TO content_asset_folders_content_asset_id_idx;
ALTER INDEX public.note_workspaces_note_id_idx RENAME TO content_asset_workspaces_content_asset_id_idx;
ALTER INDEX public.note_relations_rel_681eb494d7e7_idx RENAME TO content_asset_relations_source_idx;
ALTER INDEX public.note_relations_rel_7aa2489a7b0e_idx RENAME TO content_asset_relations_target_idx;
ALTER INDEX public.note_resource_refs_rel_871ac57d2ea3_idx RENAME TO content_asset_resource_refs_resource_id_idx;
ALTER INDEX public.note_tags_topic_members RENAME TO content_asset_tags_topic_members;
ALTER INDEX public.note_tag_suggestions_rel_9a9db47d7fcc_idx RENAME TO content_asset_tag_suggestions_content_asset_id_idx;
ALTER INDEX public.note_tag_suggestions_scope RENAME TO content_asset_tag_suggestions_scope;
ALTER INDEX public.content_jobs_note RENAME TO content_jobs_content_asset_idx;

ALTER TRIGGER note_tags_lifecycle_fence ON public.content_assets RENAME TO content_asset_tags_lifecycle_fence;
ALTER FUNCTION public.note_tags_lifecycle_fence() RENAME TO content_asset_tags_lifecycle_fence;

ALTER TABLE public.kb_content_asset_hybrid_builds DROP CONSTRAINT kb_note_hybrid_builds_source_type_check;
ALTER TABLE public.kb_content_asset_hybrid_builds RENAME CONSTRAINT kb_note_hybrid_builds_pkey TO kb_content_asset_hybrid_builds_pkey;
ALTER TABLE public.kb_content_asset_hybrid_builds RENAME CONSTRAINT kb_note_hybrid_builds_source_type_source_id_source_revision_key TO kb_content_asset_hybrid_builds_source_config_key;
ALTER TABLE public.kb_content_asset_hybrid_builds RENAME CONSTRAINT kb_note_hybrid_builds_status_check TO kb_content_asset_hybrid_builds_status_check;
ALTER TABLE public.kb_content_asset_hybrid_builds RENAME CONSTRAINT kb_note_hybrid_builds_chunk_count_check TO kb_content_asset_hybrid_builds_chunk_count_check;
ALTER TABLE public.kb_content_asset_hybrid_builds RENAME CONSTRAINT kb_note_hybrid_builds_toc_status_check TO kb_content_asset_hybrid_builds_toc_status_check;
ALTER TABLE public.kb_content_asset_hybrid_builds RENAME CONSTRAINT kb_note_hybrid_builds_cleanup_status_check TO kb_content_asset_hybrid_builds_cleanup_status_check;
ALTER TABLE public.kb_content_asset_hybrid_builds RENAME CONSTRAINT kb_note_hybrid_builds_check TO kb_content_asset_hybrid_builds_published_status_check;

ALTER TABLE public.kb_content_asset_hybrid_chunks RENAME CONSTRAINT kb_note_hybrid_chunks_pkey TO kb_content_asset_hybrid_chunks_pkey;
ALTER TABLE public.kb_content_asset_hybrid_chunks RENAME CONSTRAINT kb_note_hybrid_chunks_build_id_point_id_key TO kb_content_asset_hybrid_chunks_build_id_point_id_key;
ALTER TABLE public.kb_content_asset_hybrid_chunks RENAME CONSTRAINT kb_note_hybrid_chunks_ordinal_check TO kb_content_asset_hybrid_chunks_ordinal_check;
ALTER TABLE public.kb_content_asset_hybrid_chunks RENAME CONSTRAINT kb_note_hybrid_chunks_source_start_check TO kb_content_asset_hybrid_chunks_source_start_check;
ALTER TABLE public.kb_content_asset_hybrid_chunks RENAME CONSTRAINT kb_note_hybrid_chunks_token_count_check TO kb_content_asset_hybrid_chunks_token_count_check;
ALTER TABLE public.kb_content_asset_hybrid_chunks RENAME CONSTRAINT kb_note_hybrid_chunks_char_count_check TO kb_content_asset_hybrid_chunks_char_count_check;
ALTER TABLE public.kb_content_asset_hybrid_chunks RENAME CONSTRAINT kb_note_hybrid_chunks_index_status_check TO kb_content_asset_hybrid_chunks_index_status_check;
ALTER TABLE public.kb_content_asset_hybrid_chunks RENAME CONSTRAINT kb_note_hybrid_chunks_check TO kb_content_asset_hybrid_chunks_source_bounds_check;
ALTER TABLE public.kb_content_asset_hybrid_chunks RENAME CONSTRAINT kb_note_hybrid_chunks_check1 TO kb_content_asset_hybrid_chunks_core_bounds_check;

ALTER INDEX public.kb_note_hybrid_builds_published RENAME TO kb_content_asset_hybrid_builds_published;
ALTER INDEX public.kb_note_hybrid_builds_owner RENAME TO kb_content_asset_hybrid_builds_owner;
ALTER INDEX public.kb_note_hybrid_builds_task RENAME TO kb_content_asset_hybrid_builds_task;
ALTER INDEX public.kb_note_hybrid_builds_source RENAME TO kb_content_asset_hybrid_builds_source;
ALTER INDEX public.kb_note_hybrid_builds_workspace RENAME TO kb_content_asset_hybrid_builds_workspace;
ALTER INDEX public.kb_note_hybrid_chunks_point RENAME TO kb_content_asset_hybrid_chunks_point;
ALTER INDEX public.kb_note_hybrid_chunks_ready RENAME TO kb_content_asset_hybrid_chunks_ready;

-- Keep the existing build IDs, vector point IDs and external collection.
UPDATE public.kb_content_asset_hybrid_builds
SET source_type='content_asset',
    snapshot=jsonb_set(snapshot,'{mode}','"content-asset-hybrid"'::jsonb,false)
WHERE source_type='note';
ALTER TABLE public.kb_content_asset_hybrid_builds
    ADD CONSTRAINT kb_content_asset_hybrid_builds_source_type_check CHECK (source_type='content_asset');

-- Select by task kind before reading the input JSON. Other task bodies can be
-- arbitrary text. Keep invalid historical bodies available for diagnostics.
WITH inputs AS MATERIALIZED (
    SELECT i.id, t.kind, CASE WHEN pg_input_is_valid(i.body, 'jsonb') THEN i.body::jsonb END AS body
    FROM public.task_inputs i JOIN public.tasks t ON t.input_id=i.id
    WHERE t.kind IN ('asset.tag-extract','kb.note-cleanup')
)
UPDATE public.task_inputs i
SET body=((inputs.body-'noteId') ||
    jsonb_build_object('contentAssetId', inputs.body->'noteId'))::text
FROM inputs
WHERE i.id=inputs.id AND jsonb_typeof(inputs.body)='object' AND inputs.body ? 'noteId';

WITH inputs AS MATERIALIZED (
    SELECT i.id, CASE WHEN pg_input_is_valid(i.body, 'jsonb') THEN i.body::jsonb END AS body
    FROM public.task_inputs i JOIN public.tasks t ON t.input_id=i.id
    WHERE t.kind='asset.tag-extract'
)
UPDATE public.task_inputs i
SET body=((inputs.body-'revisionId') ||
    jsonb_build_object('contentAssetRevisionId', inputs.body->'revisionId'))::text
FROM inputs
WHERE i.id=inputs.id AND jsonb_typeof(inputs.body)='object' AND inputs.body ? 'revisionId';

UPDATE public.tasks
SET kind=CASE kind
    WHEN 'asset.tag-extract' THEN 'content-asset.tag-extract'
    WHEN 'kb.note-cleanup' THEN 'kb.content-asset-cleanup'
    WHEN 'kb.note-index' THEN 'kb.content-asset-index' END
WHERE kind IN ('asset.tag-extract','kb.note-cleanup','kb.note-index');

UPDATE public.content_events
SET object_kind=CASE WHEN object_kind='note_relation' THEN 'content_asset_relation' ELSE 'content_asset' END
WHERE object_kind IN ('note','hnote','note_relation');

UPDATE public.resource_refs SET ref_kind='content_asset' WHERE ref_kind='note';

UPDATE public.runtime_configuration
SET "values"=("values"-'features.noteIndexing'-'rag.noteRerankBudgetMs') ||
    CASE WHEN "values" ? 'features.noteIndexing'
        THEN jsonb_build_object('features.contentAssetIndexing', "values"->'features.noteIndexing')
        ELSE '{}'::jsonb END ||
    CASE WHEN "values" ? 'rag.noteRerankBudgetMs'
        THEN jsonb_build_object('rag.contentAssetRerankBudgetMs', "values"->'rag.noteRerankBudgetMs')
        ELSE '{}'::jsonb END,
    revision=revision+1, updated_at=now()
WHERE singleton=true AND "values" ?| ARRAY['features.noteIndexing','rag.noteRerankBudgetMs'];

ALTER TABLE public.ai_template_scenes DROP CONSTRAINT ai_template_scenes_scene_key_check;
ALTER TABLE public.ai_template_runs
    DROP CONSTRAINT ai_template_runs_scene_key_check,
    DROP CONSTRAINT ai_template_runs_check;
DROP INDEX public.ai_template_outline_results_idx;

UPDATE public.ai_template_scenes SET scene_key='content_asset_outline' WHERE scene_key='note_outline';
UPDATE public.ai_template_versions SET scene_key='content_asset_outline' WHERE scene_key='note_outline';
UPDATE public.ai_template_runs SET scene_key='content_asset_outline' WHERE scene_key='note_outline';

ALTER TABLE public.ai_template_scenes
    ADD CONSTRAINT ai_template_scenes_scene_key_check CHECK (scene_key IN ('content_asset_outline','editor_polish'));
ALTER TABLE public.ai_template_runs
    ADD CONSTRAINT ai_template_runs_scene_key_check CHECK (scene_key IN ('content_asset_outline','editor_polish')),
    ADD CONSTRAINT ai_template_runs_source_check CHECK (
        (scene_key='content_asset_outline' AND content_asset_id IS NOT NULL AND source_revision IS NOT NULL)
        OR (scene_key='editor_polish' AND content_asset_id IS NULL AND source_revision IS NULL)
    );

CREATE INDEX ai_template_outline_results_idx
ON public.ai_template_runs (workspace_id, content_asset_id, source_revision, user_id, item_key, finished_at DESC, id DESC)
WHERE scene_key='content_asset_outline' AND state='succeeded';
