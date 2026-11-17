-- Notes keep only current content. Revision numbers/UUIDs are concurrency and
-- indexing markers, not a body archive. Old writers must be drained first.
-- Target preflight found no note bodies or references; bounded inline under the
-- runner's lock/statement budgets. New environments still run frozen history.
LOCK TABLE public.note_part_revisions,public.resource_refs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.note_part_revisions p LEFT JOIN public.notes n ON n.note_id=p.note_id WHERE n.note_id IS NULL) THEN
    RAISE EXCEPTION 'NOTE_CURRENT_PART_OWNER_MISSING';
  END IF;
  IF EXISTS (SELECT 1 FROM public.resource_refs r WHERE r.ref_kind='note_revision' AND NOT EXISTS (
    SELECT 1 FROM public.note_part_revisions p JOIN public.notes n ON n.note_id=p.note_id
      JOIN public.workspaces w ON w.id=n.workspace_id
    WHERE p.part_revision_id::text=r.ref_id_external AND w.user_id=r.user_id AND n.workspace_id=r.workspace_id
  )) THEN RAISE EXCEPTION 'NOTE_REVISION_REFERENCE_OWNER_MISMATCH'; END IF;
END $$;

-- Current body references already belong to the note through syncNoteRefs.
-- Removing archive pins does not delete files or their official storage usage.
DELETE FROM public.resource_refs WHERE ref_kind='note_revision';
DELETE FROM public.note_part_revisions older USING public.note_part_revisions newer
WHERE older.note_id=newer.note_id AND older.part=newer.part AND older.revision<newer.revision;

ALTER TABLE public.note_part_revisions RENAME TO note_parts;
ALTER TABLE public.note_parts DROP CONSTRAINT note_part_revisions_pkey;
ALTER TABLE public.note_parts DROP CONSTRAINT note_part_revisions_note_id_part_revision_key;
DROP INDEX public.note_parts_latest;
ALTER TABLE public.note_parts
  ADD CONSTRAINT note_parts_pkey PRIMARY KEY(note_id,part),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
UPDATE public.note_parts SET updated_at=created_at;
ALTER TABLE public.note_parts RENAME CONSTRAINT note_part_revisions_part_check TO note_parts_part_check;
ALTER TABLE public.note_parts RENAME CONSTRAINT note_part_revisions_revision_check TO note_parts_revision_check;
