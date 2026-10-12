CREATE TABLE billing_policies (
 policy_version text PRIMARY KEY,
 mode text NOT NULL CHECK(mode IN ('development','live','disabled')),
 monthly_credit_limit bigint NOT NULL CHECK(monthly_credit_limit >= 0),
 currency char(3) NOT NULL DEFAULT 'USD',
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO billing_policies(policy_version,mode,monthly_credit_limit,currency)
 VALUES('credit-policy-v1','development',10000000,'USD') ON CONFLICT DO NOTHING;

CREATE TABLE usage_periods (
 user_id uuid NOT NULL REFERENCES app_users(id), period_start date NOT NULL, period_end date NOT NULL,
 credit_limit bigint NOT NULL CHECK(credit_limit >= 0), settled_credits bigint NOT NULL DEFAULT 0 CHECK(settled_credits >= 0),
 reserved_credits bigint NOT NULL DEFAULT 0 CHECK(reserved_credits >= 0), uncovered_credits bigint NOT NULL DEFAULT 0 CHECK(uncovered_credits >= 0),
 PRIMARY KEY(user_id,period_start)
);
CREATE TABLE account_memberships (
 membership_id uuid PRIMARY KEY, user_id uuid NOT NULL UNIQUE REFERENCES app_users(id),
 level_code text NOT NULL CHECK(level_code IN ('free','pilot_paid','pro','max')),
 status text NOT NULL CHECK(status IN ('pending','active','grace_period','cancelled','expired','refunded','revoked')),
 policy_version text NOT NULL REFERENCES billing_policies(policy_version), source text NOT NULL,
 expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE credit_lots (
 lot_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_users(id),
 lot_kind text NOT NULL CHECK(lot_kind IN ('monthly','permanent')), policy_version text NOT NULL REFERENCES billing_policies(policy_version),
 period_start date, period_end date, expires_at timestamptz,
 granted_credits bigint NOT NULL CHECK(granted_credits >= 0), available_credits bigint NOT NULL CHECK(available_credits >= 0),
 reserved_credits bigint NOT NULL DEFAULT 0 CHECK(reserved_credits >= 0), settled_credits bigint NOT NULL DEFAULT 0 CHECK(settled_credits >= 0),
 source text NOT NULL, grant_key text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((lot_kind='monthly' AND period_start IS NOT NULL AND period_end IS NOT NULL) OR (lot_kind='permanent' AND period_start IS NULL AND period_end IS NULL))
);
CREATE INDEX credit_lots_user_active ON credit_lots(user_id,lot_kind,expires_at);
CREATE TABLE credit_reservations (
 reservation_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_users(id), task_id uuid REFERENCES tasks(id), run_id uuid,
 reservation_key text NOT NULL, policy_version text NOT NULL REFERENCES billing_policies(policy_version),
 requested_credits bigint NOT NULL CHECK(requested_credits > 0), reserved_credits bigint NOT NULL CHECK(reserved_credits >= 0),
 status text NOT NULL CHECK(status IN ('reserved','committed','released','pending','uncovered')),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,reservation_key)
);
CREATE TABLE credit_reservation_lots (
 reservation_id uuid NOT NULL REFERENCES credit_reservations(reservation_id), lot_id uuid NOT NULL REFERENCES credit_lots(lot_id),
 credits bigint NOT NULL CHECK(credits > 0), PRIMARY KEY(reservation_id,lot_id)
);
CREATE TABLE credit_ledger_entries (
 entry_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_users(id), reservation_id uuid REFERENCES credit_reservations(reservation_id), lot_id uuid REFERENCES credit_lots(lot_id),
 entry_type text NOT NULL CHECK(entry_type IN ('grant','reserve','commit','release','adjustment','uncovered')), credits bigint NOT NULL, currency char(3), minor_amount bigint,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tasks ADD COLUMN reservation_id uuid REFERENCES credit_reservations(reservation_id);
CREATE UNIQUE INDEX tasks_reservation_unique ON tasks(reservation_id) WHERE reservation_id IS NOT NULL;

CREATE TABLE provider_usage_measurements (
 measurement_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_users(id), run_id uuid, reservation_id uuid REFERENCES credit_reservations(reservation_id),
 usage_kind text NOT NULL, provider text, measurement_status text NOT NULL CHECK(measurement_status IN ('measured','fallback','zero_cost','unavailable','pending','uncovered')),
 raw_input_tokens bigint NOT NULL DEFAULT 0 CHECK(raw_input_tokens >= 0), raw_output_tokens bigint NOT NULL DEFAULT 0 CHECK(raw_output_tokens >= 0),
 media_quantity bigint NOT NULL DEFAULT 0 CHECK(media_quantity >= 0), media_duration_seconds bigint NOT NULL DEFAULT 0 CHECK(media_duration_seconds >= 0),
 accounted_credits bigint NOT NULL DEFAULT 0 CHECK(accounted_credits >= 0), uncovered_credits bigint NOT NULL DEFAULT 0 CHECK(uncovered_credits >= 0),
 provider_cost_minor bigint, provider_currency char(3), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE run_usage (
 run_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_users(id), task_id uuid REFERENCES tasks(id), reservation_id uuid REFERENCES credit_reservations(reservation_id),
 policy_version text NOT NULL REFERENCES billing_policies(policy_version), raw_input_tokens bigint NOT NULL DEFAULT 0, raw_output_tokens bigint NOT NULL DEFAULT 0,
 accounted_credits bigint NOT NULL DEFAULT 0, uncovered_credits bigint NOT NULL DEFAULT 0,
 settlement_status text NOT NULL CHECK(settlement_status IN ('pending','settled','uncovered')), assistant_result_persisted boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT,INSERT,UPDATE ON billing_policies,usage_periods,account_memberships,credit_lots,credit_reservations,credit_reservation_lots,credit_ledger_entries,provider_usage_measurements,run_usage,tasks TO huahuo_api;
GRANT SELECT ON billing_policies,usage_periods,account_memberships,credit_lots,credit_reservations,credit_reservation_lots,credit_ledger_entries,provider_usage_measurements,run_usage,tasks TO huahuo_worker;
GRANT SELECT,INSERT,UPDATE ON usage_periods,account_memberships,credit_lots,credit_reservations,credit_reservation_lots,credit_ledger_entries,provider_usage_measurements,run_usage,tasks TO huahuo_worker;
GRANT SELECT ON billing_policies,usage_periods,account_memberships,credit_lots,credit_reservations,credit_reservation_lots,credit_ledger_entries,provider_usage_measurements,run_usage TO huahuo_admin;
GRANT SELECT ON billing_policies,usage_periods,account_memberships,credit_lots,credit_reservations,credit_reservation_lots,credit_ledger_entries,provider_usage_measurements,run_usage TO huahuo_scheduler;
