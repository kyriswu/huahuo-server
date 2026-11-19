-- The previous workspace identifies the account for organization rows only.
-- Any orphan, cross-account organization link or conflicting folder name aborts.
ALTER TABLE public.asset_folders ADD COLUMN user_id uuid;
ALTER TABLE public.asset_tags ADD COLUMN user_id uuid;
ALTER TABLE public.content_asset_tag_suggestions ADD COLUMN user_id uuid;
ALTER TABLE public.content_asset_relations ADD COLUMN user_id uuid;
ALTER TABLE public.content_events ADD COLUMN user_id uuid;
ALTER TABLE public.workspace_content_state ADD COLUMN user_id uuid;

UPDATE public.asset_folders f SET user_id=w.user_id FROM public.workspaces w WHERE w.id=f.workspace_id;
UPDATE public.asset_tags t SET user_id=w.user_id FROM public.workspaces w WHERE w.id=t.workspace_id;
UPDATE public.content_asset_tag_suggestions s SET user_id=w.user_id FROM public.workspaces w WHERE w.id=s.workspace_id;
UPDATE public.content_asset_relations r SET user_id=w.user_id FROM public.workspaces w WHERE w.id=r.workspace_id;
UPDATE public.content_events e SET user_id=w.user_id FROM public.workspaces w WHERE w.id=e.workspace_id;
UPDATE public.workspace_content_state s SET user_id=w.user_id FROM public.workspaces w WHERE w.id=s.workspace_id;

DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.content_asset_tags m LEFT JOIN public.asset_tags t USING(tag_id)
   LEFT JOIN public.content_assets a USING(content_asset_id) WHERE a.user_id IS NULL OR a.user_id IS DISTINCT FROM t.user_id)
 OR EXISTS (SELECT 1 FROM public.content_asset_folders m LEFT JOIN public.asset_folders f USING(folder_id)
   LEFT JOIN public.content_assets a USING(content_asset_id) WHERE a.user_id IS NULL OR a.user_id IS DISTINCT FROM f.user_id)
 OR EXISTS (SELECT 1 FROM public.content_asset_relations r
   LEFT JOIN public.content_assets a ON a.content_asset_id=r.source_content_asset_id
   LEFT JOIN public.content_assets b ON b.content_asset_id=r.target_content_asset_id
   WHERE r.user_id IS NULL OR a.user_id IS DISTINCT FROM r.user_id OR b.user_id IS DISTINCT FROM r.user_id)
 OR EXISTS (SELECT 1 FROM public.content_asset_tag_suggestions s LEFT JOIN public.content_assets a USING(content_asset_id)
   WHERE s.user_id IS NULL OR s.user_id IS DISTINCT FROM a.user_id) THEN
   RAISE EXCEPTION 'CONTENT_ASSET_ACCOUNT_SCOPE_MISMATCH';
 END IF;
END $$;

-- Merge equal normalized labels for the same account, retaining effective manual assignments.
CREATE TABLE public.account_tag_remap AS
 SELECT tag_id, first_value(tag_id) OVER (
  PARTITION BY user_id,normalized_name ORDER BY locked DESC,(source='manual') DESC,created_at,tag_id
 ) AS canonical_id FROM public.asset_tags;

INSERT INTO public.content_asset_tags(content_asset_id,tag_id,source,created_at)
 SELECT m.content_asset_id,r.canonical_id,CASE WHEN bool_or(m.source='manual') THEN 'manual' ELSE 'extracted' END,min(m.created_at)
 FROM public.content_asset_tags m JOIN public.account_tag_remap r USING(tag_id)
 WHERE r.tag_id<>r.canonical_id GROUP BY m.content_asset_id,r.canonical_id
 ON CONFLICT (content_asset_id,tag_id) DO UPDATE SET
 source=CASE WHEN content_asset_tags.source='manual' THEN 'manual' ELSE EXCLUDED.source END,
 created_at=least(content_asset_tags.created_at,EXCLUDED.created_at);
DELETE FROM public.content_asset_tags m USING public.account_tag_remap r WHERE m.tag_id=r.tag_id AND r.tag_id<>r.canonical_id;
DELETE FROM public.asset_tags t USING public.account_tag_remap r WHERE t.tag_id=r.tag_id AND r.tag_id<>r.canonical_id;

