import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/config.js';
import { loadMigrationFiles } from '../../src/db/migration-files.js';
import { migrate, preflightMigrations } from '../../src/db/migrate.js';
import { createDependencies, poolFor } from '../../src/plugins/dependencies.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL;
if (!migrationUrl || !/^huahuo_test_[a-z0-9_]+$/.test(new URL(migrationUrl).pathname.slice(1))) throw new Error('REAL_ISOLATED_TEST_DATABASE_REQUIRED');
const config = loadConfig('migrate', { DATABASE_URL: migrationUrl });
const pool = poolFor(config);
const packaged = loadMigrationFiles();
const current = packaged.at(-1)!.version, next = current + 1;
const name = (version: number) => `${String(version).padStart(4, '0')}_upgrade_probe.sql`;
const probe = () => `migration_probe_${randomUUID().replaceAll('-', '')}`;
async function fixture(sql: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'huahuo-upgrade-'));
  for (const file of packaged) await writeFile(join(directory, file.name), file.sql);
  for (const [index, content] of sql.entries()) await writeFile(join(directory, name(next + index)), content);
  return directory;
}
async function history() { return (await pool.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version')).rows; }
async function exists(table: string) { return (await pool.query('SELECT to_regclass($1)::text AS name', [`public.${table}`])).rows[0].name !== null; }
async function cleanup(directory: string, tables: string[]) {
  // Only remove versions whose exact checksums belong to this fixture.
  for (const file of loadMigrationFiles(directory).filter(file => file.version > current)) {
    await pool.query('DELETE FROM schema_migrations WHERE version=$1 AND checksum=$2', [file.version, file.checksum]);
  }
  for (const table of tables) await pool.query(`DROP TABLE IF EXISTS ${table}`);
  await rm(directory, { recursive: true, force: true });
}
beforeAll(() => migrate(config), 20000);
afterAll(() => pool.end());

describe('append-only upgrades with real isolated PostgreSQL', () => {
  it('initializes the required task trace once and rejects missing or invalid traces on new rows',async()=>{
    const table=probe(),client=await pool.connect(),migration=packaged.find(file=>file.name==='0005_task_trace_id.sql');
    if(!migration)throw Error('TRACE_MIGRATION_MISSING');
    await client.query('BEGIN');
    try{
      await client.query(`CREATE TABLE public.${table}(id uuid PRIMARY KEY); INSERT INTO public.${table} VALUES(gen_random_uuid()),(gen_random_uuid());`);
      await client.query(migration.sql.replaceAll('public.tasks',`public.${table}`));
      const rows=(await client.query(`SELECT trace_id FROM public.${table}`)).rows;
      expect(rows).toHaveLength(2);expect(new Set(rows.map(row=>row.trace_id)).size).toBe(2);
      for(const row of rows)expect(row.trace_id).toMatch(/^[a-f0-9-]{36}$/);
      await client.query('SAVEPOINT required_trace');
      await expect(client.query(`INSERT INTO public.${table}(id) VALUES(gen_random_uuid())`)).rejects.toMatchObject({code:'23502'});
      await client.query('ROLLBACK TO SAVEPOINT required_trace');
      await expect(client.query(`INSERT INTO public.${table}(id,trace_id) VALUES(gen_random_uuid(),'bad')`)).rejects.toMatchObject({code:'23514'});
      await client.query('ROLLBACK TO SAVEPOINT required_trace');
      await client.query(`INSERT INTO public.${table}(id,trace_id) VALUES(gen_random_uuid(),'current-trace')`);
      expect(Number((await client.query(`SELECT count(*) AS n FROM public.${table}`)).rows[0].n)).toBe(3);
    }finally{await client.query('ROLLBACK');client.release();}
  });
  it('preflights pending SQL with a SELECT-only migration-history role without applying any change', async () => {
    const table = probe(), directory = await fixture([`CREATE TABLE ${table}(id int PRIMARY KEY);`]);
    const before = await history();
    try {
      const result = await preflightMigrations({ ...config, databaseUrl: process.env.TEST_DATABASE_API_URL! }, directory);
      expect(result).toEqual({ applied: packaged.map(file => file.version), pending: [next], current, target: next });
      expect(await history()).toEqual(before); expect(await exists(table)).toBe(false);
    } finally { await cleanup(directory, [table]); }
  });

  it('rejects a file that would commit pending DDL outside the runner transaction', async () => {
    const table = probe(), directory = await fixture([`CREATE TABLE ${table}(id int); COMMIT; SELECT 1/0;`]);
    const before = await history();
    try {
      await expect(migrate(config, directory)).rejects.toThrow('MIGRATION_TRANSACTION_CONTROL');
      expect(await exists(table)).toBe(false); expect(await history()).toEqual(before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps an older image ready after an additive upgrade while the new image requires its own checksum', async () => {
    const table = probe(), directory = await fixture([`CREATE TABLE ${table}(id int PRIMARY KEY, label text NOT NULL DEFAULT 'default');
      GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO huahuo_api;`]);
    const runtime = { ...config, role: 'worker' as const, databaseUrl: process.env.TEST_DATABASE_WORKER_URL!,
      redisCacheUrl: process.env.REDIS_CACHE_URL!, redisQueueUrl: process.env.REDIS_QUEUE_URL! };
    const oldImage = createDependencies(runtime), newImage = createDependencies(runtime, directory);
    const api = poolFor({ ...config, databaseUrl: process.env.TEST_DATABASE_API_URL! });
    const checksum = loadMigrationFiles(directory).at(-1)!.checksum;
    try {
      expect((await oldImage.check()).schema).toBe(true); expect((await newImage.check()).schema).toBe(false);
      expect(await migrate(config, directory)).toEqual({ applied: [next], current: next });
      expect((await oldImage.check()).schema).toBe(true); expect((await newImage.check()).schema).toBe(true);
      await api.query(`INSERT INTO ${table}(id) VALUES(1)`);
      await api.query(`UPDATE ${table} SET label='updated' WHERE id=1`);
      expect((await api.query(`SELECT label FROM ${table} WHERE id=1`)).rows).toEqual([{ label: 'updated' }]);
      await api.query(`DELETE FROM ${table} WHERE id=1`);
      // Readiness is intentionally more permissive than invoking an old migrator.
      await expect(preflightMigrations(config)).rejects.toThrow('MIGRATION_HISTORY_UNKNOWN');
      await pool.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2', ['0'.repeat(64), next]);
      expect((await oldImage.check()).schema).toBe(true); expect((await newImage.check()).schema).toBe(false);
      await expect(preflightMigrations(config, directory)).rejects.toThrow('MIGRATION_CHECKSUM_MISMATCH');
    } finally {
      await pool.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2 AND checksum=$3', [checksum, next, '0'.repeat(64)]);
      await Promise.all([oldImage.close(), newImage.close(), api.end()]); await cleanup(directory, [table]);
    }
  });

  it('retains already committed files, rolls back the failing file, and retries only the pending suffix', async () => {
    const first = probe(), second = probe();
    const directory = await fixture([
      `CREATE TABLE ${first}(id int PRIMARY KEY,label text); INSERT INTO ${first} VALUES(1,'preserved');`,
      `CREATE TABLE ${second}(id int PRIMARY KEY); SELECT 1/0;`,
    ]);
    try {
      await expect(migrate(config, directory)).rejects.toMatchObject({
        message: 'MIGRATION_SQL_FAILED', code: 'MIGRATION_SQL_FAILED', failedVersion: next + 1, applied: [next],
      });
      expect(await exists(first)).toBe(true); expect(await exists(second)).toBe(false);
      expect((await history()).map(row => row.version)).toEqual([...packaged.map(file => file.version), next]);
      await writeFile(join(directory, name(next + 1)), `CREATE TABLE ${second}(id int PRIMARY KEY);`);
      expect(await migrate(config, directory)).toEqual({ applied: [next + 1], current: next + 1 });
      expect((await pool.query(`SELECT * FROM ${first}`)).rows).toEqual([{ id: 1, label: 'preserved' }]);
      expect((await migrate(config, directory)).applied).toEqual([]);
    } finally { await cleanup(directory, [first, second]); }
  });

  it.each(['gap', 'checksum', 'unknown'] as const)('rejects %s history before any pending DDL', async kind => {
    const first = probe(), second = probe();
    const directory = await fixture([`CREATE TABLE ${first}(id int);`, `CREATE TABLE ${second}(id int);`]);
    const files = loadMigrationFiles(directory);
    const version = kind === 'gap' ? next + 1 : next;
    const checksum = kind === 'checksum' ? '0'.repeat(64) : files.find(file => file.version === version)!.checksum;
    const checkDirectory = kind === 'unknown' ? undefined : directory;
    const error = kind === 'gap' ? 'MIGRATION_HISTORY_GAP' : kind === 'checksum' ? 'MIGRATION_CHECKSUM_MISMATCH' : 'MIGRATION_HISTORY_UNKNOWN';
    await pool.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [version, checksum]);
    const before = await history();
    try {
      await expect(preflightMigrations(config, checkDirectory)).rejects.toThrow(error);
      await expect(migrate(config, checkDirectory)).rejects.toThrow(error);
      expect(await history()).toEqual(before); expect(await exists(first)).toBe(false); expect(await exists(second)).toBe(false);
    } finally {
      await pool.query('DELETE FROM schema_migrations WHERE version=$1 AND checksum=$2', [version, checksum]);
      await cleanup(directory, [first, second]);
    }
  });

  it('rolls back pending DDL when its real PostgreSQL statement budget expires', async () => {
    const table = probe(), directory = await fixture([`CREATE TABLE ${table}(id int); SELECT pg_sleep(1);`]);
    const before = await history();
    try {
      await expect(migrate({ ...config, statementTimeout: 100 }, directory)).rejects.toThrow('MIGRATION_SQL_FAILED');
      expect(await exists(table)).toBe(false); expect(await history()).toEqual(before);
    } finally { await cleanup(directory, [table]); }
  });

  it('bounds DDL lock waits while preserving the previous committed file and the old reader', async () => {
    const first = probe(), locked = probe();
    const directory = await fixture([`CREATE TABLE ${first}(id int PRIMARY KEY); INSERT INTO ${first} VALUES(1);`,
      `ALTER TABLE ${locked} ADD COLUMN added text;`]);
    await pool.query(`CREATE TABLE ${locked}(id int PRIMARY KEY); INSERT INTO ${locked} VALUES(1);`);
    const readerPool = poolFor(config), reader = await readerPool.connect();
    try {
      await reader.query('BEGIN'); await reader.query(`SELECT * FROM ${locked}`);
      await expect(migrate({ ...config, migrationLockTimeoutMs: 100, statementTimeout: 1000 }, directory))
        .rejects.toMatchObject({ message: 'MIGRATION_SQL_FAILED', cause: { code: '55P03' } });
      expect((await history()).map(row => row.version)).toEqual([...packaged.map(file => file.version), next]);
      expect((await reader.query(`SELECT * FROM ${locked}`)).rows).toEqual([{ id: 1 }]);
      expect((await pool.query(`SELECT * FROM ${first}`)).rows).toEqual([{ id: 1 }]);
      expect((await pool.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', ['public', locked])).rows)
        .toEqual([{ column_name: 'id' }]);
    } finally {
      await reader.query('ROLLBACK'); reader.release(); await readerPool.end(); await cleanup(directory, [first, locked]);
    }
  });
});
