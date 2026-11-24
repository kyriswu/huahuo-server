-- Canonical PostgreSQL 17+ schema for empty databases.
-- Consolidated from migrations 0001 through 0027 at 65e03b27afcbd97876db4c08ef01df754b9426dc.
-- Includes only schema objects, privileges and fresh-install seed data.
SET LOCAL check_function_bodies = false;

-- public is provisioned by the database initializer.


CREATE FUNCTION public.content_asset_tags_lifecycle_fence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.state IS DISTINCT FROM OLD.state THEN
   NEW.tag_set_version := OLD.tag_set_version + 1;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.notify_bearer_auth_cache_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    PERFORM pg_notify('bearer_auth_cache', 'user:' || OLD.id::text);
  ELSE
    PERFORM pg_notify('bearer_auth_cache', 'access:' || OLD.access_hash);
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 NEW.updated_at=now();
 RETURN NEW;
END;
$$;

CREATE TABLE public.account_content_state (
    next_cursor bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL
);

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

CREATE TABLE public.ai_template_scenes (
    scene_key text NOT NULL,
    draft jsonb NOT NULL,
    draft_revision integer DEFAULT 1 NOT NULL,
    published_revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT ai_template_scenes_draft_revision_check CHECK ((draft_revision > 0)),
    CONSTRAINT ai_template_scenes_published_revision_check CHECK ((published_revision > 0)),
    CONSTRAINT ai_template_scenes_scene_key_check CHECK ((scene_key = ANY (ARRAY['content_asset_outline'::text, 'editor_polish'::text])))
);

CREATE TABLE public.ai_template_versions (
    scene_key text NOT NULL,
    revision integer NOT NULL,
    catalog jsonb NOT NULL,
    published_by uuid,
    restored_from integer,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_template_versions_revision_check CHECK ((revision > 0))
);

CREATE VIEW public.ai_template_published AS
 SELECT s.scene_key,
    v.revision,
    v.catalog
   FROM (public.ai_template_scenes s
     JOIN public.ai_template_versions v ON (((v.scene_key = s.scene_key) AND (v.revision = s.published_revision))));

CREATE TABLE public.ai_template_runs (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    scene_key text NOT NULL,
    item_key text NOT NULL,
    template_version integer NOT NULL,
    content_asset_id uuid,
    source_revision uuid,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    state text DEFAULT 'running'::text NOT NULL,
    result_text text,
    error_code text,
    error_status integer,
    trace_id text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    deadline_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT ai_template_runs_check1 CHECK ((((state = 'running'::text) AND (finished_at IS NULL) AND (result_text IS NULL) AND (error_code IS NULL) AND (error_status IS NULL)) OR ((state = 'succeeded'::text) AND (finished_at IS NOT NULL) AND (result_text IS NOT NULL) AND (error_code IS NULL) AND (error_status IS NULL)) OR ((state = 'failed'::text) AND (finished_at IS NOT NULL) AND (result_text IS NULL) AND (error_code IS NOT NULL) AND (error_status IS NOT NULL)))),
    CONSTRAINT ai_template_runs_scene_key_check CHECK ((scene_key = ANY (ARRAY['content_asset_outline'::text, 'editor_polish'::text]))),
    CONSTRAINT ai_template_runs_source_check CHECK ((((scene_key = 'content_asset_outline'::text) AND (content_asset_id IS NOT NULL) AND (source_revision IS NOT NULL)) OR ((scene_key = 'editor_polish'::text) AND (content_asset_id IS NULL) AND (source_revision IS NULL)))),
    CONSTRAINT ai_template_runs_state_check CHECK ((state = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text])))
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
    parent_folder_id uuid,
    display_name text NOT NULL,
    normalized_name text NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    current_revision_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_by_folder_id uuid,
    user_id uuid NOT NULL,
    CONSTRAINT asset_folders_display_name_check CHECK (((length(display_name) >= 1) AND (length(display_name) <= 120))),
    CONSTRAINT asset_folders_state_check CHECK ((state = ANY (ARRAY['active'::text, 'deleted'::text])))
);

CREATE TABLE public.asset_tags (
    tag_id uuid NOT NULL,
    normalized_name text NOT NULL,
    display_name text NOT NULL,
    source text NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL,
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

CREATE TABLE public.content_asset_parts (
    part_revision_id uuid NOT NULL,
    content_asset_id uuid NOT NULL,
    part text NOT NULL,
    revision integer NOT NULL,
    content_markdown text NOT NULL,
    content_sha256 character(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_asset_parts_part_check CHECK ((part = ANY (ARRAY['raw'::text, 'outline'::text, 'germination'::text]))),
    CONSTRAINT content_asset_parts_revision_check CHECK ((revision > 0))
);

COMMENT ON TABLE public.content_asset_parts IS 'Current editable body parts of a ContentAsset.';

CREATE TABLE public.content_asset_relations (
    relation_id uuid NOT NULL,
    source_content_asset_id uuid NOT NULL,
    target_content_asset_id uuid NOT NULL,
    relation_type text NOT NULL,
    origin text DEFAULT 'explicit'::text NOT NULL,
    rationale text DEFAULT ''::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    etag text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL,
    CONSTRAINT content_asset_relations_distinct_check CHECK ((source_content_asset_id <> target_content_asset_id)),
    CONSTRAINT content_asset_relations_origin_check CHECK ((origin = ANY (ARRAY['explicit'::text, 'automatic'::text]))),
    CONSTRAINT content_asset_relations_relation_type_check CHECK ((relation_type = ANY (ARRAY['references'::text, 'supports'::text, 'contradicts'::text, 'related'::text])))
);

CREATE TABLE public.content_asset_resource_refs (
    content_asset_id uuid NOT NULL,
    resource_id uuid NOT NULL,
    ref_order integer NOT NULL,
    usage text NOT NULL,
    anchor text,
    alt text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_asset_resource_refs_ref_order_check CHECK ((ref_order >= 0))
);

COMMENT ON TABLE public.content_asset_resource_refs IS 'Ordered binary Resource links owned by a ContentAsset.';

CREATE TABLE public.content_asset_tag_suggestions (
    suggestion_id uuid NOT NULL,
    content_asset_id uuid NOT NULL,
    task_id uuid NOT NULL,
    content_asset_revision_id uuid NOT NULL,
    expected_tag_set_version bigint NOT NULL,
    labels jsonb NOT NULL,
    provider text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone,
    user_id uuid NOT NULL,
    CONSTRAINT content_asset_tag_suggestions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'dismissed'::text, 'stale'::text])))
);

CREATE TABLE public.content_asset_tags (
    content_asset_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_asset_tags_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'extracted'::text])))
);

