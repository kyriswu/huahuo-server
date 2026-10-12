-- P01 has no business tables. Runtime roles can only read schema metadata.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO huahuo_api, huahuo_admin, huahuo_worker, huahuo_scheduler;
GRANT SELECT ON schema_migrations TO huahuo_api, huahuo_admin, huahuo_worker, huahuo_scheduler;
COMMENT ON TABLE schema_migrations IS 'Reviewed SQL migrations; runtime roles have SELECT only';