DROP TABLE public.account_tag_remap;

ALTER TABLE public.asset_folders ALTER COLUMN user_id SET NOT NULL, DROP COLUMN workspace_id;
CREATE INDEX asset_folders_parent ON public.asset_folders(user_id,parent_folder_id,state);
CREATE UNIQUE INDEX asset_folders_root_name ON public.asset_folders(user_id,normalized_name) WHERE parent_folder_id IS NULL;
ALTER TABLE public.asset_folders ADD CONSTRAINT asset_folders_account_sibling_name_key UNIQUE(user_id,parent_folder_id,normalized_name) DEFERRABLE;
ALTER TABLE public.asset_tags ALTER COLUMN user_id SET NOT NULL, DROP COLUMN workspace_id;
ALTER TABLE public.asset_tags ADD CONSTRAINT asset_tags_account_name_key UNIQUE(user_id,normalized_name);
ALTER TABLE public.content_asset_tag_suggestions ALTER COLUMN user_id SET NOT NULL, DROP COLUMN workspace_id;
CREATE INDEX content_asset_tag_suggestions_scope ON public.content_asset_tag_suggestions(user_id,content_asset_id,status,created_at DESC);
ALTER TABLE public.content_asset_relations ALTER COLUMN user_id SET NOT NULL, DROP COLUMN workspace_id;
ALTER TABLE public.content_asset_relations ADD CONSTRAINT content_asset_relations_account_edge_key UNIQUE(user_id,source_content_asset_id,target_content_asset_id,relation_type);

-- Workspace-scoped cursors can overlap. Preserve event IDs and chronological order.
ALTER TABLE public.content_events ALTER COLUMN user_id SET NOT NULL, DROP COLUMN workspace_id;
WITH positions AS (
 SELECT event_id,row_number() OVER (PARTITION BY user_id ORDER BY occurred_at,cursor,event_id) AS cursor FROM public.content_events
) UPDATE public.content_events e SET cursor=p.cursor FROM positions p WHERE e.event_id=p.event_id AND e.cursor<>p.cursor;
ALTER TABLE public.content_events ADD CONSTRAINT content_events_account_cursor_key UNIQUE(user_id,cursor);
ALTER TABLE public.workspace_content_state ALTER COLUMN user_id SET NOT NULL, DROP COLUMN workspace_id;
DELETE FROM public.workspace_content_state s USING public.workspace_content_state keep
 WHERE s.user_id=keep.user_id AND (s.next_cursor,s.updated_at,s.ctid)<(keep.next_cursor,keep.updated_at,keep.ctid);
ALTER TABLE public.workspace_content_state RENAME TO account_content_state;
ALTER TABLE public.account_content_state ADD PRIMARY KEY(user_id);
INSERT INTO public.account_content_state(user_id,next_cursor)
 SELECT user_id,max(cursor) FROM public.content_events GROUP BY user_id
 ON CONFLICT(user_id) DO UPDATE SET next_cursor=greatest(account_content_state.next_cursor,EXCLUDED.next_cursor);

DROP TABLE public.content_asset_workspaces;
UPDATE public.resource_refs SET workspace_id=NULL WHERE ref_kind='content_asset';
ALTER TABLE public.resource_refs ADD CONSTRAINT content_asset_resource_ref_account_only CHECK(ref_kind<>'content_asset' OR workspace_id IS NULL);

ALTER TABLE public.ai_template_runs DROP COLUMN workspace_id;
ALTER TABLE public.ai_template_runs ADD CONSTRAINT ai_template_runs_account_idempotency_key UNIQUE(user_id,idempotency_key);
CREATE INDEX ai_template_outline_results_idx ON public.ai_template_runs(user_id,content_asset_id,source_revision,item_key,finished_at DESC,id DESC)
 WHERE scene_key='content_asset_outline' AND state='succeeded';

-- Shared tasks retain their existing scope for document workflows. Asset tasks are account-only.
ALTER TABLE public.task_inputs ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE public.tasks DROP CONSTRAINT tasks_check;
UPDATE public.task_inputs i SET workspace_id=NULL FROM public.tasks t
 WHERE t.input_id=i.id AND t.kind IN ('content-asset.tag-extract','kb.content-asset-index','kb.content-asset-cleanup');