CREATE TABLE public.content_assets (
    content_asset_id uuid NOT NULL,
    title text NOT NULL,
    source_kind text DEFAULT 'manual'::text NOT NULL,
    source_id text,
    state text DEFAULT 'active'::text NOT NULL,
    content_asset_revision bigint DEFAULT 1 NOT NULL,
    content_asset_revision_id uuid NOT NULL,
    etag text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tag_set_version bigint DEFAULT 0 NOT NULL,
    tag_manual_override boolean DEFAULT false NOT NULL,
    processing_status text DEFAULT 'ready'::text NOT NULL,
    user_id uuid NOT NULL,
    folder_id uuid,
    asset_kind text DEFAULT 'creative'::text NOT NULL,
    CONSTRAINT content_assets_asset_kind_check CHECK ((asset_kind = ANY (ARRAY['audio'::text, 'image'::text, 'file'::text, 'creative'::text, 'link'::text]))),
    CONSTRAINT content_assets_processing_status_check CHECK ((processing_status = ANY (ARRAY['draft'::text, 'processing'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT content_assets_state_check CHECK ((state = ANY (ARRAY['active'::text, 'deleted'::text]))),
    CONSTRAINT content_assets_title_check CHECK (((length(title) >= 1) AND (length(title) <= 240)))
);

COMMENT ON TABLE public.content_assets IS 'ContentAsset is the account-owned business record for user content.';

COMMENT ON COLUMN public.content_assets.folder_id IS 'Single folder placement, including soft-deleted folders retained for restoration.';

CREATE TABLE public.content_events (
    event_id uuid NOT NULL,
    cursor bigint NOT NULL,
    operation_id uuid NOT NULL,
    object_kind text NOT NULL,
    object_id uuid NOT NULL,
    change_type text NOT NULL,
    tombstone boolean DEFAULT false NOT NULL,
    revision_id uuid,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL
);

CREATE TABLE public.content_jobs (
    task_id uuid NOT NULL,
    content_asset_id uuid NOT NULL,
    content_asset_revision_id uuid NOT NULL,
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

CREATE TABLE public.document_parse_callbacks (
    id uuid NOT NULL,
    request_id text NOT NULL,
    task_id uuid NOT NULL,
    token_hash text NOT NULL,
    token_sealed text NOT NULL,
    contexts jsonb NOT NULL,
    fingerprint text NOT NULL,
    job_id text,
    event_id text,
    terminal_state text,
    result jsonb,
    result_hash text,
    max_response_bytes integer NOT NULL,
    consumed boolean DEFAULT false NOT NULL,
    deadline_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    received_at timestamp with time zone,
    CONSTRAINT document_parse_callbacks_max_response_bytes_check CHECK (((max_response_bytes >= 1024) AND (max_response_bytes <= 67108864))),
    CONSTRAINT document_parse_callbacks_terminal_state_check CHECK (((terminal_state IS NULL) OR (terminal_state = ANY (ARRAY['completed'::text, 'failed'::text, 'cancelled'::text]))))
);

CREATE TABLE public.kb_content_asset_hybrid_builds (
    id uuid NOT NULL,
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    source_revision text NOT NULL,
    user_id uuid NOT NULL,
    task_id uuid NOT NULL,
    content_hash text NOT NULL,
    config_hash text NOT NULL,
    snapshot jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    published boolean DEFAULT false NOT NULL,
    planned boolean DEFAULT false NOT NULL,
    chunk_count integer DEFAULT 0 NOT NULL,
    toc jsonb,
    toc_status text DEFAULT 'pending'::text NOT NULL,
    error_code text,
    cleanup_status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kb_content_asset_hybrid_builds_chunk_count_check CHECK ((chunk_count >= 0)),
    CONSTRAINT kb_content_asset_hybrid_builds_cleanup_status_check CHECK ((cleanup_status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT kb_content_asset_hybrid_builds_published_status_check CHECK (((NOT published) OR (status = 'ready'::text))),
    CONSTRAINT kb_content_asset_hybrid_builds_source_type_check CHECK ((source_type = 'content_asset'::text)),
    CONSTRAINT kb_content_asset_hybrid_builds_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'indexing'::text, 'ready'::text, 'failed'::text, 'superseded'::text, 'deleted'::text]))),
    CONSTRAINT kb_content_asset_hybrid_builds_toc_status_check CHECK ((toc_status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text])))
);

COMMENT ON TABLE public.kb_content_asset_hybrid_builds IS 'Derived index builds for the raw body of a ContentAsset.';

CREATE TABLE public.kb_content_asset_hybrid_chunks (
    build_id uuid NOT NULL,
    ordinal integer NOT NULL,
    point_id text NOT NULL,
    source_start integer NOT NULL,
    source_end integer NOT NULL,
    core_start integer NOT NULL,
    core_end integer NOT NULL,
    section_id text,
    input_hash text NOT NULL,
    token_count integer NOT NULL,
    content_hash text NOT NULL,
    char_count integer NOT NULL,
    index_status text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT kb_content_asset_hybrid_chunks_char_count_check CHECK (((char_count >= 1) AND (char_count <= 500))),
    CONSTRAINT kb_content_asset_hybrid_chunks_core_bounds_check CHECK (((source_start <= core_start) AND (core_start < core_end) AND (core_end <= source_end))),
    CONSTRAINT kb_content_asset_hybrid_chunks_index_status_check CHECK ((index_status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT kb_content_asset_hybrid_chunks_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT kb_content_asset_hybrid_chunks_source_bounds_check CHECK ((source_end > source_start)),
    CONSTRAINT kb_content_asset_hybrid_chunks_source_start_check CHECK ((source_start >= 0)),
    CONSTRAINT kb_content_asset_hybrid_chunks_token_count_check CHECK (((token_count >= 1) AND (token_count <= 8192)))
);

CREATE TABLE public.kb_document_keyword_builds (
    id uuid NOT NULL,
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    source_revision text NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    content_hash text NOT NULL,
    config_hash text NOT NULL,
    snapshot jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    published boolean DEFAULT false NOT NULL,
    planned boolean DEFAULT false NOT NULL,
    chunk_count integer DEFAULT 0 NOT NULL,
    toc jsonb,
    toc_status text DEFAULT 'pending'::text NOT NULL,
    error_code text,
    cleanup_status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kb_document_keyword_builds_check CHECK (((NOT published) OR (status = 'ready'::text))),
    CONSTRAINT kb_document_keyword_builds_chunk_count_check CHECK ((chunk_count >= 0)),
    CONSTRAINT kb_document_keyword_builds_cleanup_status_check CHECK ((cleanup_status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT kb_document_keyword_builds_source_type_check CHECK ((source_type = ANY (ARRAY['file'::text, 'text'::text]))),
    CONSTRAINT kb_document_keyword_builds_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'indexing'::text, 'ready'::text, 'failed'::text, 'superseded'::text, 'deleted'::text]))),
    CONSTRAINT kb_document_keyword_builds_toc_status_check CHECK ((toc_status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text])))
);

CREATE TABLE public.kb_document_keyword_chunks (
    build_id uuid NOT NULL,
    ordinal integer NOT NULL,
    point_id text NOT NULL,
    source_start integer NOT NULL,
    source_end integer NOT NULL,
    content_hash text NOT NULL,
    char_count integer NOT NULL,
    index_status text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT kb_document_keyword_chunks_char_count_check CHECK (((char_count >= 1) AND (char_count <= 2000))),
    CONSTRAINT kb_document_keyword_chunks_check CHECK ((source_end > source_start)),
    CONSTRAINT kb_document_keyword_chunks_index_status_check CHECK ((index_status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT kb_document_keyword_chunks_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT kb_document_keyword_chunks_source_start_check CHECK ((source_start >= 0))
);

CREATE TABLE public.kb_lexical_terms (
    term_key text NOT NULL COLLATE pg_catalog."C",
    token_id bigint NOT NULL,
    CONSTRAINT kb_lexical_terms_term_key_check CHECK ((term_key ~ '^[0-9a-f]{64}$'::text))
);

COMMENT ON TABLE public.kb_lexical_terms IS 'Stable sparse vector coordinates for hashed analyzer terms. Coordinates must never be reassigned.';

ALTER TABLE public.kb_lexical_terms ALTER COLUMN token_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.kb_lexical_terms_token_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 4294967294
    CACHE 1
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

CREATE TABLE public.otp_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text DEFAULT 'phone'::text NOT NULL,
    subject_hash text NOT NULL,
    purpose text NOT NULL,
    code_hash text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    delivery_status text DEFAULT 'pending'::text NOT NULL,
    provider_mode text NOT NULL,
    request_key text,
    request_hash text NOT NULL,
    response_cipher text,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT otp_requests_attempts_check CHECK (((attempts >= 0) AND (attempts <= 5))),
    CONSTRAINT otp_requests_delivery_status_check CHECK ((delivery_status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text]))),
    CONSTRAINT otp_requests_expiry_after_creation CHECK ((expires_at > created_at)),
    CONSTRAINT otp_requests_provider_check CHECK ((provider = 'phone'::text)),
    CONSTRAINT otp_requests_provider_mode_check CHECK ((provider_mode = ANY (ARRAY['mock'::text, 'live'::text]))),
    CONSTRAINT otp_requests_purpose_check CHECK ((purpose = ANY (ARRAY['sign_in'::text, 'sign_up'::text, 'reset_password'::text, 'bind_phone'::text]))),
    CONSTRAINT otp_requests_subject_hash_sha256 CHECK ((subject_hash ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE public.processing_node_assignments (
    request_id text NOT NULL,
    node_id uuid NOT NULL,
    capability text NOT NULL,
    snapshot jsonb NOT NULL,
    settled boolean DEFAULT false NOT NULL,
    started boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT processing_node_assignments_capability_check CHECK ((capability = ANY (ARRAY['document'::text, 'audio'::text]))),
    CONSTRAINT processing_node_assignments_check CHECK ((settled = (settled_at IS NOT NULL))),
    CONSTRAINT processing_node_assignments_request_id_check CHECK (((length(request_id) >= 1) AND (length(request_id) <= 256)))
);

CREATE TABLE public.processing_nodes (
    id uuid NOT NULL,
    config jsonb NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT processing_nodes_config_check CHECK ((jsonb_typeof(config) = 'object'::text)),
    CONSTRAINT processing_nodes_config_shape CHECK ((((NOT (config ? 'enabled'::text)) AND (jsonb_typeof((config -> 'capabilities'::text)) = 'array'::text) AND ((jsonb_array_length((config -> 'capabilities'::text)) >= 1) AND (jsonb_array_length((config -> 'capabilities'::text)) <= 2)) AND ((config -> 'capabilities'::text) <@ '["document", "audio"]'::jsonb) AND (jsonb_typeof((config -> 'concurrency'::text)) = 'number'::text) AND ((((config ->> 'concurrency'::text))::integer >= 1) AND (((config ->> 'concurrency'::text))::integer <= 16)) AND ((((config ->> 'mode'::text) = 'ecs'::text) AND ((config ->> 'regionId'::text) IS NOT NULL) AND ((config ->> 'instanceId'::text) IS NOT NULL) AND ((config ->> 'privateIp'::text) IS NOT NULL)) OR (((config ->> 'mode'::text) = 'always-on'::text) AND ((config ->> 'regionId'::text) IS NULL) AND ((config ->> 'instanceId'::text) IS NULL) AND ((config ->> 'privateIp'::text) IS NULL) AND ((config ->> 'baseUrl'::text) IS NOT NULL)))) IS TRUE)),
    CONSTRAINT processing_nodes_revision_check CHECK ((revision > 0))
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
    CONSTRAINT rag_ingestion_versions_toc_check CHECK ((((toc_status = 'ready'::text) = (toc IS NOT NULL)) AND ((toc IS NULL) OR (jsonb_typeof(toc) = 'array'::text)))),
    CONSTRAINT rag_ingestion_versions_toc_status_check CHECK ((toc_status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text])))
);

