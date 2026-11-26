CREATE TABLE public.content_asset_audio_transcripts (
  content_asset_id uuid PRIMARY KEY,
  resource_id uuid NOT NULL,
  transcription_id uuid NOT NULL UNIQUE,
  segment_count integer NOT NULL CHECK (segment_count >= 0),
  content_revision bigint NOT NULL DEFAULT 0 CHECK (content_revision >= 0),
  transcript jsonb NOT NULL
);

GRANT SELECT, INSERT, UPDATE ON TABLE public.content_asset_audio_transcripts TO huahuo_api, huahuo_worker;
