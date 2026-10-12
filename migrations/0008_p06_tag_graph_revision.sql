ALTER TABLE notes
  ADD COLUMN tag_set_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN tag_manual_override boolean NOT NULL DEFAULT false;

-- Preserve earlier effective sets, including human/locked classifications.
UPDATE notes n SET tag_set_version=1,
 tag_manual_override=EXISTS(SELECT 1 FROM note_tags m JOIN asset_tags t ON t.tag_id=m.tag_id
   WHERE m.note_id=n.note_id AND (m.source='manual' OR t.locked))
 WHERE EXISTS(SELECT 1 FROM note_tags m WHERE m.note_id=n.note_id);
GRANT SELECT(id,user_id,state) ON workspaces TO huahuo_worker;

CREATE TABLE note_tag_suggestions (
  suggestion_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  note_revision_id uuid NOT NULL,
  expected_tag_set_version bigint NOT NULL,
  labels jsonb NOT NULL,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','dismissed','stale')),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  UNIQUE(task_id)
);
CREATE INDEX note_tag_suggestions_scope ON note_tag_suggestions(workspace_id,note_id,status,created_at DESC);

GRANT SELECT,INSERT,UPDATE,DELETE ON note_tag_suggestions TO huahuo_api;
GRANT SELECT,INSERT,UPDATE ON note_tag_suggestions TO huahuo_worker;
GRANT SELECT ON note_tag_suggestions TO huahuo_admin,huahuo_scheduler;

ALTER TABLE asset_tags
  ADD CONSTRAINT asset_tags_name_length CHECK(length(normalized_name) BETWEEN 1 AND 24 AND length(display_name) BETWEEN 1 AND 24) NOT VALID;

-- Existing mappings and history are preserved. Re-extraction is a new task,
-- while request idempotency and active-job deduplication remain authoritative.
ALTER TABLE content_jobs DROP CONSTRAINT content_jobs_note_id_note_revision_id_operation_key;
ALTER TABLE content_jobs ADD COLUMN outcome text, ADD COLUMN provider text;
CREATE INDEX content_jobs_note ON content_jobs(note_id,note_revision_id);
CREATE INDEX note_tags_topic_members ON note_tags(tag_id,note_id);
CREATE INDEX notes_graph_page ON notes(workspace_id,note_id) WHERE state='active';
ALTER TABLE notes ADD COLUMN processing_status text NOT NULL DEFAULT 'ready'
  CHECK(processing_status IN ('ready','needs-processing'));
UPDATE notes n SET processing_status='needs-processing' WHERE NOT EXISTS(
 SELECT 1 FROM (SELECT content_markdown FROM note_part_revisions p
 WHERE p.note_id=n.note_id AND part='raw' ORDER BY revision DESC LIMIT 1) latest
 WHERE length(trim(latest.content_markdown))>0);
-- Folder deletion/restoration must invalidate extraction even when text is unchanged.
CREATE FUNCTION note_tags_lifecycle_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state IS DISTINCT FROM OLD.state THEN
   NEW.tag_set_version := OLD.tag_set_version + 1;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER note_tags_lifecycle_fence BEFORE UPDATE OF state ON notes
 FOR EACH ROW EXECUTE FUNCTION note_tags_lifecycle_fence();
-- Update the existing index, not a second text store. Past revisions stay intact.
CREATE OR REPLACE FUNCTION notes_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.search_vector := setweight(to_tsvector('simple',coalesce(NEW.title,'')),'A') ||
   setweight(to_tsvector('simple',coalesce((SELECT content_markdown FROM note_part_revisions
     WHERE note_id=NEW.note_id AND part='raw' ORDER BY revision DESC LIMIT 1),'')),'B');
 RETURN NEW;
END $$;
UPDATE notes SET title=title;