CREATE TABLE public.refresh_tokens (
    token_hash text NOT NULL,
    session_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT refresh_tokens_expiry_after_creation CHECK ((expires_at > created_at)),
    CONSTRAINT refresh_tokens_hash_sha256 CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE public.resource_refs (
    resource_id uuid NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid,
    ref_kind text NOT NULL,
    ref_id_external text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_asset_resource_ref_account_only CHECK (((ref_kind <> 'content_asset'::text) OR (workspace_id IS NULL)))
);

CREATE TABLE public.resources (
    resource_id uuid NOT NULL,
    user_id uuid NOT NULL,
    file_name text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 character(64),
    object_key uuid NOT NULL,
    object_version text NOT NULL,
    storage_driver text NOT NULL,
    storage_bucket text,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reference_count bigint DEFAULT 0 NOT NULL,
    CONSTRAINT resources_reference_count_check CHECK ((reference_count >= 0)),
    CONSTRAINT resources_size_bytes_check CHECK ((size_bytes > 0)),
    CONSTRAINT resources_status_check CHECK ((status = ANY (ARRAY['ready'::text, 'deleting'::text])))
);

COMMENT ON TABLE public.resources IS 'Account-owned binary Resource metadata and storage identity.';

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

CREATE TABLE public.runtime_configuration (
    singleton boolean DEFAULT true NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    "values" jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_configuration_revision_check CHECK ((revision > 0)),
    CONSTRAINT runtime_configuration_singleton_check CHECK (singleton),
    CONSTRAINT runtime_configuration_values_check CHECK ((jsonb_typeof("values") = 'object'::text))
);

CREATE TABLE public.storage_jobs (
    task_id uuid NOT NULL,
    upload_id uuid,
    resource_id uuid,
    operation text NOT NULL,
    completed_at timestamp with time zone,
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
    workspace_id uuid,
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
    resume_count integer DEFAULT 0 NOT NULL,
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
    trace_id text NOT NULL,
    trace_context jsonb,
    CONSTRAINT tasks_check CHECK ((((user_id IS NULL) AND (workspace_id IS NULL) AND (kind = ANY (ARRAY['maintenance.check'::text, 'processing.node-start'::text]))) OR ((user_id IS NOT NULL) AND
CASE
    WHEN (kind = ANY (ARRAY['content-asset.tag-extract'::text, 'kb.content-asset-index'::text, 'kb.content-asset-cleanup'::text])) THEN (workspace_id IS NULL)
    ELSE ((workspace_id IS NOT NULL) OR (kind = 'storage.delete'::text))
END))),
    CONSTRAINT tasks_check1 CHECK (((state <> 'succeeded'::text) OR (result_id IS NOT NULL))),
    CONSTRAINT tasks_external_state_check CHECK ((external_state = ANY (ARRAY['none'::text, 'submitted'::text, 'unknown'::text]))),
    CONSTRAINT tasks_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 9))),
    CONSTRAINT tasks_queue_check CHECK ((queue = ANY (ARRAY['content'::text, 'ai'::text, 'commercial'::text, 'maintenance'::text]))),
    CONSTRAINT tasks_resume_count_check CHECK (((resume_count >= 0) AND (resume_count <= attempt_no))),
    CONSTRAINT tasks_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'running'::text, 'retry_scheduled'::text, 'waiting_external'::text, 'reconciling'::text, 'cancel_requested'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT tasks_trace_context_check CHECK (((trace_context IS NULL) OR ((jsonb_typeof(trace_context) = 'object'::text) AND (((trace_context - 'traceparent'::text) - 'tracestate'::text) = '{}'::jsonb) AND (trace_context ? 'traceparent'::text) AND (jsonb_typeof((trace_context -> 'traceparent'::text)) = 'string'::text) AND (length((trace_context ->> 'traceparent'::text)) = 55) AND ((NOT (trace_context ? 'tracestate'::text)) OR ((jsonb_typeof((trace_context -> 'tracestate'::text)) = 'string'::text) AND ((length((trace_context ->> 'tracestate'::text)) >= 1) AND (length((trace_context ->> 'tracestate'::text)) <= 512))))))),
    CONSTRAINT tasks_trace_id_check CHECK ((trace_id ~ '^[A-Za-z0-9._:-]{6,96}$'::text))
);

CREATE TABLE public.text_ingestion_jobs (
    id uuid NOT NULL,
    source_type text NOT NULL,
    raw_content text,
    origin_resource_uri text,
    ingest_status text DEFAULT 'pending'::text NOT NULL,
    error_msg text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    workspace_id uuid NOT NULL,
    current_task_id uuid NOT NULL,
    content_hash text,
    artifact_uri text,
    CONSTRAINT text_ingestion_jobs_content_check CHECK (((raw_content IS NULL) OR (btrim(raw_content) <> ''::text))),
    CONSTRAINT text_ingestion_jobs_content_hash_check CHECK (((content_hash IS NULL) OR (content_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT text_ingestion_jobs_ingest_status_check CHECK ((ingest_status = ANY (ARRAY['pending'::text, 'parsing'::text, 'chunking'::text, 'success'::text, 'failed'::text]))),
    CONSTRAINT text_ingestion_jobs_origin_check CHECK ((((source_type = 'MANUAL_INPUT'::text) AND (origin_resource_uri IS NULL) AND (raw_content IS NOT NULL) AND (char_length(raw_content) <= 50000)) OR ((source_type <> 'MANUAL_INPUT'::text) AND (origin_resource_uri IS NOT NULL) AND ((char_length(origin_resource_uri) >= 1) AND (char_length(origin_resource_uri) <= 4096))))),
    CONSTRAINT text_ingestion_jobs_ready_text_check CHECK (((ingest_status <> ALL (ARRAY['chunking'::text, 'success'::text])) OR (raw_content IS NOT NULL))),
    CONSTRAINT text_ingestion_jobs_source_type_check CHECK ((source_type = ANY (ARRAY['MANUAL_INPUT'::text, 'WEB_CRAWL'::text, 'IMAGE_OCR'::text, 'MEDIA_ASR'::text, 'BOOK_OCR'::text, 'FILE_UPLOAD'::text])))
);

COMMENT ON TABLE public.text_ingestion_jobs IS 'Independent imported content; source_type is acquisition method, not RAG business source. No business version counter.';

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

CREATE TABLE public.user_agreement_acceptances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid,
    agreement_version text NOT NULL,
    privacy_version text NOT NULL,
    accepted_via text NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_agreement_acceptances_accepted_via_check CHECK ((accepted_via = ANY (ARRAY['app'::text, 'web'::text, 'api'::text])))
);

CREATE TABLE public.user_api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    key_prefix text NOT NULL,
    secret_hash text NOT NULL,
    scopes text[] DEFAULT ARRAY[]::text[] NOT NULL,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_api_keys_expiry_after_creation CHECK (((expires_at IS NULL) OR (expires_at > created_at))),
    CONSTRAINT user_api_keys_name_not_blank CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT user_api_keys_prefix_not_blank CHECK ((btrim(key_prefix) <> ''::text)),
    CONSTRAINT user_api_keys_secret_hash_sha256 CHECK ((secret_hash ~ '^[a-f0-9]{64}$'::text))
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

CREATE TABLE public.user_identities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    subject_hash text NOT NULL,
    subject_masked text NOT NULL,
    provider_subject text,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_identities_oauth_subject CHECK (((provider <> 'oauth'::text) OR ((provider_subject IS NOT NULL) AND (btrim(provider_subject) <> ''::text)))),
    CONSTRAINT user_identities_phone_masked CHECK (((provider <> 'phone'::text) OR (subject_masked ~ '^[0-9]{3}[*]{4}[0-9]{4}$'::text))),
    CONSTRAINT user_identities_provider_check CHECK ((provider = ANY (ARRAY['phone'::text, 'email'::text, 'oauth'::text]))),
    CONSTRAINT user_identities_subject_hash_sha256 CHECK ((subject_hash ~ '^[a-f0-9]{64}$'::text))
);

COMMENT ON TABLE public.user_identities IS '服务端HMAC-SHA256身份摘要和脱敏标识；用户与登录方式分离，不保存明文手机号或邮箱。';

CREATE TABLE public.user_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    client_type text NOT NULL,
    client_id text NOT NULL,
    access_jti uuid DEFAULT gen_random_uuid() NOT NULL,
    access_hash text NOT NULL,
    access_expires_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_sessions_access_hash_sha256 CHECK ((access_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT user_sessions_client_id_check CHECK ((btrim(client_id) <> ''::text)),
    CONSTRAINT user_sessions_client_type_check CHECK ((client_type = ANY (ARRAY['app'::text, 'web'::text]))),
    CONSTRAINT user_sessions_expiry_order CHECK ((access_expires_at <= expires_at))
);

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    display_name text DEFAULT '花火用户'::text NOT NULL,
    avatar_resource_id uuid,
    time_zone text DEFAULT 'UTC'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    storage_used_bytes bigint DEFAULT 0 NOT NULL,
    storage_reserved_bytes bigint DEFAULT 0 NOT NULL,
    CONSTRAINT users_deleted_at_matches_status CHECK ((((status = 'deleted'::text) AND (deleted_at IS NOT NULL)) OR ((status <> 'deleted'::text) AND (deleted_at IS NULL)))),
    CONSTRAINT users_display_name_not_blank CHECK ((btrim(display_name) <> ''::text)),
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'deleted'::text]))),
    CONSTRAINT users_storage_reserved_bytes_nonnegative CHECK ((storage_reserved_bytes >= 0)),
    CONSTRAINT users_storage_used_bytes_nonnegative CHECK ((storage_used_bytes >= 0))
);

