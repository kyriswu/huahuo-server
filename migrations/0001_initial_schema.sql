-- Canonical PostgreSQL 17+ schema. Fresh initialization only.
-- Users and authentication are shared across App, Web and API.
-- Relations use ordinary IDs and indexes; application services enforce ownership.
-- This file contains no user data, secrets, physical foreign keys or upgrade paths.
SET LOCAL check_function_bodies=false;

-- Product-wide users shared by App, Web and API. No physical foreign keys.
CREATE TABLE public.users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 display_name text NOT NULL DEFAULT '花火用户',
 avatar_resource_id uuid,
 time_zone text NOT NULL DEFAULT 'UTC',
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','deleted')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz,
 CONSTRAINT users_display_name_not_blank CHECK(btrim(display_name)<>''),
 CONSTRAINT users_deleted_at_matches_status CHECK((status='deleted' AND deleted_at IS NOT NULL) OR (status<>'deleted' AND deleted_at IS NULL))
);
CREATE INDEX users_avatar_resource_id_idx ON public.users(avatar_resource_id);
COMMENT ON TABLE public.users IS '跨 App、Web、API 共用的统一用户账号。';
COMMENT ON COLUMN public.users.avatar_resource_id IS '可选头像资源ID；普通关联字段，由资源服务校验归属，不创建物理外键。';
CREATE TABLE public.user_identities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider IN ('phone','email','oauth')),
 subject_hash text NOT NULL,
 subject_masked text NOT NULL,
 provider_subject text,
 verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT user_identities_subject_hash_sha256 CHECK(subject_hash~'^[a-f0-9]{64}$'),
 CONSTRAINT user_identities_phone_masked CHECK(provider<>'phone' OR subject_masked~'^[0-9]{3}[*]{4}[0-9]{4}$'),
 CONSTRAINT user_identities_oauth_subject CHECK(provider<>'oauth' OR (provider_subject IS NOT NULL AND btrim(provider_subject)<>'')),
 UNIQUE(provider,subject_hash)
);
CREATE INDEX user_identities_user_id_idx ON public.user_identities(user_id);
COMMENT ON TABLE public.user_identities IS '服务端HMAC-SHA256身份摘要和脱敏标识；用户与登录方式分离，不保存明文手机号或邮箱。';
CREATE TABLE public.otp_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 provider text NOT NULL DEFAULT 'phone' CHECK(provider='phone'),
 subject_hash text NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('sign_in','sign_up','reset_password','bind_phone')),
 code_hash text NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 delivery_status text NOT NULL DEFAULT 'pending' CHECK(delivery_status IN ('pending','sent','failed')),
 provider_mode text NOT NULL CHECK(provider_mode IN ('mock','live')),
 request_key text,
 request_hash text NOT NULL,
 response_cipher text,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT otp_requests_subject_hash_sha256 CHECK(subject_hash~'^[a-f0-9]{64}$'),
 CONSTRAINT otp_requests_expiry_after_creation CHECK(expires_at>created_at),
 UNIQUE(provider,subject_hash,request_key)
);
CREATE INDEX otp_requests_subject_created_idx ON public.otp_requests(subject_hash,created_at DESC);
CREATE INDEX otp_requests_active_idx ON public.otp_requests(subject_hash,expires_at) WHERE consumed_at IS NULL AND delivery_status='sent';
CREATE TABLE public.user_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL,
 client_type text NOT NULL CHECK(client_type IN ('app','web')),
 client_id text NOT NULL CHECK(btrim(client_id)<>''),
 access_jti uuid NOT NULL DEFAULT gen_random_uuid(),
 access_hash text NOT NULL UNIQUE,
 access_expires_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT user_sessions_access_hash_sha256 CHECK(access_hash~'^[a-f0-9]{64}$'),
 CONSTRAINT user_sessions_expiry_order CHECK(access_expires_at<=expires_at)
);
CREATE INDEX user_sessions_user_id_idx ON public.user_sessions(user_id);
CREATE INDEX user_sessions_active_user_idx ON public.user_sessions(user_id,expires_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX user_sessions_access_jti_idx ON public.user_sessions(access_jti);
CREATE TABLE public.refresh_tokens (
 token_hash text PRIMARY KEY,
 session_id uuid NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 last_used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT refresh_tokens_hash_sha256 CHECK(token_hash~'^[a-f0-9]{64}$'),
 CONSTRAINT refresh_tokens_expiry_after_creation CHECK(expires_at>created_at)
);
CREATE INDEX refresh_tokens_session_id_idx ON public.refresh_tokens(session_id);
CREATE INDEX refresh_tokens_active_session_idx ON public.refresh_tokens(session_id,expires_at) WHERE consumed_at IS NULL;
CREATE TABLE public.user_api_keys (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL,
 name text NOT NULL,
 key_prefix text NOT NULL,
 secret_hash text NOT NULL UNIQUE,
 scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
 expires_at timestamptz,
 last_used_at timestamptz,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT user_api_keys_name_not_blank CHECK(btrim(name)<>''),
 CONSTRAINT user_api_keys_prefix_not_blank CHECK(btrim(key_prefix)<>''),
 CONSTRAINT user_api_keys_secret_hash_sha256 CHECK(secret_hash~'^[a-f0-9]{64}$'),
 CONSTRAINT user_api_keys_expiry_after_creation CHECK(expires_at IS NULL OR expires_at>created_at)
);
CREATE INDEX user_api_keys_user_id_idx ON public.user_api_keys(user_id);
CREATE INDEX user_api_keys_active_user_idx ON public.user_api_keys(user_id,expires_at) WHERE revoked_at IS NULL;
CREATE TABLE public.user_agreement_acceptances (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL,
 session_id uuid,
 agreement_version text NOT NULL,
 privacy_version text NOT NULL,
 accepted_via text NOT NULL CHECK(accepted_via IN ('app','web','api')),
 accepted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_agreement_acceptances_user_idx ON public.user_agreement_acceptances(user_id,accepted_at DESC);
CREATE INDEX user_agreement_acceptances_session_id_idx ON public.user_agreement_acceptances(session_id);
CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.updated_at=now();
 RETURN NEW;
END;
$$;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER user_identities_set_updated_at BEFORE UPDATE ON public.user_identities FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--





CREATE FUNCTION public.note_tags_lifecycle_fence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.state IS DISTINCT FROM OLD.state THEN
   NEW.tag_set_version := OLD.tag_set_version + 1;
 END IF;
 RETURN NEW;
END $$;










CREATE TABLE public.account_memberships (
    membership_id uuid NOT NULL,
    user_id uuid NOT NULL,
    level_code text NOT NULL,
    status text NOT NULL,
    policy_version text NOT NULL,
    source text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_memberships_level_code_check CHECK ((level_code = ANY (ARRAY['free'::text, 'pilot_paid'::text, 'pro'::text, 'max'::text]))),
    CONSTRAINT account_memberships_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'grace_period'::text, 'cancelled'::text, 'expired'::text, 'refunded'::text, 'revoked'::text])))
);



