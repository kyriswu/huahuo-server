import { resolve } from 'node:path';
import type pg from 'pg';
import type { AppConfig } from '../config/config.js';
import { poolFor } from '../plugins/dependencies.js';
import { loadMigrationFiles, pendingMigrations, type MigrationHistory } from './migration-files.js';
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
export class MigrationExecutionError extends Error {
  readonly applied: number[];
  constructor(readonly code: string, readonly failedVersion: number, applied: readonly number[], cause: unknown) {
    super(code, { cause }); this.name = 'MigrationExecutionError'; this.applied = [...applied];
  }
}
async function assertNoPhysicalForeignKeys(client: pg.PoolClient, code: string): Promise<void> {
  const result = await client.query<{ present: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE c.contype='f' AND n.nspname NOT LIKE 'pg_%'
      AND n.nspname<>'information_schema') AS present`);
  if (result.rows[0]?.present) throw new Error(code);
}
async function readHistory(client: pg.PoolClient): Promise<{ exists: boolean; rows: MigrationHistory[] }> {
  const found = await client.query<{ name: string | null }>("SELECT to_regclass('public.schema_migrations')::text AS name");
  if (!found.rows[0]?.name) return { exists: false, rows: [] };
  return { exists: true, rows: (await client.query<MigrationHistory>('SELECT version,checksum FROM public.schema_migrations ORDER BY version')).rows };
}
async function waitForDatabase(pool: pg.Pool, config: AppConfig) {
  const deadline = Date.now() + config.connectDeadlineMs;
  while (true) {
    try { await pool.query('SELECT 1'); return; }
    catch { if (Date.now() >= deadline) throw new Error('DATABASE_CONNECT_DEADLINE'); await pause(500); }
  }
}
export async function preflightMigrations(config: AppConfig, directory = resolve('migrations')) {
  const files = loadMigrationFiles(directory);
  const pool = poolFor(config); pool.on('error', () => undefined);
  try {
    await waitForDatabase(pool, config);
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const history = await readHistory(client);
      const pending = pendingMigrations(files, history.rows);
      await assertNoPhysicalForeignKeys(client, 'DATABASE_FOREIGN_KEYS_FORBIDDEN');
      await client.query('COMMIT');
      return { applied: history.rows.map(row => row.version), pending: pending.map(file => file.version),
        current: history.rows.at(-1)?.version ?? 0, target: files.at(-1)!.version };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } finally { await pool.end(); }
}
export async function migrate(config: AppConfig, directory = resolve('migrations')) {
  const files = loadMigrationFiles(directory);
  const pool = poolFor(config); pool.on('error', () => undefined);
  try {
    await waitForDatabase(pool, config);
    const client = await pool.connect();
    let locked = false;
    try {
      const lockDeadline = Date.now() + config.migrationLockTimeoutMs;
      while (!locked) {
        const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(72701, 1) AS locked');
        locked = result.rows[0]?.locked === true;
        if (!locked) { if (Date.now() >= lockDeadline) throw new Error('MIGRATION_LOCK_TIMEOUT'); await pause(100); }
      }
      const history = await readHistory(client);
      const pending = pendingMigrations(files, history.rows);
      await assertNoPhysicalForeignKeys(client, 'DATABASE_FOREIGN_KEYS_FORBIDDEN');
      // No DDL precedes validation of every historical checksum and version.
      if (!history.exists) await client.query(`CREATE TABLE public.schema_migrations (
        version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
      const applied: number[] = [];
      for (const { version, sql, checksum } of pending) {
        await client.query('BEGIN');
        try {
          await client.query("SELECT set_config('lock_timeout',$1,true)", [`${config.migrationLockTimeoutMs}ms`]);
          await client.query(sql);
          await assertNoPhysicalForeignKeys(client, 'MIGRATION_FOREIGN_KEYS_FORBIDDEN');
          await client.query('INSERT INTO public.schema_migrations(version,checksum) VALUES ($1,$2)', [version, checksum]);
          await client.query('COMMIT'); applied.push(version);
        } catch (error) {
          await client.query('ROLLBACK');
          const code = error instanceof Error && error.message === 'MIGRATION_FOREIGN_KEYS_FORBIDDEN'
            ? 'MIGRATION_FOREIGN_KEYS_FORBIDDEN' : 'MIGRATION_SQL_FAILED';
          throw new MigrationExecutionError(code, version, applied, error);
        }
      }
      await assertNoPhysicalForeignKeys(client, 'DATABASE_FOREIGN_KEYS_FORBIDDEN');
      return { applied, current: files.at(-1)!.version };
    } finally {
      try { if (locked) await client.query('SELECT pg_advisory_unlock(72701, 1)'); }
      finally { client.release(); }
    }
  } finally { await pool.end(); }
}