COMMENT ON TABLE public.users IS '跨 App、Web、API 共用的统一用户账号。';

COMMENT ON COLUMN public.users.avatar_resource_id IS '可选头像资源ID；普通关联字段，由资源服务校验归属，不创建物理外键。';

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

ALTER TABLE ONLY public.account_content_state
    ADD CONSTRAINT account_content_state_pkey PRIMARY KEY (user_id);

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

ALTER TABLE ONLY public.ai_template_runs
    ADD CONSTRAINT ai_template_runs_account_idempotency_key UNIQUE (user_id, idempotency_key);

ALTER TABLE ONLY public.ai_template_runs
    ADD CONSTRAINT ai_template_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ai_template_scenes
    ADD CONSTRAINT ai_template_scenes_pkey PRIMARY KEY (scene_key);

ALTER TABLE ONLY public.ai_template_versions
    ADD CONSTRAINT ai_template_versions_pkey PRIMARY KEY (scene_key, revision);

ALTER TABLE ONLY public.api_idempotency
    ADD CONSTRAINT api_idempotency_pkey PRIMARY KEY (scope, operation, key);

ALTER TABLE ONLY public.asset_folders
    ADD CONSTRAINT asset_folders_account_sibling_name_key UNIQUE (user_id, parent_folder_id, normalized_name) DEFERRABLE;

ALTER TABLE ONLY public.asset_folders
    ADD CONSTRAINT asset_folders_pkey PRIMARY KEY (folder_id);

ALTER TABLE ONLY public.asset_tags
    ADD CONSTRAINT asset_tags_account_name_key UNIQUE (user_id, normalized_name);

ALTER TABLE public.asset_tags
    ADD CONSTRAINT asset_tags_name_length CHECK (((length(normalized_name) >= 1) AND (length(normalized_name) <= 24) AND ((length(display_name) >= 1) AND (length(display_name) <= 24)))) NOT VALID;

ALTER TABLE ONLY public.asset_tags
    ADD CONSTRAINT asset_tags_pkey PRIMARY KEY (tag_id);

ALTER TABLE ONLY public.auth_rate_limits
    ADD CONSTRAINT auth_rate_limits_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.billing_policies
    ADD CONSTRAINT billing_policies_pkey PRIMARY KEY (policy_version);

ALTER TABLE ONLY public.content_asset_parts
    ADD CONSTRAINT content_asset_parts_pkey PRIMARY KEY (content_asset_id, part);

ALTER TABLE ONLY public.content_asset_relations
    ADD CONSTRAINT content_asset_relations_account_edge_key UNIQUE (user_id, source_content_asset_id, target_content_asset_id, relation_type);

ALTER TABLE ONLY public.content_asset_relations
    ADD CONSTRAINT content_asset_relations_pkey PRIMARY KEY (relation_id);

ALTER TABLE ONLY public.content_asset_resource_refs
    ADD CONSTRAINT content_asset_resource_refs_pkey PRIMARY KEY (content_asset_id, ref_order);

ALTER TABLE ONLY public.content_asset_resource_refs
    ADD CONSTRAINT content_asset_resource_refs_resource_usage_anchor_key UNIQUE (content_asset_id, resource_id, usage, anchor);

ALTER TABLE ONLY public.content_asset_tag_suggestions
    ADD CONSTRAINT content_asset_tag_suggestions_pkey PRIMARY KEY (suggestion_id);

ALTER TABLE ONLY public.content_asset_tag_suggestions
    ADD CONSTRAINT content_asset_tag_suggestions_task_id_key UNIQUE (task_id);

ALTER TABLE ONLY public.content_asset_tags
    ADD CONSTRAINT content_asset_tags_pkey PRIMARY KEY (content_asset_id, tag_id);

ALTER TABLE ONLY public.content_assets
    ADD CONSTRAINT content_assets_pkey PRIMARY KEY (content_asset_id);

ALTER TABLE ONLY public.content_events
    ADD CONSTRAINT content_events_account_cursor_key UNIQUE (user_id, cursor);

ALTER TABLE ONLY public.content_events
    ADD CONSTRAINT content_events_pkey PRIMARY KEY (event_id);

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

ALTER TABLE ONLY public.document_parse_callbacks
    ADD CONSTRAINT document_parse_callbacks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.document_parse_callbacks
    ADD CONSTRAINT document_parse_callbacks_request_id_key UNIQUE (request_id);

ALTER TABLE ONLY public.kb_content_asset_hybrid_builds
    ADD CONSTRAINT kb_content_asset_hybrid_builds_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.kb_content_asset_hybrid_builds
    ADD CONSTRAINT kb_content_asset_hybrid_builds_source_config_key UNIQUE (source_type, source_id, source_revision, config_hash);

ALTER TABLE ONLY public.kb_content_asset_hybrid_chunks
    ADD CONSTRAINT kb_content_asset_hybrid_chunks_build_id_point_id_key UNIQUE (build_id, point_id);

ALTER TABLE ONLY public.kb_content_asset_hybrid_chunks
    ADD CONSTRAINT kb_content_asset_hybrid_chunks_pkey PRIMARY KEY (build_id, ordinal);

ALTER TABLE ONLY public.kb_document_keyword_builds
    ADD CONSTRAINT kb_document_keyword_builds_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.kb_document_keyword_builds
    ADD CONSTRAINT kb_document_keyword_builds_source_type_source_id_source_rev_key UNIQUE (source_type, source_id, source_revision, config_hash);

ALTER TABLE ONLY public.kb_document_keyword_chunks
    ADD CONSTRAINT kb_document_keyword_chunks_build_id_point_id_key UNIQUE (build_id, point_id);

ALTER TABLE ONLY public.kb_document_keyword_chunks
    ADD CONSTRAINT kb_document_keyword_chunks_pkey PRIMARY KEY (build_id, ordinal);

ALTER TABLE ONLY public.kb_lexical_terms
    ADD CONSTRAINT kb_lexical_terms_pkey PRIMARY KEY (term_key);

ALTER TABLE ONLY public.kb_lexical_terms
    ADD CONSTRAINT kb_lexical_terms_token_id_key UNIQUE (token_id);

ALTER TABLE ONLY public.onboarding_drafts
    ADD CONSTRAINT onboarding_drafts_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY public.otp_requests
    ADD CONSTRAINT otp_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.otp_requests
    ADD CONSTRAINT otp_requests_provider_subject_hash_request_key_key UNIQUE (provider, subject_hash, request_key);

ALTER TABLE ONLY public.processing_node_assignments
    ADD CONSTRAINT processing_node_assignments_pkey PRIMARY KEY (request_id);

ALTER TABLE ONLY public.processing_nodes
    ADD CONSTRAINT processing_nodes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.provider_usage_measurements
    ADD CONSTRAINT provider_usage_measurements_pkey PRIMARY KEY (measurement_id);

ALTER TABLE ONLY public.rag_document_assets
    ADD CONSTRAINT rag_document_assets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rag_ingestion_versions
    ADD CONSTRAINT rag_ingestion_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rag_ingestion_versions
    ADD CONSTRAINT rag_ingestion_versions_user_id_idempotency_key_key UNIQUE (user_id, idempotency_key);

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (token_hash);

ALTER TABLE ONLY public.resource_refs
    ADD CONSTRAINT resource_refs_pkey PRIMARY KEY (resource_id, ref_kind, ref_id_external);

ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_object_key_key UNIQUE (object_key);

ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_pkey PRIMARY KEY (resource_id);

ALTER TABLE ONLY public.run_usage
    ADD CONSTRAINT run_usage_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY public.runtime_configuration
    ADD CONSTRAINT runtime_configuration_pkey PRIMARY KEY (singleton);

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

ALTER TABLE ONLY public.text_ingestion_jobs
    ADD CONSTRAINT text_ingestion_jobs_current_task_id_key UNIQUE (current_task_id);

ALTER TABLE ONLY public.text_ingestion_jobs
    ADD CONSTRAINT text_ingestion_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.usage_periods
    ADD CONSTRAINT usage_periods_pkey PRIMARY KEY (user_id, period_start);

ALTER TABLE ONLY public.user_agreement_acceptances
    ADD CONSTRAINT user_agreement_acceptances_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_api_keys
    ADD CONSTRAINT user_api_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_api_keys
    ADD CONSTRAINT user_api_keys_secret_hash_key UNIQUE (secret_hash);

ALTER TABLE ONLY public.user_audit_events
    ADD CONSTRAINT user_audit_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_identities
    ADD CONSTRAINT user_identities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_identities
    ADD CONSTRAINT user_identities_provider_subject_hash_key UNIQUE (provider, subject_hash);

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_access_hash_key UNIQUE (access_hash);

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

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

