-- Preserve explicit file, image and audio kinds and existing revision/sort fields.
ALTER TABLE public.content_assets
 DROP CONSTRAINT content_assets_asset_kind_check,
 ADD CONSTRAINT content_assets_asset_kind_check
 CHECK (asset_kind IN ('audio','image','file','creative','link'));

UPDATE public.content_assets
 SET asset_kind='link'
 WHERE asset_kind='creative' AND source_kind ~* '^[[:space:]]*link[[:space:]]*$';
