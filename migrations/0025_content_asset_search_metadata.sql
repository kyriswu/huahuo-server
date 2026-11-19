-- An occupied legacy index requires a deliberate maintenance decision before
-- switching collections. Never queue old model work or discard data implicitly.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.kb_content_asset_hybrid_builds)
 OR EXISTS (SELECT 1 FROM public.kb_content_asset_hybrid_chunks)
 OR EXISTS (SELECT 1 FROM public.tasks WHERE kind IN ('kb.content-asset-index','kb.content-asset-cleanup')
   AND state NOT IN ('succeeded','failed','cancelled')) THEN
  RAISE EXCEPTION 'CONTENT_ASSET_LEGACY_INDEX_MAINTENANCE_REQUIRED';
 END IF;
END $$;

ALTER TABLE public.content_assets ADD COLUMN asset_kind text NOT NULL DEFAULT 'creative'
 CHECK (asset_kind IN ('audio','image','file','creative'));
UPDATE public.content_assets
 SET asset_kind=CASE lower(source_kind)
  WHEN 'audio' THEN 'audio' WHEN 'recording' THEN 'audio'
  WHEN 'image' THEN 'image' WHEN 'photo' THEN 'image'
  WHEN 'document' THEN 'file' WHEN 'file' THEN 'file' WHEN 'import' THEN 'file' WHEN 'pdf' THEN 'file'
  ELSE 'creative' END
 WHERE lower(source_kind) IN ('audio','recording','image','photo','document','file','import','pdf');