CREATE INDEX ai_template_outline_results_idx ON public.ai_template_runs USING btree (user_id, content_asset_id, source_revision, item_key, finished_at DESC, id DESC) WHERE ((scene_key = 'content_asset_outline'::text) AND (state = 'succeeded'::text));

CREATE INDEX asset_folders_parent ON public.asset_folders USING btree (user_id, parent_folder_id, state);

CREATE INDEX asset_folders_rel_eaada2cb5267_idx ON public.asset_folders USING btree (parent_folder_id);

CREATE UNIQUE INDEX asset_folders_root_name ON public.asset_folders USING btree (user_id, normalized_name) WHERE (parent_folder_id IS NULL);

CREATE INDEX content_asset_relations_source_idx ON public.content_asset_relations USING btree (source_content_asset_id);

CREATE INDEX content_asset_relations_target_idx ON public.content_asset_relations USING btree (target_content_asset_id);

CREATE INDEX content_asset_resource_refs_resource_id_idx ON public.content_asset_resource_refs USING btree (resource_id);

CREATE INDEX content_asset_tag_suggestions_content_asset_id_idx ON public.content_asset_tag_suggestions USING btree (content_asset_id);

CREATE INDEX content_asset_tag_suggestions_scope ON public.content_asset_tag_suggestions USING btree (user_id, content_asset_id, status, created_at DESC);

CREATE INDEX content_asset_tags_topic_members ON public.content_asset_tags USING btree (tag_id, content_asset_id);

CREATE INDEX content_assets_folder_page ON public.content_assets USING btree (folder_id, user_id, state, updated_at DESC, content_asset_id);

CREATE INDEX content_assets_graph_page ON public.content_assets USING btree (user_id, content_asset_id) WHERE (state = 'active'::text);

CREATE INDEX content_assets_scope ON public.content_assets USING btree (user_id, state, updated_at DESC, content_asset_id);

CREATE INDEX content_jobs_content_asset_idx ON public.content_jobs USING btree (content_asset_id, content_asset_revision_id);

CREATE INDEX credit_ledger_entries_rel_238b95074ea1_idx ON public.credit_ledger_entries USING btree (user_id);

CREATE INDEX credit_ledger_entries_rel_da90414de691_idx ON public.credit_ledger_entries USING btree (lot_id);

CREATE INDEX credit_ledger_entries_rel_dbf483598c8b_idx ON public.credit_ledger_entries USING btree (reservation_id);

CREATE INDEX credit_lots_rel_dce7d7ce5af0_idx ON public.credit_lots USING btree (policy_version);

CREATE INDEX credit_lots_user_active ON public.credit_lots USING btree (user_id, lot_kind, expires_at);

CREATE INDEX credit_reservation_lots_rel_d884bd853427_idx ON public.credit_reservation_lots USING btree (lot_id);

CREATE INDEX credit_reservations_rel_19f99abed1de_idx ON public.credit_reservations USING btree (policy_version);

CREATE INDEX credit_reservations_rel_59d341c94760_idx ON public.credit_reservations USING btree (task_id);

CREATE INDEX document_parse_callbacks_task ON public.document_parse_callbacks USING btree (task_id);

CREATE INDEX kb_content_asset_hybrid_builds_owner ON public.kb_content_asset_hybrid_builds USING btree (user_id, source_id, created_at DESC);

CREATE UNIQUE INDEX kb_content_asset_hybrid_builds_published ON public.kb_content_asset_hybrid_builds USING btree (source_type, source_id) WHERE published;

CREATE INDEX kb_content_asset_hybrid_builds_source ON public.kb_content_asset_hybrid_builds USING btree (source_id, source_revision);

CREATE INDEX kb_content_asset_hybrid_builds_task ON public.kb_content_asset_hybrid_builds USING btree (task_id);

CREATE INDEX kb_content_asset_hybrid_chunks_point ON public.kb_content_asset_hybrid_chunks USING btree (point_id);

CREATE INDEX kb_content_asset_hybrid_chunks_ready ON public.kb_content_asset_hybrid_chunks USING btree (build_id, point_id) WHERE (index_status = 'ready'::text);

CREATE INDEX kb_document_keyword_builds_owner ON public.kb_document_keyword_builds USING btree (user_id, workspace_id, source_type, source_id, created_at DESC);

CREATE UNIQUE INDEX kb_document_keyword_builds_published ON public.kb_document_keyword_builds USING btree (source_type, source_id) WHERE published;

CREATE INDEX kb_document_keyword_builds_source ON public.kb_document_keyword_builds USING btree (source_id, source_revision);

CREATE INDEX kb_document_keyword_builds_task ON public.kb_document_keyword_builds USING btree (task_id);

CREATE INDEX kb_document_keyword_builds_workspace ON public.kb_document_keyword_builds USING btree (workspace_id);

CREATE INDEX kb_document_keyword_chunks_point ON public.kb_document_keyword_chunks USING btree (point_id);

CREATE INDEX kb_document_keyword_chunks_ready ON public.kb_document_keyword_chunks USING btree (build_id, point_id) WHERE (index_status = 'ready'::text);

CREATE INDEX otp_requests_active_idx ON public.otp_requests USING btree (subject_hash, expires_at) WHERE ((consumed_at IS NULL) AND (delivery_status = 'sent'::text));

CREATE INDEX otp_requests_subject_created_idx ON public.otp_requests USING btree (subject_hash, created_at DESC);

CREATE INDEX outbox_due ON public.task_outbox USING btree (status, available_at);

CREATE INDEX processing_node_assignments_active ON public.processing_node_assignments USING btree (node_id, created_at) WHERE (NOT settled);

CREATE INDEX processing_node_assignments_node ON public.processing_node_assignments USING btree (node_id);

CREATE UNIQUE INDEX processing_nodes_api_identity ON public.processing_nodes USING btree (((config ->> 'baseUrl'::text))) WHERE ((config ->> 'mode'::text) = 'always-on'::text);

CREATE INDEX processing_nodes_config ON public.processing_nodes USING gin (config);

CREATE UNIQUE INDEX processing_nodes_ecs_identity ON public.processing_nodes USING btree (((config ->> 'regionId'::text)), ((config ->> 'instanceId'::text))) WHERE ((config ->> 'mode'::text) = 'ecs'::text);

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

CREATE INDEX refresh_tokens_active_session_idx ON public.refresh_tokens USING btree (session_id, expires_at) WHERE (consumed_at IS NULL);

CREATE INDEX refresh_tokens_session_id_idx ON public.refresh_tokens USING btree (session_id);

CREATE INDEX resource_refs_owner ON public.resource_refs USING btree (user_id, ref_kind, ref_id_external, workspace_id);

CREATE INDEX resource_refs_rel_fd1aafa8ffad_idx ON public.resource_refs USING btree (resource_id, user_id, workspace_id);

CREATE INDEX resources_owner_created ON public.resources USING btree (user_id, created_at DESC, resource_id);

CREATE INDEX run_usage_rel_02f1c5259823_idx ON public.run_usage USING btree (reservation_id);

CREATE INDEX run_usage_rel_2d614c28d464_idx ON public.run_usage USING btree (policy_version);

CREATE INDEX run_usage_rel_4c561b1f491b_idx ON public.run_usage USING btree (user_id);

CREATE INDEX run_usage_rel_689866adeec4_idx ON public.run_usage USING btree (task_id);

CREATE INDEX storage_reservations_active_user ON public.storage_reservations USING btree (user_id, status) INCLUDE (requested_bytes, confirmed_bytes) WHERE (status = ANY (ARRAY['reserved'::text, 'confirmed'::text]));

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

CREATE INDEX text_ingestion_jobs_owner_scope ON public.text_ingestion_jobs USING btree (created_by, workspace_id, updated_at, id);

CREATE INDEX text_ingestion_jobs_workspace ON public.text_ingestion_jobs USING btree (workspace_id, created_by);

CREATE INDEX user_agreement_acceptances_session_id_idx ON public.user_agreement_acceptances USING btree (session_id);

CREATE INDEX user_agreement_acceptances_user_idx ON public.user_agreement_acceptances USING btree (user_id, accepted_at DESC);

CREATE INDEX user_api_keys_active_user_idx ON public.user_api_keys USING btree (user_id, expires_at) WHERE (revoked_at IS NULL);

CREATE INDEX user_api_keys_user_id_idx ON public.user_api_keys USING btree (user_id);

CREATE INDEX user_audit_events_rel_659dfb76291e_idx ON public.user_audit_events USING btree (user_id);

CREATE INDEX user_identities_user_id_idx ON public.user_identities USING btree (user_id);

CREATE INDEX user_sessions_access_jti_idx ON public.user_sessions USING btree (access_jti);

CREATE INDEX user_sessions_active_user_idx ON public.user_sessions USING btree (user_id, expires_at DESC) WHERE (revoked_at IS NULL);

CREATE INDEX user_sessions_user_id_idx ON public.user_sessions USING btree (user_id);

CREATE INDEX users_avatar_resource_id_idx ON public.users USING btree (avatar_resource_id);

CREATE UNIQUE INDEX workspace_default ON public.workspaces USING btree (user_id) WHERE is_default;

CREATE UNIQUE INDEX workspace_initial ON public.workspaces USING btree (user_id) WHERE is_initial;