CREATE TABLE public.admin_audit_events (
    id uuid NOT NULL,
    admin_id uuid,
    action text NOT NULL,
    target_id text,
    reason text,
    trace_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE public.admin_login_limits (
    key text NOT NULL,
    window_started_at timestamp with time zone DEFAULT now() NOT NULL,
    hits integer DEFAULT 1 NOT NULL
);



CREATE TABLE public.admin_sessions (
    id uuid NOT NULL,
    admin_id uuid NOT NULL,
    session_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE public.admin_users (
    id uuid NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL,
    disabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_users_role_check CHECK ((role = ANY (ARRAY['operator'::text, 'superadmin'::text])))
);



CREATE TABLE public.api_idempotency (
    scope text NOT NULL,
    operation text NOT NULL,
    key text NOT NULL,
    request_hash text NOT NULL,
    response_cipher text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);



CREATE TABLE public.asset_folders (
    folder_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    parent_folder_id uuid,
    display_name text NOT NULL,
    normalized_name text NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    current_revision_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asset_folders_display_name_check CHECK (((length(display_name) >= 1) AND (length(display_name) <= 120))),
    CONSTRAINT asset_folders_state_check CHECK ((state = ANY (ARRAY['active'::text, 'deleted'::text])))
);



CREATE TABLE public.asset_tags (
    tag_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    normalized_name text NOT NULL,
    display_name text NOT NULL,
    source text NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asset_tags_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'extracted'::text, 'merged'::text])))
);



CREATE TABLE public.auth_rate_limits (
    key text NOT NULL,
    window_started_at timestamp with time zone DEFAULT now() NOT NULL,
    hits integer DEFAULT 1 NOT NULL
);



CREATE TABLE public.billing_policies (
    policy_version text NOT NULL,
    mode text NOT NULL,
    monthly_credit_limit bigint NOT NULL,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT billing_policies_mode_check CHECK ((mode = ANY (ARRAY['development'::text, 'live'::text, 'disabled'::text]))),
    CONSTRAINT billing_policies_monthly_credit_limit_check CHECK ((monthly_credit_limit >= 0))
);



CREATE TABLE public.content_events (
    event_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    cursor bigint NOT NULL,
    operation_id uuid NOT NULL,
    object_kind text NOT NULL,
    object_id uuid NOT NULL,
    change_type text NOT NULL,
    tombstone boolean DEFAULT false NOT NULL,
    revision_id uuid,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE public.content_jobs (
    task_id uuid NOT NULL,
    note_id uuid NOT NULL,
    note_revision_id uuid NOT NULL,
    operation text NOT NULL,
    outcome text,
    provider text,
    CONSTRAINT content_jobs_operation_check CHECK ((operation = ANY (ARRAY['tag_extract'::text, 'import'::text])))
);



CREATE TABLE public.credit_ledger_entries (
    entry_id uuid NOT NULL,
    user_id uuid NOT NULL,
    reservation_id uuid,
    lot_id uuid,
    entry_type text NOT NULL,
    credits bigint NOT NULL,
    currency character(3),
    minor_amount bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT credit_ledger_entries_entry_type_check CHECK ((entry_type = ANY (ARRAY['grant'::text, 'reserve'::text, 'commit'::text, 'release'::text, 'adjustment'::text, 'uncovered'::text])))
);



CREATE TABLE public.credit_lots (
    lot_id uuid NOT NULL,
    user_id uuid NOT NULL,
    lot_kind text NOT NULL,
    policy_version text NOT NULL,
    period_start date,
    period_end date,
    expires_at timestamp with time zone,
    granted_credits bigint NOT NULL,
    available_credits bigint NOT NULL,
    reserved_credits bigint DEFAULT 0 NOT NULL,
    settled_credits bigint DEFAULT 0 NOT NULL,
    source text NOT NULL,
    grant_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT credit_lots_available_credits_check CHECK ((available_credits >= 0)),
    CONSTRAINT credit_lots_check CHECK ((((lot_kind = 'monthly'::text) AND (period_start IS NOT NULL) AND (period_end IS NOT NULL)) OR ((lot_kind = 'permanent'::text) AND (period_start IS NULL) AND (period_end IS NULL)))),
    CONSTRAINT credit_lots_granted_credits_check CHECK ((granted_credits >= 0)),
    CONSTRAINT credit_lots_lot_kind_check CHECK ((lot_kind = ANY (ARRAY['monthly'::text, 'permanent'::text]))),
    CONSTRAINT credit_lots_reserved_credits_check CHECK ((reserved_credits >= 0)),
    CONSTRAINT credit_lots_settled_credits_check CHECK ((settled_credits >= 0))
);



CREATE TABLE public.credit_reservation_lots (
    reservation_id uuid NOT NULL,
    lot_id uuid NOT NULL,
    credits bigint NOT NULL,
    CONSTRAINT credit_reservation_lots_credits_check CHECK ((credits > 0))
);



CREATE TABLE public.credit_reservations (
    reservation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    task_id uuid,
    run_id uuid,
    reservation_key text NOT NULL,
    policy_version text NOT NULL,
    requested_credits bigint NOT NULL,
    reserved_credits bigint NOT NULL,
    status text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT credit_reservations_requested_credits_check CHECK ((requested_credits > 0)),
    CONSTRAINT credit_reservations_reserved_credits_check CHECK ((reserved_credits >= 0)),
    CONSTRAINT credit_reservations_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'committed'::text, 'released'::text, 'pending'::text, 'uncovered'::text])))
);








CREATE TABLE public.note_part_revisions (
    part_revision_id uuid NOT NULL,
    note_id uuid NOT NULL,
    part text NOT NULL,
    revision integer NOT NULL,
    content_markdown text NOT NULL,
    content_sha256 character(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT note_part_revisions_part_check CHECK ((part = ANY (ARRAY['raw'::text, 'outline'::text, 'germination'::text]))),
    CONSTRAINT note_part_revisions_revision_check CHECK ((revision > 0))
);



CREATE TABLE public.note_relations (
    relation_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    source_note_id uuid NOT NULL,
    target_note_id uuid NOT NULL,
    relation_type text NOT NULL,
    origin text DEFAULT 'explicit'::text NOT NULL,
    rationale text DEFAULT ''::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    etag text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT note_relations_check CHECK ((source_note_id <> target_note_id)),
    CONSTRAINT note_relations_origin_check CHECK ((origin = ANY (ARRAY['explicit'::text, 'automatic'::text]))),
    CONSTRAINT note_relations_relation_type_check CHECK ((relation_type = ANY (ARRAY['references'::text, 'supports'::text, 'contradicts'::text, 'related'::text])))
);



CREATE TABLE public.note_resource_refs (
    note_id uuid NOT NULL,
    resource_id uuid NOT NULL,
    ref_order integer NOT NULL,
    usage text NOT NULL,
    anchor text,
    alt text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT note_resource_refs_ref_order_check CHECK ((ref_order >= 0))
);



CREATE TABLE public.note_tag_suggestions (
    suggestion_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    note_id uuid NOT NULL,
    task_id uuid NOT NULL,
    note_revision_id uuid NOT NULL,
    expected_tag_set_version bigint NOT NULL,
    labels jsonb NOT NULL,
    provider text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone,
    CONSTRAINT note_tag_suggestions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'dismissed'::text, 'stale'::text])))
);



CREATE TABLE public.note_tags (
    note_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT note_tags_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'extracted'::text])))
);



