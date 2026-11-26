ALTER TABLE public.funasr_jobs
  ADD COLUMN segment_count integer CHECK (segment_count >= 0),
  ADD COLUMN speaker_ids text[] NOT NULL DEFAULT '{}';

CREATE TABLE public.funasr_transcript_edits (
  task_id uuid NOT NULL,
  segment_index integer NOT NULL CHECK (segment_index >= 0),
  text text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (task_id, segment_index)
);

GRANT SELECT, INSERT, UPDATE ON TABLE public.funasr_transcript_edits TO huahuo_api;
