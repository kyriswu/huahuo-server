-- Retire the placement table in a maintenance cutover. Keep pointers to
-- soft-deleted folders so a later restore reveals the original placement.
LOCK TABLE public.asset_folders IN SHARE MODE;
LOCK TABLE public.content_assets, public.content_asset_folders IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
 duplicate_assets bigint;
 orphan_links bigint;
 cross_account_links bigint;
BEGIN
 SELECT count(*) INTO duplicate_assets FROM (
  SELECT content_asset_id FROM public.content_asset_folders
  GROUP BY content_asset_id HAVING count(*) > 1
 ) AS duplicates;
 SELECT count(*) FILTER (WHERE a.content_asset_id IS NULL OR f.folder_id IS NULL),
        count(*) FILTER (WHERE a.content_asset_id IS NOT NULL AND f.folder_id IS NOT NULL AND a.user_id IS DISTINCT FROM f.user_id)
   INTO orphan_links, cross_account_links
 FROM public.content_asset_folders m
 LEFT JOIN public.content_assets a USING (content_asset_id)
 LEFT JOIN public.asset_folders f USING (folder_id);
 IF duplicate_assets > 0 OR orphan_links > 0 OR cross_account_links > 0 THEN
  RAISE EXCEPTION 'CONTENT_ASSET_FOLDER_AUDIT_FAILED: duplicate_assets=%, orphan_links=%, cross_account_links=%',
    duplicate_assets, orphan_links, cross_account_links;
 END IF;
END $$;

ALTER TABLE public.content_assets ADD COLUMN folder_id uuid;
UPDATE public.content_assets a SET folder_id=m.folder_id
FROM public.content_asset_folders m
WHERE m.content_asset_id=a.content_asset_id;

DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM public.content_assets a
  LEFT JOIN public.content_asset_folders m USING (content_asset_id)
  WHERE a.folder_id IS DISTINCT FROM m.folder_id
 ) THEN
  RAISE EXCEPTION 'CONTENT_ASSET_FOLDER_BACKFILL_MISMATCH';
 END IF;
END $$;

CREATE INDEX content_assets_folder_page
 ON public.content_assets(folder_id, user_id, state, updated_at DESC, content_asset_id);
COMMENT ON COLUMN public.content_assets.folder_id IS 'Single folder placement, including soft-deleted folders retained for restoration.';
DROP TABLE public.content_asset_folders;