CREATE TABLE public.notes (
    note_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    folder_id uuid,
    title text NOT NULL,
    source_kind text DEFAULT 'manual'::text NOT NULL,
    source_id text,
    state text DEFAULT 'active'::text NOT NULL,
    note_revision bigint DEFAULT 1 NOT NULL,
    note_revision_id uuid NOT NULL,
    etag text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tag_set_version bigint DEFAULT 0 NOT NULL,
    tag_manual_override boolean DEFAULT false NOT NULL,
    processing_status text DEFAULT 'ready'::text NOT NULL,
    CONSTRAINT notes_processing_status_check CHECK ((processing_status = ANY (ARRAY['ready'::text, 'needs-processing'::text]))),
    CONSTRAINT notes_state_check CHECK ((state = ANY (ARRAY['active'::text, 'deleted'::text]))),
    CONSTRAINT notes_title_check CHECK (((length(title) >= 1) AND (length(title) <= 240)))
);



CREATE TABLE public.onboarding_drafts (
    workspace_id uuid NOT NULL,
    mode text DEFAULT ''::text NOT NULL,
    step_index integer DEFAULT 0 NOT NULL,
    answers jsonb DEFAULT '{}'::jsonb NOT NULL,
    deferred_at timestamp with time zone,
    version integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT onboarding_drafts_mode_check CHECK ((mode = ANY (ARRAY[''::text, 'business'::text, 'no_business'::text]))),
    CONSTRAINT onboarding_drafts_step_index_check CHECK (((step_index >= 0) AND (step_index <= 6)))
);



CREATE TABLE public.provider_usage_measurements (
    measurement_id uuid NOT NULL,
    user_id uuid NOT NULL,
    run_id uuid,
    reservation_id uuid,
    usage_kind text NOT NULL,
    provider text,
    measurement_status text NOT NULL,
    raw_input_tokens bigint DEFAULT 0 NOT NULL,
    raw_output_tokens bigint DEFAULT 0 NOT NULL,
    media_quantity bigint DEFAULT 0 NOT NULL,
    media_duration_seconds bigint DEFAULT 0 NOT NULL,
    accounted_credits bigint DEFAULT 0 NOT NULL,
    uncovered_credits bigint DEFAULT 0 NOT NULL,
    provider_cost_minor bigint,
    provider_currency character(3),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_usage_measurements_accounted_credits_check CHECK ((accounted_credits >= 0)),
    CONSTRAINT provider_usage_measurements_measurement_status_check CHECK ((measurement_status = ANY (ARRAY['measured'::text, 'fallback'::text, 'zero_cost'::text, 'unavailable'::text, 'pending'::text, 'uncovered'::text]))),
    CONSTRAINT provider_usage_measurements_media_duration_seconds_check CHECK ((media_duration_seconds >= 0)),
    CONSTRAINT provider_usage_measurements_media_quantity_check CHECK ((media_quantity >= 0)),
    CONSTRAINT provider_usage_measurements_raw_input_tokens_check CHECK ((raw_input_tokens >= 0)),
    CONSTRAINT provider_usage_measurements_raw_output_tokens_check CHECK ((raw_output_tokens >= 0)),
    CONSTRAINT provider_usage_measurements_uncovered_credits_check CHECK ((uncovered_credits >= 0))
);









CREATE TABLE public.rag_ingestion_versions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    source_url text NOT NULL,
    source_file_name text NOT NULL,
    source_mime_type text NOT NULL,
    source_size bigint,
    source_sha256 text,
    source_object_key text,
    mode text NOT NULL,
    canonical_content_uri text,
    parser_provider text,
    parser_version text,
    parser_config_hash text,
    status text NOT NULL,
    current_stage text NOT NULL,
    failed_stage text,
    error_code text,
    error_message text,
    retryable boolean DEFAULT false NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_attempt_at timestamp with time zone,
    parse_artifact_uri text,
    content_hash text,
    task_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    raw_markdown_uri text,
    asset_manifest_uri text,
    enriched_canonical_markdown_uri text,
    parser_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    document_key text NOT NULL,
    source_type text DEFAULT 'file'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    toc jsonb,
    toc_status text DEFAULT 'pending'::text NOT NULL,
    toc_error text,
    processing_snapshot jsonb,
    processing_info jsonb,
    deleted_at timestamp with time zone,
    cleanup_status text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT rag_ingestion_versions_mode_check CHECK ((mode = ANY (ARRAY['structured_document'::text, 'plain_text'::text]))),
    CONSTRAINT rag_ingestion_versions_status_check CHECK ((status = ANY (ARRAY['RECEIVED'::text, 'DOWNLOADING'::text, 'PARSE_SUBMITTED'::text, 'PARSING'::text, 'PARSED'::text, 'SEGMENTING'::text, 'CHUNKED'::text, 'EMBEDDING'::text, 'INDEXING'::text, 'SUCCEEDED'::text, 'FAILED'::text]))),
    CONSTRAINT rag_ingestion_versions_toc_status_check CHECK (toc_status IN ('pending', 'ready', 'failed')),
    CONSTRAINT rag_ingestion_versions_toc_check CHECK ((toc_status = 'ready') = (toc IS NOT NULL) AND (toc IS NULL OR jsonb_typeof(toc) = 'array'))
);






CREATE TABLE public.rag_document_assets (
    id uuid NOT NULL,
    version_id uuid NOT NULL,
    object_key text NOT NULL,
    sha256 text NOT NULL,
    mime_type text NOT NULL,
    byte_size bigint NOT NULL,
    asset_type text NOT NULL,
    page_no integer,
    source_block_id text,
    char_start integer,
    char_end integer,
    caption text,
    alt_text text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_asset_key text NOT NULL,
    asset_ref text NOT NULL,
    source_path text NOT NULL,
    upload_status text DEFAULT 'pending'::text NOT NULL,
    ocr_text text,
    caption_text text,
    enrichment_status text DEFAULT 'none'::text NOT NULL,
    enrichment_provider text,
    enrichment_source text,
    enrichment_hash text,
    CONSTRAINT rag_document_assets_asset_type_check CHECK ((asset_type = ANY (ARRAY['image'::text, 'chart'::text, 'table_image'::text, 'formula'::text, 'other'::text]))),
    CONSTRAINT rag_document_assets_enrichment_status_check CHECK ((enrichment_status = ANY (ARRAY['none'::text, 'bound'::text, 'unresolved'::text, 'failed'::text]))),
    CONSTRAINT rag_document_assets_upload_status_check CHECK ((upload_status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text])))
);