CREATE INDEX workspaces_rel_e7fed022db47_idx ON public.workspaces USING btree (user_id);

CREATE TRIGGER content_asset_tags_lifecycle_fence BEFORE UPDATE OF state ON public.content_assets FOR EACH ROW EXECUTE FUNCTION public.content_asset_tags_lifecycle_fence();

CREATE TRIGGER sessions_bearer_auth_cache_delete AFTER DELETE ON public.user_sessions FOR EACH ROW EXECUTE FUNCTION public.notify_bearer_auth_cache_change();

CREATE TRIGGER sessions_bearer_auth_cache_status
AFTER UPDATE OF access_hash, access_jti, access_expires_at, expires_at, revoked_at ON public.user_sessions
FOR EACH ROW
WHEN (ROW(OLD.access_hash, OLD.access_jti, OLD.access_expires_at, OLD.expires_at, OLD.revoked_at)
  IS DISTINCT FROM ROW(NEW.access_hash, NEW.access_jti, NEW.access_expires_at, NEW.expires_at, NEW.revoked_at))
EXECUTE FUNCTION public.notify_bearer_auth_cache_change();

CREATE TRIGGER user_identities_set_updated_at BEFORE UPDATE ON public.user_identities FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER users_bearer_auth_cache_delete AFTER DELETE ON public.users FOR EACH ROW EXECUTE FUNCTION public.notify_bearer_auth_cache_change();

CREATE TRIGGER users_bearer_auth_cache_status AFTER UPDATE OF status, deleted_at ON public.users FOR EACH ROW WHEN (((old.status IS DISTINCT FROM new.status) OR (old.deleted_at IS DISTINCT FROM new.deleted_at))) EXECUTE FUNCTION public.notify_bearer_auth_cache_change();

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

GRANT ALL ON SCHEMA public TO huahuo_migrator;
GRANT USAGE ON SCHEMA public TO huahuo_api;
GRANT USAGE ON SCHEMA public TO huahuo_admin;
GRANT USAGE ON SCHEMA public TO huahuo_worker;
GRANT USAGE ON SCHEMA public TO huahuo_scheduler;

GRANT SELECT ON TABLE public.account_content_state TO huahuo_admin;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_content_state TO huahuo_api;
GRANT SELECT ON TABLE public.account_content_state TO huahuo_scheduler;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_content_state TO huahuo_worker;

GRANT SELECT ON TABLE public.account_memberships TO huahuo_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.account_memberships TO huahuo_api;
GRANT SELECT ON TABLE public.account_memberships TO huahuo_scheduler;
GRANT SELECT,INSERT,UPDATE ON TABLE public.account_memberships TO huahuo_worker;

GRANT SELECT,INSERT ON TABLE public.admin_audit_events TO huahuo_admin;

GRANT SELECT,INSERT,UPDATE ON TABLE public.admin_login_limits TO huahuo_admin;

GRANT SELECT,INSERT,UPDATE ON TABLE public.admin_sessions TO huahuo_admin;

GRANT SELECT,INSERT,UPDATE ON TABLE public.admin_users TO huahuo_admin;

GRANT SELECT,UPDATE ON TABLE public.ai_template_scenes TO huahuo_admin;

GRANT SELECT,INSERT ON TABLE public.ai_template_versions TO huahuo_admin;

GRANT SELECT ON TABLE public.ai_template_published TO huahuo_api;

GRANT SELECT,INSERT,UPDATE ON TABLE public.ai_template_runs TO huahuo_api;

GRANT SELECT,INSERT ON TABLE public.api_idempotency TO huahuo_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.api_idempotency TO huahuo_api;

GRANT SELECT ON TABLE public.asset_folders TO huahuo_admin;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.asset_folders TO huahuo_api;
GRANT SELECT ON TABLE public.asset_folders TO huahuo_scheduler;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.asset_folders TO huahuo_worker;

GRANT SELECT ON TABLE public.asset_tags TO huahuo_admin;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.asset_tags TO huahuo_api;
GRANT SELECT ON TABLE public.asset_tags TO huahuo_scheduler;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.asset_tags TO huahuo_worker;

GRANT SELECT,INSERT,UPDATE ON TABLE public.auth_rate_limits TO huahuo_api;

GRANT SELECT ON TABLE public.billing_policies TO huahuo_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.billing_policies TO huahuo_api;
GRANT SELECT ON TABLE public.billing_policies TO huahuo_scheduler;
GRANT SELECT ON TABLE public.billing_policies TO huahuo_worker;

GRANT SELECT ON TABLE public.content_asset_parts TO huahuo_admin;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.content_asset_parts TO huahuo_api;
GRANT SELECT ON TABLE public.content_asset_parts TO huahuo_scheduler;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.content_asset_parts TO huahuo_worker;

GRANT SELECT ON TABLE public.content_asset_relations TO huahuo_admin;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.content_asset_relations TO huahuo_api;
GRANT SELECT ON TABLE public.content_asset_relations TO huahuo_scheduler;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.content_asset_relations TO huahuo_worker;

GRANT SELECT ON TABLE public.content_asset_resource_refs TO huahuo_admin;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.content_asset_resource_refs TO huahuo_api;
GRANT SELECT ON TABLE public.content_asset_resource_refs TO huahuo_scheduler;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.content_asset_resource_refs TO huahuo_worker;

GRANT SELECT ON TABLE public.content_asset_tag_suggestions TO huahuo_admin;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.content_asset_tag_suggestions TO huahuo_api;
GRANT SELECT ON TABLE public.content_asset_tag_suggestions TO huahuo_scheduler;
GRANT SELECT,INSERT,UPDATE ON TABLE public.content_asset_tag_suggestions TO huahuo_worker;

GRANT SELECT ON TABLE public.content_asset_tags TO huahuo_admin;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.content_asset_tags TO huahuo_api;
GRANT SELECT ON TABLE public.content_asset_tags TO huahuo_scheduler;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.content_asset_tags TO huahuo_worker;

GRANT SELECT ON TABLE public.content_assets TO huahuo_admin;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.content_assets TO huahuo_api;
GRANT SELECT ON TABLE public.content_assets TO huahuo_scheduler;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.content_assets TO huahuo_worker;

GRANT SELECT ON TABLE public.content_events TO huahuo_admin;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.content_events TO huahuo_api;
GRANT SELECT ON TABLE public.content_events TO huahuo_scheduler;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.content_events TO huahuo_worker;

GRANT SELECT ON TABLE public.content_jobs TO huahuo_admin;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.content_jobs TO huahuo_api;
GRANT SELECT ON TABLE public.content_jobs TO huahuo_scheduler;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.content_jobs TO huahuo_worker;

GRANT SELECT ON TABLE public.credit_ledger_entries TO huahuo_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.credit_ledger_entries TO huahuo_api;
GRANT SELECT ON TABLE public.credit_ledger_entries TO huahuo_scheduler;
GRANT SELECT,INSERT,UPDATE ON TABLE public.credit_ledger_entries TO huahuo_worker;

GRANT INSERT(entry_id) ON TABLE public.credit_ledger_entries TO huahuo_scheduler;

GRANT INSERT(user_id) ON TABLE public.credit_ledger_entries TO huahuo_scheduler;

GRANT INSERT(reservation_id) ON TABLE public.credit_ledger_entries TO huahuo_scheduler;

GRANT INSERT(lot_id) ON TABLE public.credit_ledger_entries TO huahuo_scheduler;

GRANT INSERT(entry_type) ON TABLE public.credit_ledger_entries TO huahuo_scheduler;

GRANT INSERT(credits) ON TABLE public.credit_ledger_entries TO huahuo_scheduler;

GRANT SELECT ON TABLE public.credit_lots TO huahuo_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.credit_lots TO huahuo_api;
GRANT SELECT ON TABLE public.credit_lots TO huahuo_scheduler;
GRANT SELECT,INSERT,UPDATE ON TABLE public.credit_lots TO huahuo_worker;

GRANT UPDATE(available_credits) ON TABLE public.credit_lots TO huahuo_scheduler;

GRANT UPDATE(reserved_credits) ON TABLE public.credit_lots TO huahuo_scheduler;

GRANT SELECT ON TABLE public.credit_reservation_lots TO huahuo_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.credit_reservation_lots TO huahuo_api;
GRANT SELECT ON TABLE public.credit_reservation_lots TO huahuo_scheduler;
GRANT SELECT,INSERT,UPDATE ON TABLE public.credit_reservation_lots TO huahuo_worker;

GRANT SELECT ON TABLE public.credit_reservations TO huahuo_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.credit_reservations TO huahuo_api;
GRANT SELECT ON TABLE public.credit_reservations TO huahuo_scheduler;
GRANT SELECT,INSERT,UPDATE ON TABLE public.credit_reservations TO huahuo_worker;

GRANT UPDATE(status) ON TABLE public.credit_reservations TO huahuo_scheduler;

GRANT UPDATE(updated_at) ON TABLE public.credit_reservations TO huahuo_scheduler;

