-- P02 identity is owned by the migrator. Runtime grants are domain-specific.
CREATE TABLE app_users (
 id uuid PRIMARY KEY, phone_hash text NOT NULL UNIQUE, phone_masked text NOT NULL,
 display_name text NOT NULL DEFAULT '花火用户', time_zone text NOT NULL DEFAULT 'UTC',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspaces (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_users(id), display_name text NOT NULL,
 state text NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','disabled')),
 is_default boolean NOT NULL DEFAULT false, is_initial boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1, bootstrap_receipt_id uuid NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,user_id)
);
CREATE UNIQUE INDEX workspace_default ON workspaces(user_id) WHERE is_default;
CREATE UNIQUE INDEX workspace_initial ON workspaces(user_id) WHERE is_initial;
CREATE TABLE workspace_profiles (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id),
 name text NOT NULL, industry text NOT NULL, account_goal text NOT NULL, target_audience text,
 common_expressions jsonb NOT NULL DEFAULT '[]', version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE onboarding_drafts (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id), mode text NOT NULL DEFAULT '' CHECK(mode IN ('','business','no_business')),
 step_index integer NOT NULL DEFAULT 0 CHECK(step_index BETWEEN 0 AND 6), answers jsonb NOT NULL DEFAULT '{}',
 deferred_at timestamptz, version integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE otp_requests (
 id uuid PRIMARY KEY, phone_hash text NOT NULL, purpose text NOT NULL CHECK(purpose='login'),
 code_hash text NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 delivery text NOT NULL CHECK(delivery IN ('pending','sent','failed')), provider_mode text NOT NULL,
 request_key text, request_hash text NOT NULL, response_cipher text,
 expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(phone_hash,request_key)
);
CREATE INDEX otp_phone_created ON otp_requests(phone_hash,created_at DESC);
CREATE TABLE user_sessions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_users(id), device_id text NOT NULL,
 access_hash text NOT NULL UNIQUE, access_expires_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON user_sessions(user_id);
CREATE TABLE refresh_tokens (
 token_hash text PRIMARY KEY, session_id uuid NOT NULL REFERENCES user_sessions(id), consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agreement_acceptances (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_users(id), session_id uuid NOT NULL REFERENCES user_sessions(id),
 agreement_version text NOT NULL, privacy_version text NOT NULL, action text NOT NULL CHECK(action='sms_login'),
 accepted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE api_idempotency (
 scope text NOT NULL, operation text NOT NULL, key text NOT NULL, request_hash text NOT NULL,
 response_cipher text NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(scope,operation,key)
);
CREATE TABLE auth_rate_limits (
 key text PRIMARY KEY, window_started_at timestamptz NOT NULL DEFAULT now(), hits integer NOT NULL DEFAULT 1
);
CREATE TABLE user_audit_events (
 id uuid PRIMARY KEY, user_id uuid REFERENCES app_users(id), session_id uuid, action text NOT NULL,
 target_id text, trace_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE admin_users (
 id uuid PRIMARY KEY, username text NOT NULL UNIQUE, password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('operator','superadmin')), disabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE admin_sessions (
 id uuid PRIMARY KEY, admin_id uuid NOT NULL REFERENCES admin_users(id), session_hash text NOT NULL UNIQUE,
 csrf_hash text NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE admin_login_limits (
 key text PRIMARY KEY, window_started_at timestamptz NOT NULL DEFAULT now(), hits integer NOT NULL DEFAULT 1
);
CREATE TABLE admin_audit_events (
 id uuid PRIMARY KEY, admin_id uuid, action text NOT NULL, target_id text, reason text,
 trace_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT,UPDATE ON app_users,workspaces,workspace_profiles,onboarding_drafts,otp_requests,user_sessions,refresh_tokens,api_idempotency,auth_rate_limits TO huahuo_api;
GRANT SELECT,INSERT ON agreement_acceptances,user_audit_events TO huahuo_api;
GRANT SELECT,INSERT,UPDATE ON admin_users,admin_sessions,admin_login_limits TO huahuo_admin;
GRANT SELECT,INSERT ON admin_audit_events TO huahuo_admin;
-- Worker/scheduler have no identity/admin grants in P02. No runtime role can delete audit records.