CREATE TABLE public.resource_refs (
    resource_id uuid NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    ref_kind text NOT NULL,
    ref_id_external text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE public.resources (
    resource_id uuid NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    upload_id uuid NOT NULL,
    source_scene text NOT NULL,
    file_name text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    duration_seconds double precision NOT NULL,
    sha256 character(64) NOT NULL,
    object_key uuid NOT NULL,
    object_version text NOT NULL,
    storage_driver text NOT NULL,
    storage_bucket text,
    status text NOT NULL,
    processing_status text DEFAULT 'inspection_pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT resources_processing_status_check CHECK ((processing_status = ANY (ARRAY['inspection_pending'::text, 'inspected'::text, 'failed'::text]))),
    CONSTRAINT resources_size_bytes_check CHECK ((size_bytes > 0)),
    CONSTRAINT resources_status_check CHECK ((status = ANY (ARRAY['ready'::text, 'deleting'::text, 'deleted'::text, 'quarantined'::text])))
);



CREATE TABLE public.run_usage (
    run_id uuid NOT NULL,
    user_id uuid NOT NULL,
    task_id uuid,
    reservation_id uuid,
    policy_version text NOT NULL,
    raw_input_tokens bigint DEFAULT 0 NOT NULL,
    raw_output_tokens bigint DEFAULT 0 NOT NULL,
    accounted_credits bigint DEFAULT 0 NOT NULL,
    uncovered_credits bigint DEFAULT 0 NOT NULL,
    settlement_status text NOT NULL,
    assistant_result_persisted boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT run_usage_settlement_status_check CHECK ((settlement_status = ANY (ARRAY['pending'::text, 'settled'::text, 'uncovered'::text])))
);



CREATE TABLE public.storage_jobs (
    task_id uuid NOT NULL,
    upload_id uuid,
    resource_id uuid,
    operation text NOT NULL,
    CONSTRAINT storage_jobs_operation_check CHECK ((operation = ANY (ARRAY['inspect'::text, 'delete'::text, 'expire'::text])))
);



CREATE TABLE public.storage_reservations (
    reservation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    resource_key text NOT NULL,
    requested_bytes bigint NOT NULL,
    confirmed_bytes bigint DEFAULT 0 NOT NULL,
    status text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storage_reservations_check CHECK ((confirmed_bytes <= requested_bytes)),
    CONSTRAINT storage_reservations_confirmed_bytes_check CHECK ((confirmed_bytes >= 0)),
    CONSTRAINT storage_reservations_requested_bytes_check CHECK ((requested_bytes > 0)),
    CONSTRAINT storage_reservations_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'confirmed'::text, 'released'::text, 'expired'::text])))
);



CREATE TABLE public.task_attempts (
    task_id uuid NOT NULL,
    attempt_no integer NOT NULL,
    version integer NOT NULL,
    owner uuid NOT NULL,
    state text NOT NULL,
    error_code text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);



CREATE TABLE public.task_events (
    task_id uuid NOT NULL,
    sequence integer NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE public.task_inputs (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_inputs_body_check CHECK ((length(body) <= 10000))
);



CREATE TABLE public.task_outbox (
    id uuid NOT NULL,
    task_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner uuid,
    lease_until timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    sent_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'delivering'::text, 'sent'::text, 'superseded'::text])))
);






CREATE TABLE public.task_results (
    id uuid NOT NULL,
    task_id uuid NOT NULL,
    attempt_no integer NOT NULL,
    digest text NOT NULL,
    byte_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE public.task_schedule_windows (
    schedule_id text NOT NULL,
    window_id bigint NOT NULL,
    task_id uuid NOT NULL
);



CREATE TABLE public.task_schedules (
    id text NOT NULL,
    interval_seconds integer NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_window bigint,
    CONSTRAINT task_schedules_interval_seconds_check CHECK ((interval_seconds >= 60))
);



CREATE TABLE public.tasks (
    id uuid NOT NULL,
    user_id uuid,
    workspace_id uuid,
    kind text NOT NULL,
    queue text NOT NULL,
    input_id uuid,
    state text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    attempt_no integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    lease_owner uuid,
    lease_until timestamp with time zone,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    external_state text DEFAULT 'none'::text NOT NULL,
    external_reference text,
    result_id uuid,
    error_code text,
    retryable boolean DEFAULT false NOT NULL,
    cancel_requested_at timestamp with time zone,
    event_sequence integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    reservation_id uuid,
    CONSTRAINT tasks_check CHECK ((((user_id IS NULL) AND (workspace_id IS NULL) AND (kind = 'maintenance.check'::text)) OR ((user_id IS NOT NULL) AND (workspace_id IS NOT NULL)))),
    CONSTRAINT tasks_check1 CHECK (((state <> 'succeeded'::text) OR (result_id IS NOT NULL))),
    CONSTRAINT tasks_external_state_check CHECK ((external_state = ANY (ARRAY['none'::text, 'submitted'::text, 'unknown'::text]))),
    CONSTRAINT tasks_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 9))),
    CONSTRAINT tasks_queue_check CHECK ((queue = ANY (ARRAY['content'::text, 'ai'::text, 'commercial'::text, 'maintenance'::text]))),
    CONSTRAINT tasks_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'running'::text, 'retry_scheduled'::text, 'waiting_external'::text, 'reconciling'::text, 'cancel_requested'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);






CREATE TABLE public.upload_sessions (
    upload_id uuid NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    resource_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    source_scene text NOT NULL,
    file_name text NOT NULL,
    mime_type text NOT NULL,
    expected_bytes bigint NOT NULL,
    expected_sha256 character(64),
    duration_seconds double precision DEFAULT 0 NOT NULL,
    status text NOT NULL,
    received_bytes bigint DEFAULT 0 NOT NULL,
    received_sha256 character(64),
    verified_duration double precision,
    object_version text,
    storage_driver text NOT NULL,
    storage_bucket text,
    error_code text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT upload_sessions_expected_bytes_check CHECK ((expected_bytes > 0)),
    CONSTRAINT upload_sessions_status_check CHECK ((status = ANY (ARRAY['initiated'::text, 'uploading'::text, 'uploaded'::text, 'completed'::text, 'failed'::text, 'expired'::text])))
);



CREATE TABLE public.usage_periods (
    user_id uuid NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    credit_limit bigint NOT NULL,
    settled_credits bigint DEFAULT 0 NOT NULL,
    reserved_credits bigint DEFAULT 0 NOT NULL,
    uncovered_credits bigint DEFAULT 0 NOT NULL,
    CONSTRAINT usage_periods_credit_limit_check CHECK ((credit_limit >= 0)),
    CONSTRAINT usage_periods_reserved_credits_check CHECK ((reserved_credits >= 0)),
    CONSTRAINT usage_periods_settled_credits_check CHECK ((settled_credits >= 0)),
    CONSTRAINT usage_periods_uncovered_credits_check CHECK ((uncovered_credits >= 0))
);