GRANT SELECT,INSERT,UPDATE ON TABLE public.document_parse_callbacks TO huahuo_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.document_parse_callbacks TO huahuo_worker;
GRANT SELECT ON TABLE public.document_parse_callbacks TO huahuo_scheduler;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.kb_content_asset_hybrid_builds TO huahuo_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.kb_content_asset_hybrid_builds TO huahuo_worker;
GRANT SELECT ON TABLE public.kb_content_asset_hybrid_builds TO huahuo_admin;
GRANT SELECT ON TABLE public.kb_content_asset_hybrid_builds TO huahuo_scheduler;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.kb_content_asset_hybrid_chunks TO huahuo_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.kb_content_asset_hybrid_chunks TO huahuo_worker;
GRANT SELECT ON TABLE public.kb_content_asset_hybrid_chunks TO huahuo_admin;
GRANT SELECT ON TABLE public.kb_content_asset_hybrid_chunks TO huahuo_scheduler;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.kb_document_keyword_builds TO huahuo_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.kb_document_keyword_builds TO huahuo_worker;
GRANT SELECT ON TABLE public.kb_document_keyword_builds TO huahuo_admin;
GRANT SELECT ON TABLE public.kb_document_keyword_builds TO huahuo_scheduler;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.kb_document_keyword_chunks TO huahuo_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.kb_document_keyword_chunks TO huahuo_worker;
GRANT SELECT ON TABLE public.kb_document_keyword_chunks TO huahuo_admin;
GRANT SELECT ON TABLE public.kb_document_keyword_chunks TO huahuo_scheduler;

GRANT SELECT ON TABLE public.kb_lexical_terms TO huahuo_api;
GRANT SELECT,INSERT ON TABLE public.kb_lexical_terms TO huahuo_worker;

GRANT USAGE ON SEQUENCE public.kb_lexical_terms_token_id_seq TO huahuo_worker;

GRANT SELECT,INSERT,UPDATE ON TABLE public.onboarding_drafts TO huahuo_api;

GRANT SELECT,INSERT,UPDATE ON TABLE public.otp_requests TO huahuo_api;

GRANT SELECT,INSERT,UPDATE ON TABLE public.processing_node_assignments TO huahuo_worker;
GRANT SELECT,INSERT,UPDATE ON TABLE public.processing_node_assignments TO huahuo_admin;
GRANT SELECT,UPDATE ON TABLE public.processing_node_assignments TO huahuo_scheduler;
GRANT SELECT,UPDATE ON TABLE public.processing_node_assignments TO huahuo_api;

GRANT SELECT ON TABLE public.processing_nodes TO huahuo_api;
GRANT SELECT ON TABLE public.processing_nodes TO huahuo_worker;
GRANT SELECT ON TABLE public.processing_nodes TO huahuo_scheduler;
GRANT SELECT,INSERT,UPDATE ON TABLE public.processing_nodes TO huahuo_admin;

GRANT SELECT ON TABLE public.provider_usage_measurements TO huahuo_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.provider_usage_measurements TO huahuo_api;
GRANT SELECT ON TABLE public.provider_usage_measurements TO huahuo_scheduler;
GRANT SELECT,INSERT,UPDATE ON TABLE public.provider_usage_measurements TO huahuo_worker;

GRANT SELECT ON TABLE public.rag_document_assets TO huahuo_admin;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.rag_document_assets TO huahuo_api;
GRANT SELECT ON TABLE public.rag_document_assets TO huahuo_scheduler;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.rag_document_assets TO huahuo_worker;

GRANT SELECT ON TABLE public.rag_ingestion_versions TO huahuo_admin;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.rag_ingestion_versions TO huahuo_api;
GRANT SELECT ON TABLE public.rag_ingestion_versions TO huahuo_scheduler;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.rag_ingestion_versions TO huahuo_worker;

GRANT SELECT,INSERT,UPDATE ON TABLE public.refresh_tokens TO huahuo_api;

GRANT SELECT ON TABLE public.resource_refs TO huahuo_admin;
GRANT SELECT,INSERT,DELETE ON TABLE public.resource_refs TO huahuo_api;
GRANT SELECT ON TABLE public.resource_refs TO huahuo_worker;

GRANT SELECT ON TABLE public.resources TO huahuo_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.resources TO huahuo_api;
GRANT SELECT,DELETE,UPDATE ON TABLE public.resources TO huahuo_worker;

GRANT SELECT ON TABLE public.run_usage TO huahuo_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.run_usage TO huahuo_api;
GRANT SELECT ON TABLE public.run_usage TO huahuo_scheduler;
GRANT SELECT,INSERT,UPDATE ON TABLE public.run_usage TO huahuo_worker;

GRANT SELECT ON TABLE public.runtime_configuration TO huahuo_api;
GRANT SELECT ON TABLE public.runtime_configuration TO huahuo_worker;
GRANT SELECT ON TABLE public.runtime_configuration TO huahuo_scheduler;
GRANT SELECT,UPDATE ON TABLE public.runtime_configuration TO huahuo_admin;

GRANT SELECT ON TABLE public.storage_jobs TO huahuo_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.storage_jobs TO huahuo_api;
GRANT SELECT,INSERT ON TABLE public.storage_jobs TO huahuo_scheduler;
GRANT SELECT ON TABLE public.storage_jobs TO huahuo_worker;

GRANT UPDATE(completed_at) ON TABLE public.storage_jobs TO huahuo_worker;

GRANT SELECT ON TABLE public.storage_reservations TO huahuo_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.storage_reservations TO huahuo_api;
GRANT SELECT,UPDATE ON TABLE public.storage_reservations TO huahuo_scheduler;
GRANT SELECT,INSERT,UPDATE ON TABLE public.storage_reservations TO huahuo_worker;

GRANT SELECT ON TABLE public.task_attempts TO huahuo_admin;
GRANT SELECT,UPDATE ON TABLE public.task_attempts TO huahuo_scheduler;
GRANT SELECT,INSERT,UPDATE ON TABLE public.task_attempts TO huahuo_worker;

GRANT SELECT,INSERT ON TABLE public.task_events TO huahuo_admin;
GRANT SELECT,INSERT ON TABLE public.task_events TO huahuo_api;
GRANT SELECT,INSERT ON TABLE public.task_events TO huahuo_scheduler;
GRANT SELECT,INSERT ON TABLE public.task_events TO huahuo_worker;

GRANT SELECT,INSERT ON TABLE public.task_inputs TO huahuo_api;
GRANT SELECT ON TABLE public.task_inputs TO huahuo_worker;

GRANT SELECT,INSERT ON TABLE public.task_outbox TO huahuo_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.task_outbox TO huahuo_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.task_outbox TO huahuo_scheduler;
GRANT SELECT,INSERT ON TABLE public.task_outbox TO huahuo_worker;

GRANT UPDATE(available_at) ON TABLE public.task_outbox TO huahuo_admin;
GRANT UPDATE(available_at) ON TABLE public.task_outbox TO huahuo_worker;

GRANT SELECT ON TABLE public.task_results TO huahuo_api;
GRANT SELECT,INSERT ON TABLE public.task_results TO huahuo_worker;

GRANT SELECT,INSERT ON TABLE public.task_schedule_windows TO huahuo_scheduler;

GRANT SELECT,INSERT,UPDATE ON TABLE public.task_schedules TO huahuo_scheduler;

GRANT SELECT,INSERT,UPDATE ON TABLE public.tasks TO huahuo_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.tasks TO huahuo_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.tasks TO huahuo_scheduler;
GRANT SELECT,INSERT,UPDATE ON TABLE public.tasks TO huahuo_worker;

GRANT SELECT,INSERT,UPDATE ON TABLE public.text_ingestion_jobs TO huahuo_api;
GRANT SELECT,UPDATE ON TABLE public.text_ingestion_jobs TO huahuo_worker;

GRANT SELECT ON TABLE public.usage_periods TO huahuo_admin;
GRANT SELECT,INSERT,UPDATE ON TABLE public.usage_periods TO huahuo_api;
GRANT SELECT ON TABLE public.usage_periods TO huahuo_scheduler;
GRANT SELECT,INSERT,UPDATE ON TABLE public.usage_periods TO huahuo_worker;

GRANT SELECT,INSERT ON TABLE public.user_agreement_acceptances TO huahuo_api;

GRANT SELECT,INSERT,UPDATE ON TABLE public.user_api_keys TO huahuo_api;

GRANT SELECT,INSERT ON TABLE public.user_audit_events TO huahuo_api;

GRANT SELECT,INSERT,UPDATE ON TABLE public.user_identities TO huahuo_api;

GRANT SELECT(id) ON TABLE public.user_identities TO huahuo_admin;

GRANT SELECT(user_id) ON TABLE public.user_identities TO huahuo_admin;

GRANT SELECT(provider) ON TABLE public.user_identities TO huahuo_admin;

GRANT SELECT(subject_masked) ON TABLE public.user_identities TO huahuo_admin;

GRANT SELECT(verified_at) ON TABLE public.user_identities TO huahuo_admin;

GRANT SELECT(created_at) ON TABLE public.user_identities TO huahuo_admin;

GRANT SELECT,INSERT,UPDATE ON TABLE public.user_sessions TO huahuo_api;

GRANT SELECT,INSERT,UPDATE ON TABLE public.users TO huahuo_api;
GRANT SELECT ON TABLE public.users TO huahuo_worker;

GRANT SELECT(id) ON TABLE public.users TO huahuo_admin;

