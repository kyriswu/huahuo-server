CREATE TABLE task_inputs (
 id uuid PRIMARY KEY, user_id uuid NOT NULL, workspace_id uuid NOT NULL,
 body text NOT NULL CHECK(length(body)<=10000), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,user_id) REFERENCES workspaces(id,user_id)
);
CREATE TABLE tasks (
 id uuid PRIMARY KEY, user_id uuid, workspace_id uuid, kind text NOT NULL,
 queue text NOT NULL CHECK(queue IN ('content','ai','commercial','maintenance')),
 input_id uuid REFERENCES task_inputs(id),
 state text NOT NULL CHECK(state IN ('queued','running','retry_scheduled','waiting_external','reconciling','cancel_requested','succeeded','failed','cancelled')),
 version integer NOT NULL DEFAULT 1, attempt_no integer NOT NULL DEFAULT 0,
 max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 9),
 lease_owner uuid, lease_until timestamptz, available_at timestamptz NOT NULL DEFAULT now(),
 external_state text NOT NULL DEFAULT 'none' CHECK(external_state IN ('none','submitted','unknown')),
 external_reference text, result_id uuid, error_code text, retryable boolean NOT NULL DEFAULT false,
 cancel_requested_at timestamptz, event_sequence integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,user_id) REFERENCES workspaces(id,user_id),
 CHECK((user_id IS NULL AND workspace_id IS NULL AND kind='maintenance.check') OR (user_id IS NOT NULL AND workspace_id IS NOT NULL)),
 CHECK(state<>'succeeded' OR result_id IS NOT NULL)
);
CREATE INDEX tasks_scope ON tasks(user_id,workspace_id,created_at DESC);
CREATE INDEX tasks_recovery ON tasks(state,available_at,lease_until);
CREATE TABLE task_attempts (
 task_id uuid NOT NULL REFERENCES tasks(id), attempt_no integer NOT NULL, version integer NOT NULL,
 owner uuid NOT NULL, state text NOT NULL, error_code text,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 PRIMARY KEY(task_id,attempt_no)
);
CREATE TABLE task_outbox (
 id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivering','sent','superseded')),
 available_at timestamptz NOT NULL DEFAULT now(), lease_owner uuid, lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0, sent_at timestamptz, last_error text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX task_one_pending_delivery ON task_outbox(task_id) WHERE status IN ('pending','delivering');
CREATE INDEX outbox_due ON task_outbox(status,available_at);
CREATE TABLE task_results (
 id uuid PRIMARY KEY, task_id uuid NOT NULL UNIQUE REFERENCES tasks(id), attempt_no integer NOT NULL,
 digest text NOT NULL, byte_count integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tasks ADD FOREIGN KEY(result_id) REFERENCES task_results(id);
CREATE TABLE task_events (
 task_id uuid NOT NULL REFERENCES tasks(id), sequence integer NOT NULL, state text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(task_id,sequence)
);
CREATE TABLE task_requests (
 scope text NOT NULL, operation text NOT NULL, key text NOT NULL, request_hash text NOT NULL,
 response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,operation,key)
);
CREATE TABLE task_schedules (
 id text PRIMARY KEY, interval_seconds integer NOT NULL CHECK(interval_seconds>=60),
 enabled boolean NOT NULL DEFAULT true, last_window bigint,
 lease_owner uuid, lease_until timestamptz
);
CREATE TABLE task_schedule_windows (
 schedule_id text NOT NULL REFERENCES task_schedules(id), window_id bigint NOT NULL,
 task_id uuid NOT NULL UNIQUE REFERENCES tasks(id), PRIMARY KEY(schedule_id,window_id)
);
INSERT INTO task_schedules(id,interval_seconds) VALUES('maintenance-check-v1',3600);
GRANT SELECT,INSERT ON task_inputs TO huahuo_api;
GRANT SELECT ON task_inputs TO huahuo_worker;
GRANT SELECT,INSERT,UPDATE ON tasks,task_outbox,task_requests TO huahuo_api;
GRANT SELECT,INSERT ON task_events TO huahuo_api;
GRANT SELECT ON task_results TO huahuo_api;
GRANT SELECT,UPDATE ON tasks TO huahuo_worker;
GRANT SELECT,INSERT,UPDATE ON task_attempts TO huahuo_worker;
GRANT SELECT,INSERT ON task_results,task_events,task_outbox TO huahuo_worker;
GRANT SELECT,INSERT,UPDATE ON tasks,task_outbox,task_schedules TO huahuo_scheduler;
GRANT SELECT,UPDATE ON task_attempts TO huahuo_scheduler;
GRANT SELECT,INSERT ON task_events,task_schedule_windows TO huahuo_scheduler;
GRANT SELECT,UPDATE ON tasks TO huahuo_admin;
GRANT SELECT ON task_attempts,task_outbox TO huahuo_admin;
GRANT SELECT,INSERT ON task_events,task_requests,task_outbox TO huahuo_admin;
