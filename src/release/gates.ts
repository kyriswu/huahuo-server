import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type pg from 'pg';
import { loadConfig, type AppConfig, type Env, type Role } from '../config/config.js';
import { preflightMigrations } from '../db/migrate.js';
import { createDependencies, isReady, poolFor } from '../plugins/dependencies.js';
import { RuntimeSettings } from '../modules/runtime-settings/service.js';
import type { ReleasePlan } from './plan.js';

const execute = promisify(execFile);
const fail = (code: string): never => { throw new Error(code); };

export function checkReleaseConfiguration(plan: ReleasePlan, role: Role, env: Env = process.env): AppConfig {
  if (!Object.values(plan.compatibility).every(value => value === true)) fail('RELEASE_PLAN_INCOMPATIBLE');
  const config = loadConfig(role, env);
  if (config.appEnv === 'production' && plan.smoke !== 'authenticated') fail('RELEASE_AUTHENTICATED_SMOKE_REQUIRED');
  for (const change of plan.configuration.changes) {
    if (change.roles.includes(role) && change.operation !== 'remove' && change.required && !change.hasDefault && !env[change.key]?.trim()) {
      fail('RELEASE_CONFIGURATION_MISSING');
    }
  }
  return config;
}

export async function checkReleaseHistory(config: AppConfig, plan: ReleasePlan, root = process.cwd()) {
  const history = await preflightMigrations(config, resolve(root, 'migrations'));
  // Initial provisioning is a separate, explicitly targeted operation. A release
  // must not silently initialize an unexpected empty database.
  if (history.current === 0) fail('RELEASE_DATABASE_NOT_INITIALIZED');
  const declared = new Set(plan.database.migrations.map(file => Number(file.slice(0, 4))));
  if (history.pending.some(version => !declared.has(version))) fail('RELEASE_UNDECLARED_MIGRATION');
  return history;
}

/** One prepared SELECT in a read-only transaction; false/empty assertions fail. */
export async function runDatabaseAssertions(config: AppConfig, sql: string): Promise<number> {
  if (!sql.trim() || Buffer.byteLength(sql) > 128 * 1024) fail('RELEASE_DB_ASSERTIONS_INVALID');
  const pool = poolFor(config); pool.on('error', () => undefined);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', '3000', true)", [String(Math.min(config.statementTimeout, 30000))]);
      // A named prepared query forces the extended protocol: PostgreSQL rejects
      // a second statement, including COMMIT followed by a write.
      const result = await client.query<{ check_name: string; ok: boolean }>({ name: 'release-assertions', text: sql });
      if (result.command !== 'SELECT' || result.rows.length < 1 || result.rows.length > 200
        || result.fields.length !== 2 || result.fields[0]?.name !== 'check_name' || result.fields[1]?.name !== 'ok'
        || result.rows.some(row => typeof row.check_name !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(row.check_name) || row.ok !== true)
        || new Set(result.rows.map(row => row.check_name)).size !== result.rows.length) fail('RELEASE_DB_ASSERTION_FAILED');
      return result.rows.length;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  } catch (error) {
    if (error instanceof Error && /^RELEASE_DB_[A-Z_]+$/.test(error.message)) throw error;
    return fail('RELEASE_DB_VERIFICATION_FAILED');
  } finally { await pool.end(); }
}

export async function verifyReleaseDatabase(config: AppConfig, plan: ReleasePlan, root = process.cwd()) {
  const history = await checkReleaseHistory(config, plan, root);
  if (history.pending.length) fail('RELEASE_MIGRATIONS_PENDING');
  let assertionCount = await runDatabaseAssertions(config, `SELECT 'no_physical_foreign_keys' AS check_name,
    NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE c.contype='f' AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema') AS ok`);
  if (plan.database.verifySql) assertionCount += await runDatabaseAssertions(config, await readFile(resolve(root, plan.database.verifySql), 'utf8'));
  return { assertionCount, current: history.current };
}

export async function checkReleaseRuntime(config: AppConfig, root = process.cwd()) {
  if (config.role === 'migrate') fail('RELEASE_RUNTIME_ROLE_REQUIRED');
  const dependencies = createDependencies(config, resolve(root, 'migrations'));
  try {
    let ready = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (isReady(await dependencies.check())) { ready = true; break; }
      await new Promise(done => setTimeout(done, 250));
    }
    if (!ready) fail('RELEASE_RUNTIME_NOT_READY');
    await new RuntimeSettings(dependencies.pool as pg.Pool, config).load();
  } finally { await dependencies.close(); }
}

export async function checkReleaseExternal(plan: ReleasePlan, root = process.cwd()) {
  for (const checkFile of new Set(plan.dependencies.map(dependency => dependency.checkFile))) {
    try {
      // These are reviewed repository files, not URLs or commands supplied at
      // dispatch time. Output is captured and never forwarded with credentials.
      await execute(process.execPath, [resolve(root, checkFile)], { cwd: root, env: process.env,
        timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 65536 });
    } catch { fail('RELEASE_EXTERNAL_CHECK_FAILED'); }
  }
  return { checkCount: plan.dependencies.length };
}
