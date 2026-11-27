CREATE TABLE public.recorder_bindings (
  binding_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  device_id text NOT NULL CHECK (octet_length(device_id) BETWEEN 1 AND 128),
  model_code text NOT NULL CHECK (octet_length(model_code) BETWEEN 1 AND 128),
  display_name text CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
  transfer_mode text NOT NULL CHECK (transfer_mode IN ('auto', 'manual')),
  generation_mode text NOT NULL DEFAULT 'auto' CHECK (generation_mode IN ('auto', 'manual')),
  transcription_language text NOT NULL DEFAULT 'auto' CHECK (transcription_language = 'auto'),
  bound_at timestamptz NOT NULL DEFAULT now(),
  unbound_at timestamptz CHECK (unbound_at >= bound_at),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX recorder_bindings_active_device ON public.recorder_bindings (device_id)
  WHERE unbound_at IS NULL;
CREATE INDEX recorder_bindings_active_user ON public.recorder_bindings (user_id, bound_at DESC, binding_id)
  WHERE unbound_at IS NULL;
CREATE INDEX recorder_bindings_user_device_history ON public.recorder_bindings (user_id, device_id, bound_at DESC);
GRANT SELECT, INSERT, UPDATE ON public.recorder_bindings TO huahuo_api;

CREATE UNIQUE INDEX content_assets_recorder_source ON public.content_assets (user_id, source_id)
  WHERE source_kind = 'recorder_card';
CREATE INDEX content_assets_recorder_list ON public.content_assets
  (user_id, split_part(source_id, '.', 1), updated_at DESC, content_asset_id)
  WHERE source_kind = 'recorder_card' AND state = 'active';

-- Earlier APIs accepted custom origins. Never silently adopt one as verified recorder data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.content_assets WHERE source_kind = 'recorder_card') THEN
    RAISE EXCEPTION 'RECORDER_SOURCE_ALREADY_IN_USE';
  END IF;
END $$;

ALTER TABLE public.tasks DROP CONSTRAINT tasks_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_check CHECK (
  (user_id IS NULL AND workspace_id IS NULL AND kind IN ('maintenance.check', 'processing.node-start')) OR
  (user_id IS NOT NULL AND CASE
    WHEN kind IN ('content-asset.tag-extract', 'kb.content-asset-index', 'kb.content-asset-cleanup',
                  'content-asset.transcribe', 'content-asset.recording-outline')
      THEN workspace_id IS NULL
    ELSE workspace_id IS NOT NULL OR kind = 'storage.delete'
  END)
);
CREATE INDEX tasks_recording_outline_input ON public.tasks (external_reference, created_at DESC)
  WHERE kind = 'content-asset.recording-outline';

-- Keep unsuccessful ASR receipts while permitting another attempt for the same input.
ALTER TABLE public.funasr_jobs DROP CONSTRAINT funasr_jobs_asset_id_raw_revision_id_key;
CREATE UNIQUE INDEX funasr_jobs_active_input ON public.funasr_jobs (asset_id, raw_revision_id)
  WHERE finished_at IS NULL;
CREATE INDEX funasr_jobs_input_history ON public.funasr_jobs (asset_id, raw_revision_id);
GRANT SELECT ON public.ai_template_published TO huahuo_worker;
GRANT SELECT (scene_key, revision, catalog) ON public.ai_template_versions TO huahuo_worker;
GRANT SELECT, INSERT, UPDATE ON public.ai_template_runs TO huahuo_worker;
