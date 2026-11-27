ALTER TABLE public.tasks DROP CONSTRAINT tasks_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_check CHECK (
  (user_id IS NULL AND workspace_id IS NULL AND kind IN ('maintenance.check', 'processing.node-start')) OR
  (user_id IS NOT NULL AND CASE
    WHEN kind IN ('content-asset.tag-extract', 'kb.content-asset-index', 'kb.content-asset-cleanup',
                  'content-asset.transcribe', 'content-asset.recording-outline', 'content-asset.link-extract')
      THEN workspace_id IS NULL
    ELSE workspace_id IS NOT NULL OR kind = 'storage.delete'
  END)
);

ALTER TABLE public.content_jobs
  ADD COLUMN source_platform text,
  ADD COLUMN source_content_type text,
  ADD CONSTRAINT content_jobs_source_metadata CHECK (
    (source_platform IS NULL AND source_content_type IS NULL) OR
    (operation = 'import' AND source_platform IS NOT NULL AND source_content_type IS NOT NULL)
  );
