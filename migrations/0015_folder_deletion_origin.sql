-- Existing deleted rows stay unclassified. Restoring a folder must not guess
-- that their deletion was cascaded. Nullable columns need no data backfill.
-- Old binaries ignore these fields but lack the restoration semantics; update
-- application roles together. The runner supplies transaction/lock budgets.
ALTER TABLE asset_folders ADD COLUMN deleted_by_folder_id uuid;
ALTER TABLE notes ADD COLUMN deleted_by_folder_id uuid;
CREATE INDEX asset_folders_deletion_origin_idx ON asset_folders(workspace_id, deleted_by_folder_id)
  WHERE deleted_by_folder_id IS NOT NULL;
CREATE INDEX notes_deletion_origin_idx ON notes(workspace_id, deleted_by_folder_id)
  WHERE deleted_by_folder_id IS NOT NULL;
