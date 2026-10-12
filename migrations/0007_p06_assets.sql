CREATE TABLE workspace_content_state (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 next_cursor bigint NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE content_events (
 event_id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), cursor bigint NOT NULL,
 operation_id uuid NOT NULL, object_kind text NOT NULL, object_id uuid NOT NULL, change_type text NOT NULL,
 tombstone boolean NOT NULL DEFAULT false, revision_id uuid, occurred_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,cursor)
);
CREATE INDEX content_events_scope ON content_events(workspace_id,cursor);
CREATE TABLE asset_folders (
 folder_id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), parent_folder_id uuid,
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120), normalized_name text NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','deleted')), revision bigint NOT NULL DEFAULT 1,
 current_revision_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(parent_folder_id) REFERENCES asset_folders(folder_id), UNIQUE(workspace_id,folder_id),
 UNIQUE(workspace_id,parent_folder_id,normalized_name) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX asset_folders_parent ON asset_folders(workspace_id,parent_folder_id,state);
CREATE TABLE notes (
 note_id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), folder_id uuid,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 240), source_kind text NOT NULL DEFAULT 'manual', source_id text,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','deleted')), note_revision bigint NOT NULL DEFAULT 1,
 note_revision_id uuid NOT NULL, etag text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(folder_id) REFERENCES asset_folders(folder_id), UNIQUE(workspace_id,note_id)
);
CREATE INDEX notes_scope ON notes(workspace_id,state,updated_at DESC,note_id);
CREATE TABLE note_part_revisions (
 part_revision_id uuid PRIMARY KEY, note_id uuid NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
 part text NOT NULL CHECK(part IN ('raw','outline','germination')), revision integer NOT NULL CHECK(revision>0),
 content_markdown text NOT NULL, content_sha256 char(64) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(note_id,part,revision)
);
CREATE INDEX note_parts_latest ON note_part_revisions(note_id,part,revision DESC);
CREATE TABLE note_resource_refs (
 note_id uuid NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE, resource_id uuid NOT NULL REFERENCES resources(resource_id),
 ref_order integer NOT NULL CHECK(ref_order>=0), usage text NOT NULL, anchor text, alt text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(note_id,ref_order), UNIQUE(note_id,resource_id,usage,anchor)
);
CREATE TABLE asset_tags (
 tag_id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), normalized_name text NOT NULL,
 display_name text NOT NULL, source text NOT NULL CHECK(source IN ('manual','extracted','merged')), locked boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,normalized_name)
);
CREATE TABLE note_tags (
 note_id uuid NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE, tag_id uuid NOT NULL REFERENCES asset_tags(tag_id) ON DELETE CASCADE,
 source text NOT NULL CHECK(source IN ('manual','extracted')), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(note_id,tag_id)
);
CREATE TABLE note_relations (
 relation_id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), source_note_id uuid NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
 target_note_id uuid NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE, relation_type text NOT NULL CHECK(relation_type IN ('references','supports','contradicts','related')),
 origin text NOT NULL DEFAULT 'explicit' CHECK(origin IN ('explicit','automatic')), rationale text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1, etag text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK(source_note_id<>target_note_id),
 UNIQUE(workspace_id,source_note_id,target_note_id,relation_type)
);
CREATE TABLE content_jobs (
 task_id uuid PRIMARY KEY REFERENCES tasks(id), note_id uuid NOT NULL REFERENCES notes(note_id), note_revision_id uuid NOT NULL, operation text NOT NULL CHECK(operation IN ('tag_extract','import')), UNIQUE(note_id,note_revision_id,operation)
);
ALTER TABLE notes ADD COLUMN search_vector tsvector;
CREATE INDEX notes_search_gin ON notes USING gin(search_vector);
CREATE OR REPLACE FUNCTION notes_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.search_vector := setweight(to_tsvector('simple',coalesce(NEW.title,'')),'A') || setweight(to_tsvector('simple',coalesce((SELECT string_agg(content_markdown,' ') FROM note_part_revisions WHERE note_id=NEW.note_id AND part='raw'),'')),'B'); RETURN NEW; END $$;
CREATE TRIGGER notes_search_vector_trigger BEFORE INSERT OR UPDATE OF title ON notes FOR EACH ROW EXECUTE FUNCTION notes_search_vector_update();
GRANT SELECT,INSERT,UPDATE,DELETE ON workspace_content_state,content_events,asset_folders,notes,note_part_revisions,note_resource_refs,asset_tags,note_tags,note_relations,content_jobs TO huahuo_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON workspace_content_state,content_events,asset_folders,notes,note_part_revisions,note_resource_refs,asset_tags,note_tags,note_relations,content_jobs TO huahuo_worker;
GRANT SELECT ON workspace_content_state,content_events,asset_folders,notes,note_part_revisions,note_resource_refs,asset_tags,note_tags,note_relations,content_jobs TO huahuo_admin,huahuo_scheduler;
CREATE UNIQUE INDEX asset_folders_root_name ON asset_folders(workspace_id,normalized_name) WHERE parent_folder_id IS NULL;
