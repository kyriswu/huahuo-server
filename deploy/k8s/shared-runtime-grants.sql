-- Run as huahuo_migrator after the reviewed migrations on the target database.
-- The database owner provisions public schema USAGE for huahuo_normal first.
DO $shared_runtime_grants$
DECLARE
    migrator_oid CONSTANT oid := 'huahuo_migrator'::regrole;
    runtime_oid CONSTANT oid := 'huahuo_normal'::regrole;
    migration_grantees CONSTANT oid[] := ARRAY[
        'huahuo_api'::regrole::oid,
        'huahuo_admin'::regrole::oid,
        'huahuo_worker'::regrole::oid,
        'huahuo_scheduler'::regrole::oid
    ];
    grant_entry record;
BEGIN
    IF current_user <> 'huahuo_migrator' THEN
        RAISE EXCEPTION 'Shared runtime grants require huahuo_migrator';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE oid = runtime_oid AND rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
          AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
    ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = runtime_oid
    ) OR NOT pg_catalog.has_schema_privilege(runtime_oid, 'public', 'USAGE')
      OR pg_catalog.has_schema_privilege(runtime_oid, 'public', 'CREATE, USAGE WITH GRANT OPTION') THEN
        RAISE EXCEPTION 'Shared runtime requires an ordinary login with public USAGE';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class
        WHERE oid = pg_catalog.to_regclass('public.schema_migrations')
          AND relowner = migrator_oid AND relkind = 'r'
    ) THEN
        RAISE EXCEPTION 'Expected a migrator-owned migration history table';
    END IF;

    FOR grant_entry IN
        WITH relations AS (
            SELECT relation.oid, relation.relname, relation.relkind, relation.relacl
            FROM pg_catalog.pg_class AS relation
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public' AND relation.relowner = migrator_oid
              AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        ), object_grants AS (
            SELECT relation.relname, relation.relkind, NULL::name AS column_name, entry.*
            FROM relations AS relation
            CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS entry
            UNION ALL
            SELECT relation.relname, relation.relkind, attribute.attname, entry.*
            FROM relations AS relation
            JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
            CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS entry
            WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
        )
        SELECT relname, relkind, column_name, privilege_type,
            bool_or(grantor = migrator_oid AND grantee = ANY (migration_grantees)) AS permitted,
            bool_or(grantee = runtime_oid) AS already_granted,
            bool_or(grantee = 0 OR (grantee = runtime_oid AND is_grantable)) AS unsafe
        FROM object_grants
        WHERE grantee IN (0, runtime_oid) OR (grantor = migrator_oid AND grantee = ANY (migration_grantees))
        GROUP BY relname, relkind, column_name, privilege_type
    LOOP
        IF grant_entry.unsafe OR (
            grant_entry.relname = 'schema_migrations' AND grant_entry.already_granted
            AND (grant_entry.privilege_type <> 'SELECT' OR grant_entry.column_name IS NOT NULL)
        ) THEN
            RAISE EXCEPTION 'Unexpected ACL on public.%', grant_entry.relname;
        END IF;

        IF grant_entry.relname = 'schema_migrations' THEN
            CONTINUE;
        END IF;

        IF NOT grant_entry.permitted THEN
            RAISE EXCEPTION 'Runtime privilege exceeds the migration ACL on public.%', grant_entry.relname;
        ELSIF grant_entry.relkind = 'S' AND grant_entry.privilege_type = 'USAGE' THEN
            EXECUTE pg_catalog.format('GRANT USAGE ON SEQUENCE public.%I TO huahuo_normal', grant_entry.relname);
        ELSIF grant_entry.relkind <> 'S' AND grant_entry.column_name IS NULL
              AND grant_entry.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE') THEN
            EXECUTE pg_catalog.format('GRANT %s ON TABLE public.%I TO huahuo_normal',
                grant_entry.privilege_type, grant_entry.relname);
        ELSIF grant_entry.relkind <> 'S' AND grant_entry.column_name IS NOT NULL
              AND grant_entry.privilege_type IN ('SELECT', 'INSERT', 'UPDATE') THEN
            EXECUTE pg_catalog.format('GRANT %s (%I) ON TABLE public.%I TO huahuo_normal',
                grant_entry.privilege_type, grant_entry.column_name, grant_entry.relname);
        ELSE
            RAISE EXCEPTION 'Unsupported migration privilege % on public.%',
                grant_entry.privilege_type, grant_entry.relname;
        END IF;
    END LOOP;

    GRANT SELECT ON TABLE public.schema_migrations TO huahuo_normal;
END;
$shared_runtime_grants$;