CREATE TABLE public.user_audit_events (
    id uuid NOT NULL,
    user_id uuid,
    session_id uuid,
    action text NOT NULL,
    target_id text,
    trace_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE public.workspace_content_state (
    workspace_id uuid NOT NULL,
    next_cursor bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE public.workspace_profiles (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    industry text NOT NULL,
    account_goal text NOT NULL,
    target_audience text,
    common_expressions jsonb DEFAULT '[]'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE public.workspaces (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    display_name text NOT NULL,
    state text DEFAULT 'ready'::text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_initial boolean DEFAULT false NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    bootstrap_receipt_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspaces_state_check CHECK ((state = ANY (ARRAY['ready'::text, 'disabled'::text])))
);



ALTER TABLE ONLY public.account_memberships
    ADD CONSTRAINT account_memberships_pkey PRIMARY KEY (membership_id);



ALTER TABLE ONLY public.account_memberships
    ADD CONSTRAINT account_memberships_user_id_key UNIQUE (user_id);



ALTER TABLE ONLY public.admin_audit_events
    ADD CONSTRAINT admin_audit_events_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.admin_login_limits
    ADD CONSTRAINT admin_login_limits_pkey PRIMARY KEY (key);



ALTER TABLE ONLY public.admin_sessions
    ADD CONSTRAINT admin_sessions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.admin_sessions
    ADD CONSTRAINT admin_sessions_session_hash_key UNIQUE (session_hash);



ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_username_key UNIQUE (username);



ALTER TABLE ONLY public.api_idempotency
    ADD CONSTRAINT api_idempotency_pkey PRIMARY KEY (scope, operation, key);



ALTER TABLE ONLY public.asset_folders
    ADD CONSTRAINT asset_folders_pkey PRIMARY KEY (folder_id);



ALTER TABLE ONLY public.asset_folders
    ADD CONSTRAINT asset_folders_workspace_id_folder_id_key UNIQUE (workspace_id, folder_id);



ALTER TABLE ONLY public.asset_folders
    ADD CONSTRAINT asset_folders_workspace_id_parent_folder_id_normalized_name_key UNIQUE (workspace_id, parent_folder_id, normalized_name) DEFERRABLE;



ALTER TABLE public.asset_tags
    ADD CONSTRAINT asset_tags_name_length CHECK ((((length(normalized_name) >= 1) AND (length(normalized_name) <= 24)) AND ((length(display_name) >= 1) AND (length(display_name) <= 24)))) NOT VALID;



ALTER TABLE ONLY public.asset_tags
    ADD CONSTRAINT asset_tags_pkey PRIMARY KEY (tag_id);



ALTER TABLE ONLY public.asset_tags
    ADD CONSTRAINT asset_tags_workspace_id_normalized_name_key UNIQUE (workspace_id, normalized_name);



ALTER TABLE ONLY public.auth_rate_limits
    ADD CONSTRAINT auth_rate_limits_pkey PRIMARY KEY (key);



ALTER TABLE ONLY public.billing_policies
    ADD CONSTRAINT billing_policies_pkey PRIMARY KEY (policy_version);



ALTER TABLE ONLY public.content_events
    ADD CONSTRAINT content_events_pkey PRIMARY KEY (event_id);



ALTER TABLE ONLY public.content_events
    ADD CONSTRAINT content_events_workspace_id_cursor_key UNIQUE (workspace_id, cursor);



ALTER TABLE ONLY public.content_jobs
    ADD CONSTRAINT content_jobs_pkey PRIMARY KEY (task_id);



ALTER TABLE ONLY public.credit_ledger_entries
    ADD CONSTRAINT credit_ledger_entries_pkey PRIMARY KEY (entry_id);



ALTER TABLE ONLY public.credit_lots
    ADD CONSTRAINT credit_lots_grant_key_key UNIQUE (grant_key);



ALTER TABLE ONLY public.credit_lots
    ADD CONSTRAINT credit_lots_pkey PRIMARY KEY (lot_id);



ALTER TABLE ONLY public.credit_reservation_lots
    ADD CONSTRAINT credit_reservation_lots_pkey PRIMARY KEY (reservation_id, lot_id);



ALTER TABLE ONLY public.credit_reservations
    ADD CONSTRAINT credit_reservations_pkey PRIMARY KEY (reservation_id);



ALTER TABLE ONLY public.credit_reservations
    ADD CONSTRAINT credit_reservations_user_id_reservation_key_key UNIQUE (user_id, reservation_key);






ALTER TABLE ONLY public.note_part_revisions
    ADD CONSTRAINT note_part_revisions_note_id_part_revision_key UNIQUE (note_id, part, revision);



ALTER TABLE ONLY public.note_part_revisions
    ADD CONSTRAINT note_part_revisions_pkey PRIMARY KEY (part_revision_id);



ALTER TABLE ONLY public.note_relations
    ADD CONSTRAINT note_relations_pkey PRIMARY KEY (relation_id);



ALTER TABLE ONLY public.note_relations
    ADD CONSTRAINT note_relations_workspace_id_source_note_id_target_note_id_r_key UNIQUE (workspace_id, source_note_id, target_note_id, relation_type);



ALTER TABLE ONLY public.note_resource_refs
    ADD CONSTRAINT note_resource_refs_note_id_resource_id_usage_anchor_key UNIQUE (note_id, resource_id, usage, anchor);



ALTER TABLE ONLY public.note_resource_refs
    ADD CONSTRAINT note_resource_refs_pkey PRIMARY KEY (note_id, ref_order);



ALTER TABLE ONLY public.note_tag_suggestions
    ADD CONSTRAINT note_tag_suggestions_pkey PRIMARY KEY (suggestion_id);



ALTER TABLE ONLY public.note_tag_suggestions
    ADD CONSTRAINT note_tag_suggestions_task_id_key UNIQUE (task_id);



ALTER TABLE ONLY public.note_tags
    ADD CONSTRAINT note_tags_pkey PRIMARY KEY (note_id, tag_id);



ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_pkey PRIMARY KEY (note_id);



ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_workspace_id_note_id_key UNIQUE (workspace_id, note_id);



ALTER TABLE ONLY public.onboarding_drafts
    ADD CONSTRAINT onboarding_drafts_pkey PRIMARY KEY (workspace_id);



ALTER TABLE ONLY public.provider_usage_measurements
    ADD CONSTRAINT provider_usage_measurements_pkey PRIMARY KEY (measurement_id);









ALTER TABLE ONLY public.rag_document_assets
    ADD CONSTRAINT rag_document_assets_pkey PRIMARY KEY (id);






ALTER TABLE ONLY public.rag_ingestion_versions
    ADD CONSTRAINT rag_ingestion_versions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.rag_ingestion_versions
    ADD CONSTRAINT rag_ingestion_versions_user_id_idempotency_key_key UNIQUE (user_id, idempotency_key);






ALTER TABLE ONLY public.resource_refs
    ADD CONSTRAINT resource_refs_pkey PRIMARY KEY (resource_id, ref_kind, ref_id_external);



ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_object_key_key UNIQUE (object_key);



ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_pkey PRIMARY KEY (resource_id);



ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_resource_id_user_id_workspace_id_key UNIQUE (resource_id, user_id, workspace_id);



ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_upload_id_key UNIQUE (upload_id);



ALTER TABLE ONLY public.run_usage
    ADD CONSTRAINT run_usage_pkey PRIMARY KEY (run_id);



ALTER TABLE ONLY public.storage_jobs
    ADD CONSTRAINT storage_jobs_pkey PRIMARY KEY (task_id);



ALTER TABLE ONLY public.storage_jobs
    ADD CONSTRAINT storage_jobs_resource_id_operation_key UNIQUE (resource_id, operation);



ALTER TABLE ONLY public.storage_jobs
    ADD CONSTRAINT storage_jobs_upload_id_operation_key UNIQUE (upload_id, operation);



ALTER TABLE ONLY public.storage_reservations
    ADD CONSTRAINT storage_reservations_pkey PRIMARY KEY (reservation_id);



ALTER TABLE ONLY public.storage_reservations
    ADD CONSTRAINT storage_reservations_user_id_resource_key_key UNIQUE (user_id, resource_key);



ALTER TABLE ONLY public.task_attempts
    ADD CONSTRAINT task_attempts_pkey PRIMARY KEY (task_id, attempt_no);



ALTER TABLE ONLY public.task_events
    ADD CONSTRAINT task_events_pkey PRIMARY KEY (task_id, sequence);



ALTER TABLE ONLY public.task_inputs
    ADD CONSTRAINT task_inputs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.task_outbox
    ADD CONSTRAINT task_outbox_pkey PRIMARY KEY (id);






ALTER TABLE ONLY public.task_results
    ADD CONSTRAINT task_results_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.task_results
    ADD CONSTRAINT task_results_task_id_key UNIQUE (task_id);



ALTER TABLE ONLY public.task_schedule_windows
    ADD CONSTRAINT task_schedule_windows_pkey PRIMARY KEY (schedule_id, window_id);



ALTER TABLE ONLY public.task_schedule_windows
    ADD CONSTRAINT task_schedule_windows_task_id_key UNIQUE (task_id);



ALTER TABLE ONLY public.task_schedules
    ADD CONSTRAINT task_schedules_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);






ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_pkey PRIMARY KEY (upload_id);



ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_reservation_id_key UNIQUE (reservation_id);



ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_resource_id_key UNIQUE (resource_id);



ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_upload_id_user_id_workspace_id_key UNIQUE (upload_id, user_id, workspace_id);



ALTER TABLE ONLY public.usage_periods
    ADD CONSTRAINT usage_periods_pkey PRIMARY KEY (user_id, period_start);



ALTER TABLE ONLY public.user_audit_events
    ADD CONSTRAINT user_audit_events_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.workspace_content_state
    ADD CONSTRAINT workspace_content_state_pkey PRIMARY KEY (workspace_id);



ALTER TABLE ONLY public.workspace_profiles
    ADD CONSTRAINT workspace_profiles_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.workspace_profiles
    ADD CONSTRAINT workspace_profiles_workspace_id_key UNIQUE (workspace_id);



ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_bootstrap_receipt_id_key UNIQUE (bootstrap_receipt_id);



ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_id_user_id_key UNIQUE (id, user_id);



ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);



CREATE INDEX account_memberships_rel_88f69c3e5a9f_idx ON public.account_memberships USING btree (policy_version);



CREATE INDEX admin_sessions_rel_2509bfaedb12_idx ON public.admin_sessions USING btree (admin_id);



CREATE INDEX asset_folders_parent ON public.asset_folders USING btree (workspace_id, parent_folder_id, state);



CREATE INDEX asset_folders_rel_eaada2cb5267_idx ON public.asset_folders USING btree (parent_folder_id);



CREATE UNIQUE INDEX asset_folders_root_name ON public.asset_folders USING btree (workspace_id, normalized_name) WHERE (parent_folder_id IS NULL);






CREATE INDEX content_jobs_note ON public.content_jobs USING btree (note_id, note_revision_id);



CREATE INDEX credit_ledger_entries_rel_238b95074ea1_idx ON public.credit_ledger_entries USING btree (user_id);



CREATE INDEX credit_ledger_entries_rel_da90414de691_idx ON public.credit_ledger_entries USING btree (lot_id);



CREATE INDEX credit_ledger_entries_rel_dbf483598c8b_idx ON public.credit_ledger_entries USING btree (reservation_id);



CREATE INDEX credit_lots_rel_dce7d7ce5af0_idx ON public.credit_lots USING btree (policy_version);



CREATE INDEX credit_lots_user_active ON public.credit_lots USING btree (user_id, lot_kind, expires_at);



CREATE INDEX credit_reservation_lots_rel_d884bd853427_idx ON public.credit_reservation_lots USING btree (lot_id);



CREATE INDEX credit_reservations_rel_19f99abed1de_idx ON public.credit_reservations USING btree (policy_version);



CREATE INDEX credit_reservations_rel_59d341c94760_idx ON public.credit_reservations USING btree (task_id);













CREATE INDEX note_parts_latest ON public.note_part_revisions USING btree (note_id, part, revision DESC);



CREATE INDEX note_relations_rel_681eb494d7e7_idx ON public.note_relations USING btree (source_note_id);



CREATE INDEX note_relations_rel_7aa2489a7b0e_idx ON public.note_relations USING btree (target_note_id);



CREATE INDEX note_resource_refs_rel_871ac57d2ea3_idx ON public.note_resource_refs USING btree (resource_id);



CREATE INDEX note_tag_suggestions_rel_9a9db47d7fcc_idx ON public.note_tag_suggestions USING btree (note_id);



CREATE INDEX note_tag_suggestions_scope ON public.note_tag_suggestions USING btree (workspace_id, note_id, status, created_at DESC);



CREATE INDEX note_tags_topic_members ON public.note_tags USING btree (tag_id, note_id);



CREATE INDEX notes_graph_page ON public.notes USING btree (workspace_id, note_id) WHERE (state = 'active'::text);



CREATE INDEX notes_rel_50816e2d6bf5_idx ON public.notes USING btree (folder_id);



CREATE INDEX notes_scope ON public.notes USING btree (workspace_id, state, updated_at DESC, note_id);






CREATE INDEX outbox_due ON public.task_outbox USING btree (status, available_at);



CREATE INDEX provider_usage_measurements_rel_957d85e31111_idx ON public.provider_usage_measurements USING btree (user_id);



CREATE INDEX provider_usage_measurements_rel_feb5db0df5e1_idx ON public.provider_usage_measurements USING btree (reservation_id);
























CREATE INDEX rag_document_assets_hash ON public.rag_document_assets USING btree (version_id, sha256);



CREATE INDEX rag_document_assets_ref ON public.rag_document_assets USING btree (version_id, asset_ref);



CREATE INDEX rag_document_assets_version ON public.rag_document_assets USING btree (version_id, created_at);



CREATE UNIQUE INDEX rag_document_assets_version_source_key ON public.rag_document_assets USING btree (version_id, source_asset_key);






CREATE UNIQUE INDEX rag_ingestion_versions_document_key ON public.rag_ingestion_versions USING btree (document_key);



CREATE INDEX rag_ingestion_versions_rel_dd692cc16f6f_idx ON public.rag_ingestion_versions USING btree (workspace_id, user_id);



CREATE INDEX rag_ingestion_versions_task ON public.rag_ingestion_versions USING btree (task_id);



CREATE INDEX rag_ingestion_versions_user_created ON public.rag_ingestion_versions USING btree (user_id, created_at DESC);






CREATE INDEX resource_refs_rel_fd1aafa8ffad_idx ON public.resource_refs USING btree (resource_id, user_id, workspace_id);



CREATE INDEX resources_rel_3911b03c8383_idx ON public.resources USING btree (upload_id, user_id, workspace_id);



CREATE INDEX resources_scope ON public.resources USING btree (user_id, workspace_id, created_at DESC);



CREATE INDEX run_usage_rel_02f1c5259823_idx ON public.run_usage USING btree (reservation_id);



CREATE INDEX run_usage_rel_2d614c28d464_idx ON public.run_usage USING btree (policy_version);



CREATE INDEX run_usage_rel_4c561b1f491b_idx ON public.run_usage USING btree (user_id);



CREATE INDEX run_usage_rel_689866adeec4_idx ON public.run_usage USING btree (task_id);



CREATE INDEX task_inputs_rel_ebd618691431_idx ON public.task_inputs USING btree (workspace_id, user_id);



CREATE UNIQUE INDEX task_one_pending_delivery ON public.task_outbox USING btree (task_id) WHERE (status = ANY (ARRAY['pending'::text, 'delivering'::text]));



CREATE INDEX task_outbox_rel_b0f28e81c569_idx ON public.task_outbox USING btree (task_id);



CREATE INDEX tasks_recovery ON public.tasks USING btree (state, available_at, lease_until);



CREATE INDEX tasks_rel_028dbef73009_idx ON public.tasks USING btree (reservation_id);



CREATE INDEX tasks_rel_23c52f44e805_idx ON public.tasks USING btree (result_id);



CREATE INDEX tasks_rel_560cac93466b_idx ON public.tasks USING btree (workspace_id, user_id);



CREATE INDEX tasks_rel_d7682a974b32_idx ON public.tasks USING btree (input_id);



CREATE UNIQUE INDEX tasks_reservation_unique ON public.tasks USING btree (reservation_id) WHERE (reservation_id IS NOT NULL);



CREATE INDEX tasks_scope ON public.tasks USING btree (user_id, workspace_id, created_at DESC);



CREATE INDEX upload_expiry ON public.upload_sessions USING btree (status, expires_at);



CREATE INDEX upload_sessions_rel_26203df74c73_idx ON public.upload_sessions USING btree (workspace_id, user_id);



CREATE INDEX upload_sessions_rel_4c7b19fd5362_idx ON public.upload_sessions USING btree (user_id);



CREATE INDEX user_audit_events_rel_659dfb76291e_idx ON public.user_audit_events USING btree (user_id);



CREATE UNIQUE INDEX workspace_default ON public.workspaces USING btree (user_id) WHERE is_default;



CREATE UNIQUE INDEX workspace_initial ON public.workspaces USING btree (user_id) WHERE is_initial;



CREATE INDEX workspaces_rel_e7fed022db47_idx ON public.workspaces USING btree (user_id);



CREATE TRIGGER note_tags_lifecycle_fence BEFORE UPDATE OF state ON public.notes FOR EACH ROW EXECUTE FUNCTION public.note_tags_lifecycle_fence();




-- Independent text import content. Execution stays in tasks/task_inputs/outbox.
CREATE TABLE public.text_ingestion_jobs (
    id uuid PRIMARY KEY,
    source_type text NOT NULL CHECK (source_type IN ('MANUAL_INPUT','WEB_CRAWL','IMAGE_OCR','MEDIA_ASR','BOOK_OCR','FILE_UPLOAD')),
    raw_content text,
    origin_resource_uri text,
    ingest_status text DEFAULT 'pending' NOT NULL CHECK (ingest_status IN ('pending','parsing','chunking','success','failed')),
    error_msg text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    workspace_id uuid NOT NULL,
    current_task_id uuid NOT NULL UNIQUE,
    content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$'),
    artifact_uri text,
    CONSTRAINT text_ingestion_jobs_origin_check CHECK (
      (source_type='MANUAL_INPUT' AND origin_resource_uri IS NULL AND raw_content IS NOT NULL AND char_length(raw_content)<=50000)
      OR (source_type<>'MANUAL_INPUT' AND origin_resource_uri IS NOT NULL AND char_length(origin_resource_uri) BETWEEN 1 AND 4096)),
    CONSTRAINT text_ingestion_jobs_content_check CHECK (raw_content IS NULL OR btrim(raw_content)<>''),
    CONSTRAINT text_ingestion_jobs_ready_text_check CHECK (ingest_status NOT IN ('chunking','success') OR raw_content IS NOT NULL)
);
CREATE INDEX text_ingestion_jobs_owner_scope ON public.text_ingestion_jobs(created_by,workspace_id,updated_at,id);
CREATE INDEX text_ingestion_jobs_workspace ON public.text_ingestion_jobs(workspace_id,created_by);
COMMENT ON TABLE public.text_ingestion_jobs IS 'Independent imported content; source_type is acquisition method, not RAG business source. No business version counter.';


-- Domain-specific least-privilege runtime grants.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO huahuo_api, huahuo_admin, huahuo_worker, huahuo_scheduler;
GRANT SELECT ON schema_migrations TO huahuo_api, huahuo_admin, huahuo_worker, huahuo_scheduler;
GRANT SELECT(id,display_name,status,created_at) ON users TO huahuo_admin;
GRANT SELECT(id,user_id,provider,subject_masked,verified_at,created_at) ON user_identities TO huahuo_admin;
GRANT SELECT(id,user_id,state) ON workspaces TO huahuo_worker;
GRANT SELECT ON account_memberships,asset_folders,asset_tags,billing_policies,content_events,content_jobs,credit_ledger_entries,credit_lots,credit_reservation_lots,credit_reservations,note_part_revisions,note_relations,note_resource_refs,note_tag_suggestions,note_tags,notes,provider_usage_measurements,rag_document_assets,rag_ingestion_versions,resource_refs,resources,run_usage,storage_jobs,storage_reservations,task_attempts,upload_sessions,usage_periods,workspace_content_state TO huahuo_admin;
GRANT SELECT,INSERT ON admin_audit_events,api_idempotency,task_events,task_outbox TO huahuo_admin;
GRANT SELECT,INSERT,UPDATE ON admin_login_limits,admin_sessions,admin_users TO huahuo_admin;
GRANT SELECT,UPDATE ON tasks TO huahuo_admin;
GRANT SELECT ON task_results TO huahuo_api;
GRANT SELECT,INSERT ON task_events,task_inputs,user_agreement_acceptances,user_audit_events TO huahuo_api;
GRANT SELECT,INSERT,DELETE ON resource_refs TO huahuo_api;
GRANT SELECT,INSERT,UPDATE ON account_memberships,api_idempotency,auth_rate_limits,billing_policies,credit_ledger_entries,credit_lots,credit_reservation_lots,credit_reservations,onboarding_drafts,otp_requests,provider_usage_measurements,refresh_tokens,resources,run_usage,storage_jobs,storage_reservations,task_outbox,tasks,upload_sessions,usage_periods,user_api_keys,user_identities,user_sessions,users,workspace_profiles,workspaces TO huahuo_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON asset_folders,asset_tags,content_events,content_jobs,note_part_revisions,note_relations,note_resource_refs,note_tag_suggestions,note_tags,notes,rag_document_assets,rag_ingestion_versions,workspace_content_state TO huahuo_api;
GRANT SELECT ON account_memberships,asset_folders,asset_tags,billing_policies,content_events,content_jobs,credit_ledger_entries,credit_lots,credit_reservation_lots,credit_reservations,note_part_revisions,note_relations,note_resource_refs,note_tag_suggestions,note_tags,notes,provider_usage_measurements,rag_document_assets,rag_ingestion_versions,run_usage,usage_periods,workspace_content_state TO huahuo_scheduler;
GRANT SELECT,INSERT ON storage_jobs,task_events,task_schedule_windows TO huahuo_scheduler;
GRANT SELECT,INSERT,UPDATE ON task_outbox,task_schedules,tasks TO huahuo_scheduler;
GRANT SELECT,UPDATE ON storage_reservations,task_attempts,upload_sessions TO huahuo_scheduler;
GRANT SELECT ON billing_policies,resource_refs,storage_jobs,task_inputs,users TO huahuo_worker;
GRANT SELECT,INSERT ON task_events,task_outbox,task_results TO huahuo_worker;
GRANT SELECT,INSERT,UPDATE ON account_memberships,credit_ledger_entries,credit_lots,credit_reservation_lots,credit_reservations,note_tag_suggestions,provider_usage_measurements,run_usage,storage_reservations,task_attempts,tasks,usage_periods TO huahuo_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON asset_folders,asset_tags,content_events,content_jobs,note_part_revisions,note_relations,note_resource_refs,note_tags,notes,rag_document_assets,rag_ingestion_versions,workspace_content_state TO huahuo_worker;
GRANT SELECT,UPDATE ON resources,upload_sessions TO huahuo_worker;
COMMENT ON TABLE schema_migrations IS 'Applied reviewed schema files; runtime roles are read-only.';
INSERT INTO billing_policies(policy_version,mode,monthly_credit_limit,currency) VALUES('credit-policy-v1','development',10000000,'USD');
INSERT INTO task_schedules(id,interval_seconds) VALUES('maintenance-check-v1',3600);

GRANT SELECT,INSERT,UPDATE ON public.text_ingestion_jobs TO huahuo_api;
GRANT SELECT,UPDATE ON public.text_ingestion_jobs TO huahuo_worker;

CREATE TABLE public.kb_note_hybrid_builds (
 id uuid PRIMARY KEY, source_type text NOT NULL CHECK(source_type IN ('note')),
 source_id uuid NOT NULL, source_revision text NOT NULL,
 user_id uuid NOT NULL, workspace_id uuid NOT NULL, task_id uuid NOT NULL,
 content_hash text NOT NULL, config_hash text NOT NULL, snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','indexing','ready','failed','superseded','deleted')),
 published boolean NOT NULL DEFAULT false, planned boolean NOT NULL DEFAULT false,
 chunk_count integer NOT NULL DEFAULT 0 CHECK(chunk_count>=0),
 toc jsonb, toc_status text NOT NULL DEFAULT 'pending' CHECK(toc_status IN ('pending','ready','failed')),
 error_code text, cleanup_status text NOT NULL DEFAULT 'pending' CHECK(cleanup_status IN ('pending','ready','failed')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_type,source_id,source_revision,config_hash),
 CHECK(NOT published OR status='ready')
);
CREATE UNIQUE INDEX kb_note_hybrid_builds_published ON public.kb_note_hybrid_builds(source_type,source_id) WHERE published;
CREATE INDEX kb_note_hybrid_builds_owner ON public.kb_note_hybrid_builds(user_id,workspace_id,source_type,source_id,created_at DESC);
CREATE INDEX kb_note_hybrid_builds_task ON public.kb_note_hybrid_builds(task_id);
CREATE TABLE public.kb_note_hybrid_chunks (
 build_id uuid NOT NULL, ordinal integer NOT NULL CHECK(ordinal>=0), point_id text NOT NULL,
 source_start integer NOT NULL CHECK(source_start>=0), source_end integer NOT NULL,
 core_start integer NOT NULL, core_end integer NOT NULL, section_id text, input_hash text NOT NULL, token_count integer NOT NULL CHECK(token_count BETWEEN 1 AND 8192),
 content_hash text NOT NULL, char_count integer NOT NULL CHECK(char_count BETWEEN 1 AND 500),
 index_status text NOT NULL DEFAULT 'pending' CHECK(index_status IN ('pending','ready','failed')),
 PRIMARY KEY(build_id,ordinal), UNIQUE(build_id,point_id), CHECK(source_end>source_start)
 ,CHECK(source_start<=core_start AND core_start<core_end AND core_end<=source_end)
);
CREATE INDEX kb_note_hybrid_chunks_point ON public.kb_note_hybrid_chunks(point_id);
CREATE INDEX kb_note_hybrid_chunks_ready ON public.kb_note_hybrid_chunks(build_id,point_id) WHERE index_status='ready';
GRANT SELECT,INSERT,UPDATE,DELETE ON public.kb_note_hybrid_builds,public.kb_note_hybrid_chunks TO huahuo_api,huahuo_worker;
GRANT SELECT ON public.kb_note_hybrid_builds,public.kb_note_hybrid_chunks TO huahuo_admin,huahuo_scheduler;

CREATE TABLE public.kb_document_keyword_builds (
 id uuid PRIMARY KEY, source_type text NOT NULL CHECK(source_type IN ('file','text')),
 source_id uuid NOT NULL, source_revision text NOT NULL,
 user_id uuid NOT NULL, workspace_id uuid NOT NULL, task_id uuid NOT NULL,
 content_hash text NOT NULL, config_hash text NOT NULL, snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','indexing','ready','failed','superseded','deleted')),
 published boolean NOT NULL DEFAULT false, planned boolean NOT NULL DEFAULT false,
 chunk_count integer NOT NULL DEFAULT 0 CHECK(chunk_count>=0),
 toc jsonb, toc_status text NOT NULL DEFAULT 'pending' CHECK(toc_status IN ('pending','ready','failed')),
 error_code text, cleanup_status text NOT NULL DEFAULT 'pending' CHECK(cleanup_status IN ('pending','ready','failed')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_type,source_id,source_revision,config_hash),
 CHECK(NOT published OR status='ready')
);
CREATE UNIQUE INDEX kb_document_keyword_builds_published ON public.kb_document_keyword_builds(source_type,source_id) WHERE published;
CREATE INDEX kb_document_keyword_builds_owner ON public.kb_document_keyword_builds(user_id,workspace_id,source_type,source_id,created_at DESC);
CREATE INDEX kb_document_keyword_builds_task ON public.kb_document_keyword_builds(task_id);
CREATE TABLE public.kb_document_keyword_chunks (
 build_id uuid NOT NULL, ordinal integer NOT NULL CHECK(ordinal>=0), point_id text NOT NULL,
 source_start integer NOT NULL CHECK(source_start>=0), source_end integer NOT NULL,

 content_hash text NOT NULL, char_count integer NOT NULL CHECK(char_count BETWEEN 1 AND 2000),
 index_status text NOT NULL DEFAULT 'pending' CHECK(index_status IN ('pending','ready','failed')),
 PRIMARY KEY(build_id,ordinal), UNIQUE(build_id,point_id), CHECK(source_end>source_start)

);
CREATE INDEX kb_document_keyword_chunks_point ON public.kb_document_keyword_chunks(point_id);
CREATE INDEX kb_document_keyword_chunks_ready ON public.kb_document_keyword_chunks(build_id,point_id) WHERE index_status='ready';
GRANT SELECT,INSERT,UPDATE,DELETE ON public.kb_document_keyword_builds,public.kb_document_keyword_chunks TO huahuo_api,huahuo_worker;
GRANT SELECT ON public.kb_document_keyword_builds,public.kb_document_keyword_chunks TO huahuo_admin,huahuo_scheduler;

CREATE INDEX kb_note_hybrid_builds_source ON public.kb_note_hybrid_builds(source_id,source_revision);
CREATE INDEX kb_note_hybrid_builds_workspace ON public.kb_note_hybrid_builds(workspace_id);
CREATE INDEX kb_document_keyword_builds_source ON public.kb_document_keyword_builds(source_id,source_revision);
CREATE INDEX kb_document_keyword_builds_workspace ON public.kb_document_keyword_builds(workspace_id);