UPDATE public.tasks SET workspace_id=NULL WHERE kind IN ('content-asset.tag-extract','kb.content-asset-index','kb.content-asset-cleanup');
ALTER TABLE public.tasks ADD CONSTRAINT tasks_check CHECK(
 (user_id IS NULL AND workspace_id IS NULL AND kind IN ('maintenance.check','processing.node-start'))
 OR (user_id IS NOT NULL AND CASE
  WHEN kind IN ('content-asset.tag-extract','kb.content-asset-index','kb.content-asset-cleanup') THEN workspace_id IS NULL
  ELSE workspace_id IS NOT NULL OR kind='storage.delete'
 END)
);

ALTER TABLE public.kb_content_asset_hybrid_builds DROP COLUMN workspace_id;
CREATE INDEX kb_content_asset_hybrid_builds_owner ON public.kb_content_asset_hybrid_builds(user_id,source_id,created_at DESC);
-- Milvus scope fields are immutable. Rebuild current derived points on the account collection.
-- The prior collection stays outside this SQL migration.
CREATE TABLE public.account_build_rebuild AS
 SELECT latest.id,latest.user_id,gen_random_uuid() AS job_id,gen_random_uuid() AS input_id
 FROM (SELECT DISTINCT ON (b.source_id) b.id,b.user_id,b.status
 FROM public.kb_content_asset_hybrid_builds b
 JOIN public.content_assets a ON a.content_asset_id=b.source_id AND a.user_id=b.user_id AND a.state='active' AND a.processing_status='ready'
 JOIN public.content_asset_parts p ON p.content_asset_id=a.content_asset_id AND p.part='raw' AND p.part_revision_id::text=b.source_revision
 WHERE btrim(p.content_markdown)<>''
 ORDER BY b.source_id,b.created_at DESC,b.id DESC) latest
 WHERE latest.status IN ('ready','pending','indexing');

UPDATE public.kb_content_asset_hybrid_builds
 SET snapshot=jsonb_set(snapshot,'{target,collection}',to_jsonb((snapshot #>> '{target,collection}')||'_account_v1'),false)||'{"accountScope":true}'::jsonb,
 published=false,planned=false,status='superseded',cleanup_status='ready',toc=NULL,toc_status='pending',chunk_count=0;
DELETE FROM public.kb_content_asset_hybrid_chunks;
-- Retire metadata for queued old builds. Document tasks and tag tasks carry their original state.
WITH cancelled AS (
 UPDATE public.tasks SET state='cancelled',version=version+1,lease_owner=NULL,lease_until=NULL,
  retryable=false,error_code='KB_INDEX_SCOPE_CHANGED',event_sequence=event_sequence+1,updated_at=now()
 WHERE kind IN ('kb.content-asset-index','kb.content-asset-cleanup') AND state NOT IN ('succeeded','failed','cancelled')
 RETURNING id,event_sequence
) INSERT INTO public.task_events(task_id,sequence,state) SELECT id,event_sequence,'cancelled' FROM cancelled;
UPDATE public.task_outbox o SET status='superseded',lease_owner=NULL,lease_until=NULL FROM public.tasks t
 WHERE t.id=o.task_id AND t.error_code='KB_INDEX_SCOPE_CHANGED' AND o.status IN ('pending','delivering');

INSERT INTO public.task_inputs(id,user_id,body)
 SELECT input_id,user_id,jsonb_build_object('buildId',id)::text FROM public.account_build_rebuild;
INSERT INTO public.tasks(id,user_id,kind,queue,input_id,state,trace_id,max_attempts,event_sequence)
 SELECT job_id,user_id,'kb.content-asset-index','content',input_id,'queued',job_id::text,
  COALESCE((SELECT ("values"->>'tasks.maxAttempts')::integer FROM public.runtime_configuration WHERE singleton),3),1
 FROM public.account_build_rebuild;
INSERT INTO public.task_events(task_id,sequence,state) SELECT job_id,1,'queued' FROM public.account_build_rebuild;
INSERT INTO public.task_outbox(id,task_id) SELECT gen_random_uuid(),job_id FROM public.account_build_rebuild;
UPDATE public.kb_content_asset_hybrid_builds b
 SET status='pending',cleanup_status='pending',task_id=r.job_id FROM public.account_build_rebuild r WHERE r.id=b.id;
DROP TABLE public.account_build_rebuild;
