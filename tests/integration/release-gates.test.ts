import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/config.js';
import { migrate } from '../../src/db/migrate.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { checkReleaseHistory, runDatabaseAssertions, verifyReleaseDatabase } from '../../src/release/gates.js';
import { readReleasePlan, type ReleasePlan } from '../../src/release/plan.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL;
const apiUrl = process.env.TEST_DATABASE_API_URL;
if (!migrationUrl || !apiUrl || !/^huahuo_test_[a-z0-9_]+$/.test(new URL(migrationUrl).pathname.slice(1))
  || !['127.0.0.1', 'localhost'].includes(new URL(migrationUrl).hostname)
  || new URL(apiUrl).host !== new URL(migrationUrl).host || new URL(apiUrl).pathname !== new URL(migrationUrl).pathname) {
  throw new Error('REAL_ISOLATED_TEST_DATABASE_REQUIRED: run scripts/integration.mjs');
}
const migrator = loadConfig('migrate', { DATABASE_URL: migrationUrl, APP_ENV: 'test' });
// The database role comes from this URL. No production credentials or .env file.
const applicationRole = { ...migrator, role: 'api-server' as const, databaseUrl: apiUrl };
const pool = poolFor(migrator);
const suffix = randomBytes(8).toString('hex');
const table = `release_gate_probe_${suffix}`;
const historyBackup = `release_gate_history_${suffix}`;
let directory: string;
let plan: ReleasePlan;
async function loadFixture(): Promise<ReleasePlan> {
  await writeFile(join(directory, 'scripts/release/plan.json'), JSON.stringify(plan));
  return readReleasePlan(directory);
}