GRANT SELECT(display_name) ON TABLE public.users TO huahuo_admin;

GRANT SELECT(status) ON TABLE public.users TO huahuo_admin;

GRANT SELECT(created_at) ON TABLE public.users TO huahuo_admin;

GRANT UPDATE(storage_used_bytes) ON TABLE public.users TO huahuo_worker;

GRANT UPDATE(storage_reserved_bytes) ON TABLE public.users TO huahuo_worker;

GRANT SELECT,INSERT,UPDATE ON TABLE public.workspace_profiles TO huahuo_api;

GRANT SELECT,INSERT,UPDATE ON TABLE public.workspaces TO huahuo_api;

GRANT SELECT(id) ON TABLE public.workspaces TO huahuo_worker;

GRANT SELECT(user_id) ON TABLE public.workspaces TO huahuo_worker;

GRANT SELECT(state) ON TABLE public.workspaces TO huahuo_worker;

--

GRANT SELECT ON TABLE public.schema_migrations TO huahuo_api, huahuo_admin, huahuo_worker, huahuo_scheduler;

-- Fresh-install seed data.
INSERT INTO public.billing_policies ("mode", "currency", "policy_version", "monthly_credit_limit")
VALUES ('development', 'USD', 'credit-policy-v1', 10000000);

INSERT INTO public.task_schedules ("id", "enabled", "last_window", "interval_seconds")
VALUES ('maintenance-check-v1', false, NULL, 3600);

INSERT INTO public.processing_nodes ("id", "config", "revision")
VALUES ('ca9e1931-f4ed-4e52-8c2e-5cc316f91501', $seed${
  "mode": "ecs",
  "name": "智能文档解析 · CPU",
  "baseUrl": "http://172.18.102.103:8000",
  "regionId": "cn-beijing",
  "tokenEnv": null,
  "privateIp": "172.18.102.103",
  "healthPath": "/health",
  "instanceId": "i-2zejbbo2svjieb44tqy8",
  "concurrency": 1,
  "eciFallback": null,
  "idleSeconds": 60,
  "capabilities": [
    "document"
  ],
  "queueSeconds": 3600,
  "resourceClass": "cpu",
  "startupSeconds": 600
}$seed$::jsonb, 2);

INSERT INTO public.runtime_configuration ("values", "revision", "singleton", "updated_by")
VALUES ($seed${
  "deployment.drainTimeoutMs": 600000
}$seed$::jsonb, 2, true, NULL);

INSERT INTO public.ai_template_scenes ("draft", "scene_key", "draft_revision", "published_revision")
VALUES ($seed${
  "items": [
    {
      "icon": "📚",
      "kind": "template",
      "title": "智能纲要",
      "prompt": "先判断原文主要属于灵感、复盘、客户沟通、会议、访谈、学习或创作中的哪一类，按该类材料最合适的结构整理总览和要点。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。",
      "enabled": true,
      "itemKey": "smart_outline",
      "parentKey": null,
      "description": "自动匹配纲要"
    },
    {
      "icon": "💡",
      "kind": "template",
      "title": "灵感记录",
      "prompt": "提炼触发灵感的材料、核心想法、疑问和可以验证的下一步。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。",
      "enabled": true,
      "itemKey": "inspiration",
      "parentKey": null,
      "description": "记想法与疑问"
    },
    {
      "icon": "📝",
      "kind": "template",
      "title": "个人自述",
      "prompt": "按叙事顺序梳理人物经历、转折、表达出的感受和回顾。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。",
      "enabled": true,
      "itemKey": "personal_account",
      "parentKey": null,
      "description": "讲经历与感受"
    },
    {
      "icon": "📒",
      "kind": "template",
      "title": "个人复盘",
      "prompt": "按目标、发生了什么、原因、经验和后续行动组织内容。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。",
      "enabled": true,
      "itemKey": "personal_review",
      "parentKey": null,
      "description": "找原因与对策"
    },
    {
      "icon": "💼",
      "kind": "template",
      "title": "客户沟通",
      "prompt": "整理客户背景、明确需求、限制、讨论过的方案、双方共识和待确认事项。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。",
      "enabled": true,
      "itemKey": "customer_communication",
      "parentKey": null,
      "description": "理需求、定方案"
    },
    {
      "icon": "👩🏻‍💻",
      "kind": "template",
      "title": "工作会议",
      "prompt": "整理会议主题、讨论要点、决议和行动项，保留原文明确的负责人和截止时间。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。",
      "enabled": true,
      "itemKey": "work_meeting",
      "parentKey": null,
      "description": "记决定与分工"
    },
    {
      "icon": "👥",
      "kind": "template",
      "title": "人物访谈",
      "prompt": "整理受访者、话题、主要故事与可直接引用的原话，分清原话与概述。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。",
      "enabled": true,
      "itemKey": "interview",
      "parentKey": null,
      "description": "留故事与原话"
    },
    {
      "icon": "👩🏻‍🎓",
      "kind": "template",
      "title": "课程学习",
      "prompt": "整理课程主题、核心概念、例子、可复用的方法和原文提出的问题。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。",
      "enabled": true,
      "itemKey": "course_learning",
      "parentKey": null,
      "description": "抓重点、学方法"
    },
    {
      "icon": "🎤",
      "kind": "template",
      "title": "口述创作",
      "prompt": "梳理口述的中心观点及说理顺序，保留可复用的素材、例子和关键表达。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。",
      "enabled": true,
      "itemKey": "oral_creation",
      "parentKey": null,
      "description": "把口述理成稿"
    }
  ],
  "title": "切换模版",
  "displayLimit": 9
}$seed$::jsonb, 'content_asset_outline', 1, 1);

INSERT INTO public.ai_template_scenes ("draft", "scene_key", "draft_revision", "published_revision")
VALUES ($seed${
  "items": [
    {
      "icon": "",
      "kind": "group",
      "title": "社会关系转变",
      "enabled": true,
      "itemKey": "relation_shift",
      "description": "",
      "displayLimit": 5
    },
    {
      "icon": "",
      "kind": "template",
      "title": "需求深化",
      "prompt": "围绕原文的受众和需求，将表述具体化，补足原文能够支持的动机、痛点和使用场景。保持原文事实，直接输出改写后的正文。",
      "enabled": true,
      "itemKey": "deepen_needs",
      "parentKey": null,
      "description": ""
    },
    {
      "icon": "",
      "kind": "template",
      "title": "差异化增强",
      "prompt": "突出原文已有的独特点、相对优势和个人表达，减少空泛套话。依据原文事实，直接输出改写后的正文。",
      "enabled": true,
      "itemKey": "strengthen_differentiation",
      "parentKey": null,
      "description": ""
    },
    {
      "icon": "",
      "kind": "template",
      "title": "开头优化",
      "prompt": "改写开头，让读者快速理解主题和价值，保持后文及原意，直接输出改写后的全文。",
      "enabled": true,
      "itemKey": "improve_opening",
      "parentKey": null,
      "description": ""
    },
    {
      "icon": "",
      "kind": "template",
      "title": "扩写",
      "prompt": "在保留原意、语言和语气的基础上，把简略段落扩展为具体、连贯的正文。只补充有原文依据的细节或清楚标注的一般性例子。直接输出扩写后的正文。",
      "enabled": true,
      "itemKey": "expand",
      "parentKey": null,
      "description": ""
    },
    {
      "icon": "",
      "kind": "template",
      "title": "平等交流",
      "prompt": "以平等、尊重的口吻和对方交流，用自然的建议表达。直接输出改写后的正文。",
      "enabled": true,
      "itemKey": "relation_peer",
      "parentKey": "relation_shift",
      "description": ""
    },
    {
      "icon": "",
      "kind": "template",
      "title": "朋友分享",
      "prompt": "用朋友间分享经验的亲切、自然语气，保留信息和原意。直接输出改写后的正文。",
      "enabled": true,
      "itemKey": "relation_friend",
      "parentKey": "relation_shift",
      "description": ""
    },
    {
      "icon": "",
      "kind": "template",
      "title": "顾问建议",
      "prompt": "用顾问的清晰、审慎语气给出基于原文的判断、理由和可执行建议。直接输出改写后的正文。",
      "enabled": true,
      "itemKey": "relation_advisor",
      "parentKey": "relation_shift",
      "description": ""
    },
    {
      "icon": "",
      "kind": "template",
      "title": "导师引导",
      "prompt": "用循序渐进的导师语气说明方法、提出引导性问题，保留原文观点。直接输出改写后的正文。",
      "enabled": true,
      "itemKey": "relation_mentor",
      "parentKey": "relation_shift",
      "description": ""
    },
    {
      "icon": "",
      "kind": "template",
      "title": "客户对话",
      "prompt": "以面向客户的专业语气组织表达，突出对方需要知道的信息和清晰下一步。直接输出改写后的正文。",
      "enabled": true,
      "itemKey": "relation_customer",
      "parentKey": "relation_shift",
      "description": ""
    }
  ],
  "title": "AI 润色",
  "displayLimit": 5
}$seed$::jsonb, 'editor_polish', 1, 1);

INSERT INTO public.ai_template_versions (scene_key, revision, catalog)
SELECT scene_key, published_revision, draft FROM public.ai_template_scenes;
