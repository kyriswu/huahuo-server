-- Pause and drain legacy ContentAsset writers before migrating. They can still
-- emit needs-processing, which the new constraint rejects.
ALTER TABLE public.content_assets
 DROP CONSTRAINT content_assets_processing_status_check;

UPDATE public.content_assets
 SET processing_status = 'draft'
 WHERE processing_status = 'needs-processing';

ALTER TABLE public.content_assets
 ADD CONSTRAINT content_assets_processing_status_check
 CHECK (processing_status IN ('draft','processing','ready','failed'));
