CREATE TABLE storage_reservations (
 reservation_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_users(id), resource_key text NOT NULL,
 requested_bytes bigint NOT NULL CHECK(requested_bytes > 0), confirmed_bytes bigint NOT NULL DEFAULT 0 CHECK(confirmed_bytes >= 0),
 status text NOT NULL CHECK(status IN ('reserved','confirmed','released','expired')),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,resource_key), CHECK(confirmed_bytes <= requested_bytes)
);
GRANT SELECT,INSERT,UPDATE ON storage_reservations TO huahuo_api,huahuo_worker;
GRANT SELECT ON storage_reservations TO huahuo_admin,huahuo_scheduler;
