#!/bin/sh
# Local first-empty-volume bootstrap only; NOT a production migration/password rotation.
# Credentials are read through psql \getenv, never interpolated as raw SQL identifiers.
set -eu
: "${POSTGRES_USER:?Missing bootstrap user}"
: "${POSTGRES_DB:?Missing database}"
: "${POSTGRES_MIGRATOR_PASSWORD:?Missing migrator password}"
: "${POSTGRES_API_PASSWORD:?Missing API role password}"
: "${POSTGRES_ADMIN_PASSWORD:?Missing admin role password}"
: "${POSTGRES_WORKER_PASSWORD:?Missing worker role password}"
: "${POSTGRES_SCHEDULER_PASSWORD:?Missing scheduler role password}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv db_name POSTGRES_DB
\getenv migrator_password POSTGRES_MIGRATOR_PASSWORD
\getenv api_password POSTGRES_API_PASSWORD
\getenv admin_password POSTGRES_ADMIN_PASSWORD
\getenv worker_password POSTGRES_WORKER_PASSWORD
\getenv scheduler_password POSTGRES_SCHEDULER_PASSWORD

SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', 'huahuo_migrator', :'migrator_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'huahuo_migrator') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', 'huahuo_api', :'api_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'huahuo_api') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', 'huahuo_admin', :'admin_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'huahuo_admin') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', 'huahuo_worker', :'worker_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'huahuo_worker') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', 'huahuo_scheduler', :'scheduler_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'huahuo_scheduler') \gexec

SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', :'db_name') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO huahuo_migrator, huahuo_api, huahuo_admin, huahuo_worker, huahuo_scheduler', :'db_name') \gexec
SELECT format('GRANT CREATE ON DATABASE %I TO huahuo_migrator', :'db_name') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO huahuo_migrator;
GRANT USAGE ON SCHEMA public TO huahuo_api, huahuo_admin, huahuo_worker, huahuo_scheduler;
-- Business table/sequence grants belong in each migration, by role.
-- Do NOT grant every table/column to every runtime role as a shortcut.
SQL
