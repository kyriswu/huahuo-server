-- Preserve current access and organization when moving those relationships
-- out of the content row. The migration runner executes this in one transaction.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.notes n LEFT JOIN public.asset_folders f
            ON f.folder_id = n.folder_id AND f.workspace_id = n.workspace_id
        WHERE n.folder_id IS NOT NULL AND f.folder_id IS NULL
    ) THEN
        RAISE EXCEPTION 'NOTE_FOLDER_SCOPE_MISMATCH';
    END IF;
END $$;

ALTER TABLE public.notes ADD COLUMN user_id uuid;
UPDATE public.notes n SET user_id = w.user_id
  FROM public.workspaces w WHERE w.id = n.workspace_id;
ALTER TABLE public.notes ALTER COLUMN user_id SET NOT NULL;

CREATE TABLE public.note_workspaces (
    workspace_id uuid NOT NULL,
    note_id uuid NOT NULL,
    PRIMARY KEY (workspace_id, note_id)
);
CREATE INDEX note_workspaces_note_id_idx ON public.note_workspaces (note_id, workspace_id);
INSERT INTO public.note_workspaces (workspace_id, note_id)
    SELECT workspace_id, note_id FROM public.notes;

CREATE TABLE public.note_folders (
    folder_id uuid NOT NULL,
    note_id uuid NOT NULL,
    deleted_by_folder_id uuid,
    PRIMARY KEY (folder_id, note_id)
);
CREATE INDEX note_folders_note_id_idx ON public.note_folders (note_id, folder_id);
CREATE INDEX note_folders_deletion_origin_idx ON public.note_folders (deleted_by_folder_id)
    WHERE deleted_by_folder_id IS NOT NULL;
-- Deletion origin is only needed to recover notes deleted under the old cascade.
INSERT INTO public.note_folders (folder_id, note_id, deleted_by_folder_id)
    SELECT folder_id, note_id, deleted_by_folder_id FROM public.notes WHERE folder_id IS NOT NULL;

ALTER TABLE public.notes
    DROP COLUMN workspace_id,
    DROP COLUMN folder_id,
    DROP COLUMN deleted_by_folder_id;
CREATE INDEX notes_scope ON public.notes (user_id, state, updated_at DESC, note_id);
CREATE INDEX notes_graph_page ON public.notes (user_id, note_id) WHERE state = 'active';

GRANT SELECT, INSERT ON public.note_workspaces TO huahuo_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.note_folders TO huahuo_api;
GRANT SELECT ON public.note_workspaces, public.note_folders TO huahuo_worker, huahuo_admin, huahuo_scheduler;