describe('release database gates on real isolated PostgreSQL', () => {
  beforeAll(async () => {
    await migrate(migrator);
    directory = await mkdtemp(join(tmpdir(), 'huahuo-release-gate-pg-'));
    await mkdir(join(directory, 'migrations'));
    await mkdir(join(directory, 'scripts/release/changes/gate-test'), { recursive: true });
    await writeFile(join(directory, 'migrations/0001_initial_schema.sql'), await readFile('migrations/0001_initial_schema.sql'));
    plan = { version: 1, id: 'gate-test', baseRevision: '1'.repeat(40), services: ['api-server', 'worker', 'scheduler', 'admin'],
      database: { migrations: [], verifySql: null, dataChange: { mode: 'none', reason: '' } },
      configuration: { mode: 'reuse', changes: [], reviewedFiles: [] }, dependencies: [],
      backfill: { required: false, reference: null }, compatibility: { database: true, api: true, tasks: true, configuration: true }, smoke: 'authenticated' };
    await pool.query(`CREATE TABLE public.${table}(id integer PRIMARY KEY, value integer NOT NULL)`);
    await pool.query(`INSERT INTO public.${table} VALUES(1,7)`);
    await pool.query(`GRANT SELECT ON public.${table} TO huahuo_api`);
  }, 20000);
  afterAll(async () => {
    try { await pool.query(`DROP TABLE IF EXISTS public.${table}`); }
    finally { await pool.end(); if (directory) await rm(directory, { recursive: true, force: true }); }
  });

  it('accepts named true assertions from one real SELECT', async () => {
    await expect(runDatabaseAssertions(migrator, "SELECT 'first_check' AS check_name,true AS ok UNION ALL SELECT 'second_check',true")).resolves.toBe(2);
  });
  it.each([
    ["SELECT 'false_check' AS check_name,false AS ok"],
    ["SELECT 'empty_check' AS check_name,true AS ok WHERE false"],
    ["SELECT 'null_result' AS check_name,NULL::boolean AS ok"],
    ["SELECT 'string_result' AS check_name,'true'::text AS ok"],
    ["SELECT NULL::text AS check_name,true AS ok"],
    ["SELECT true AS check_name,true AS ok"],
    ["SELECT 'duplicate' AS check_name,true AS ok UNION ALL SELECT 'duplicate',true"],
    ["SELECT 'wrong_columns' AS name,true AS ok"],
    ["SELECT 'extra_column' AS check_name,true AS ok,1 AS extra"],
    ["SELECT 'check_'||n AS check_name,true AS ok FROM generate_series(1,201) n"],
  ])('rejects false, empty or invalid assertion results: %s', async sql => {
    await expect(runDatabaseAssertions(migrator, sql)).rejects.toThrow('RELEASE_DB_ASSERTION_FAILED');
  });
  it('rejects writes even when using the migration account and leaves fixture data intact', async () => {
    await expect(runDatabaseAssertions(migrator, `UPDATE public.${table} SET value=99 RETURNING 'write' AS check_name,true AS ok`)).rejects.toThrow('RELEASE_DB_VERIFICATION_FAILED');
    expect((await pool.query(`SELECT value FROM public.${table} WHERE id=1`)).rows[0]?.value).toBe(7);
  });
  it('rejects COMMIT followed by UPDATE as one prepared query, preventing a read-only escape', async () => {
    await expect(runDatabaseAssertions(migrator, `COMMIT; UPDATE public.${table} SET value=99; SELECT 'escaped' AS check_name,true AS ok`)).rejects.toThrow('RELEASE_DB_VERIFICATION_FAILED');
    expect((await pool.query(`SELECT value FROM public.${table} WHERE id=1`)).rows[0]?.value).toBe(7);
  });
  it('bounds a slow assertion with PostgreSQL statement_timeout and still accepts the next query', async () => {
    const started = Date.now();
    await expect(runDatabaseAssertions({ ...migrator, statementTimeout: 100 }, "SELECT 'slow' AS check_name,true AS ok FROM pg_sleep(2)")).rejects.toThrow('RELEASE_DB_VERIFICATION_FAILED');
    expect(Date.now() - started).toBeLessThan(3000);
    await expect(runDatabaseAssertions(migrator, "SELECT 'after_timeout' AS check_name,true AS ok")).resolves.toBe(1);
  });
  it('detects missing application-role permissions instead of relying on a privileged migration account', async () => {
    const sql = `SELECT 'fixture_read' AS check_name,count(*)=1 AS ok FROM public.${table}`;
    await expect(runDatabaseAssertions(migrator, sql)).resolves.toBe(1);
    await expect(runDatabaseAssertions(applicationRole, sql)).resolves.toBe(1);
    await pool.query(`REVOKE SELECT ON public.${table} FROM huahuo_api`);
    try {
      await expect(runDatabaseAssertions(migrator, sql)).resolves.toBe(1);
      await expect(runDatabaseAssertions(applicationRole, sql)).rejects.toThrow('RELEASE_DB_VERIFICATION_FAILED');
    } finally { await pool.query(`GRANT SELECT ON public.${table} TO huahuo_api`); }
  });
  it('does not initialize or recreate migration history when the target has no history table', async () => {
    // This fixture hides only the isolated test DB history, then restores the
    // same table and grants. It never deletes history or any business rows.
    await pool.query(`ALTER TABLE public.schema_migrations RENAME TO ${historyBackup}`);
    try {
      await expect(checkReleaseHistory(migrator, await loadFixture(), directory)).rejects.toThrow('RELEASE_DATABASE_NOT_INITIALIZED');
      expect((await pool.query("SELECT to_regclass('public.schema_migrations')::text AS name")).rows[0]?.name).toBeNull();
    } finally { await pool.query(`ALTER TABLE public.${historyBackup} RENAME TO schema_migrations`); }
    expect((await pool.query('SELECT version FROM public.schema_migrations ORDER BY version')).rows).toEqual([{ version: 1 }]);
  });
  it('blocks undeclared pending migrations and post-migration verification until they are applied', async () => {
    const path = join(directory, 'migrations/0002_pending.sql');
    await writeFile(path, `CREATE TABLE release_gate_never_created_${suffix}(id integer);`);
    try {
      await expect(checkReleaseHistory(migrator, await loadFixture(), directory)).rejects.toThrow('RELEASE_UNDECLARED_MIGRATION');
      plan.database.migrations = ['0002_pending.sql'];
      await expect(checkReleaseHistory(migrator, await loadFixture(), directory)).resolves.toMatchObject({ applied: [1], pending: [2], current: 1, target: 2 });
      await expect(verifyReleaseDatabase(migrator, await loadFixture(), directory)).rejects.toThrow('RELEASE_MIGRATIONS_PENDING');
      expect((await pool.query("SELECT to_regclass($1)::text AS name", [`public.release_gate_never_created_${suffix}`])).rows[0]?.name).toBeNull();
      expect((await pool.query('SELECT version FROM public.schema_migrations ORDER BY version')).rows).toEqual([{ version: 1 }]);
    } finally { plan.database.migrations = []; await rm(path); }
  });
  it('runs the fixed zero-foreign-key assertion and the declared SQL with the actual application account', async () => {
    plan.database.verifySql = 'scripts/release/changes/gate-test/verify-db.sql';
    await writeFile(join(directory, plan.database.verifySql), `SELECT 'fixture_read' AS check_name,count(*)=1 AS ok FROM public.${table}`);
    try { await expect(verifyReleaseDatabase(applicationRole, await loadFixture(), directory)).resolves.toEqual({ assertionCount: 2, current: 1 }); }
    finally { plan.database.verifySql = null; }
  });
});
