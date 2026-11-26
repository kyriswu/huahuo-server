-- ASR attempt receipts and GPU allocations. No existing business rows require a backfill.
ALTER TABLE public.tasks DROP CONSTRAINT tasks_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_check CHECK (
  (user_id IS NULL AND workspace_id IS NULL AND kind IN ('maintenance.check', 'processing.node-start')) OR
  (user_id IS NOT NULL AND CASE
    WHEN kind IN ('content-asset.tag-extract', 'kb.content-asset-index', 'kb.content-asset-cleanup', 'content-asset.transcribe')
      THEN workspace_id IS NULL
    ELSE workspace_id IS NOT NULL OR kind = 'storage.delete'
  END)
);

CREATE TABLE public.funasr_allocations (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('fixed', 'acs')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'releasing', 'released')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX funasr_allocations_active ON public.funasr_allocations (provider) WHERE state = 'active';
CREATE INDEX funasr_allocations_releasing ON public.funasr_allocations (provider, created_at) WHERE state = 'releasing';

CREATE TABLE public.funasr_jobs (
  task_id uuid PRIMARY KEY,
  submission_id uuid NOT NULL UNIQUE,
  asset_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  raw_revision_id uuid NOT NULL,
  allocation_id uuid,
  base_url text,
  remote_task_id text UNIQUE,
  deadline_at timestamptz,
  poll_at timestamptz,
  upload_attempts integer NOT NULL DEFAULT 0 CHECK (upload_attempts >= 0),
  poll_attempts integer NOT NULL DEFAULT 0 CHECK (poll_attempts >= 0),
  event_id text UNIQUE,
  event_hash text,
  transcript jsonb,
  error_code text,
  delivery text CHECK (delivery IN ('callback','poll')),
  asset_applied boolean NOT NULL DEFAULT false,
  finished_at timestamptz,
  UNIQUE (asset_id, raw_revision_id),
  CHECK ((event_id IS NULL) = (event_hash IS NULL)),
  CHECK ((event_id IS NULL) = (delivery IS NULL))
);
CREATE INDEX funasr_jobs_allocation ON public.funasr_jobs (allocation_id, finished_at) WHERE allocation_id IS NOT NULL;
GRANT SELECT, INSERT, UPDATE ON TABLE public.funasr_jobs TO huahuo_api, huahuo_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE public.funasr_allocations TO huahuo_worker;
GRANT INSERT ON TABLE public.task_inputs TO huahuo_worker;
