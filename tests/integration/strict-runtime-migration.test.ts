import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { loadMigrationFiles } from '../../src/db/migration-files.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { defaults } from '../../src/modules/runtime-settings/registry.js';

const database = process.env.TEST_DATABASE_MIGRATION_URL;
if (!database || !/^huahuo_test_[a-z0-9_]+$/u.test(new URL(database).pathname.slice(1))) throw new Error('ISOLATED_DATABASE_REQUIRED');
const config = loadConfig('migrate', { DATABASE_URL: database });
const pool = poolFor(config);
const migration = loadMigrationFiles().find(file => file.name.endsWith('_strict_runtime_configuration.sql'))!;
afterAll(() => pool.end());
async function fixture(stored: unknown, run: (tx: PoolClient, schema: string, sql: string) => Promise<void>) {
  const tx = await pool.connect(), schema = `strict_runtime_${randomUUID().replaceAll('-', '')}`;
  await tx.query('BEGIN');
  try {
    await tx.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.runtime_configuration(singleton boolean PRIMARY KEY, revision bigint, "values" jsonb, updated_at timestamptz);
      GRANT SELECT ON ${schema}.runtime_configuration TO huahuo_api,huahuo_worker,huahuo_scheduler;
      GRANT SELECT,UPDATE ON ${schema}.runtime_configuration TO huahuo_admin;`);
    await tx.query(`INSERT INTO ${schema}.runtime_configuration VALUES(true,7,$1,'2026-01-01')`, [JSON.stringify(stored)]);
    await run(tx, schema, migration.sql.replaceAll('public.', `${schema}.`));
  } finally { await tx.query('ROLLBACK'); tx.release(); }
}

describe('strict runtime configuration migration in an isolated schema', () => {
  it('removes only reviewed retired keys once, retaining settings, primary key and role permissions', async () => {
    const {
      'features.contentAssetIndexing': contentAssetIndexing,
      'rag.contentAssetRerankBudgetMs': contentAssetRerankBudgetMs,
      ...unchanged
    } = defaults();
    const current = {
      ...unchanged,
      'features.noteIndexing': contentAssetIndexing,
      'rag.noteRerankBudgetMs': contentAssetRerankBudgetMs,
      'tasks.maxAttempts': 5,
    };
    await fixture({ ...current, $schemaVersion: 1, 'storage.maxSourceBytes': 200, 'tasks.downloadTimeoutMs': 1000 }, async (tx, schema, sql) => {
      await tx.query(sql);
      const rows = (await tx.query(`SELECT * FROM ${schema}.runtime_configuration`)).rows;
      expect(rows[0]).toMatchObject({ revision: '8', values: current });
      await tx.query(sql);
      expect((await tx.query(`SELECT * FROM ${schema}.runtime_configuration`)).rows).toEqual(rows);
      const object = `${schema}.runtime_configuration`;
      const assertions = (await tx.query(`SELECT
        has_table_privilege('huahuo_api',$1,'SELECT') AND NOT has_table_privilege('huahuo_api',$1,'UPDATE') AS api_access,
        has_table_privilege('huahuo_worker',$1,'SELECT') AND has_table_privilege('huahuo_scheduler',$1,'SELECT') AS background_access,
        has_table_privilege('huahuo_admin',$1,'SELECT') AND has_table_privilege('huahuo_admin',$1,'UPDATE') AS admin_access,
        EXISTS(SELECT 1 FROM pg_index WHERE indrelid=$1::regclass AND indisprimary AND indisvalid) AS primary_index,
        NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=$1::regclass AND contype='f') AS no_foreign_keys`, [object])).rows[0];
      expect(Object.values(assertions).every(Boolean)).toBe(true);
      await tx.query(`UPDATE ${schema}.runtime_configuration SET "values"=jsonb_set("values",'{tasks.maxAttempts}','6'),revision=revision+1 WHERE singleton=true`);
      expect((await tx.query(`SELECT "values"->'tasks.maxAttempts' AS attempts FROM ${schema}.runtime_configuration WHERE singleton=true`)).rows[0].attempts).toBe(6);
    });
  });
  it.each([
    [{ 'tasks.futureOptional': { enabled: true } }, 'RUNTIME_CONFIGURATION_UNKNOWN_KEY_REVIEW_REQUIRED'],
    [{ $schemaVersion: 2 }, 'RUNTIME_CONFIGURATION_VERSION_REVIEW_REQUIRED'],
    [{ $schemaVersion: '1' }, 'RUNTIME_CONFIGURATION_VERSION_REVIEW_REQUIRED'],
    [[], 'RUNTIME_CONFIGURATION_INVALID'],
  ])('stops before cleanup for unreviewed configuration %#', async (stored, code) => {
    await fixture(stored, async (tx, schema, sql) => {
      await tx.query('SAVEPOINT before_migration');
      await expect(tx.query(sql)).rejects.toThrow(String(code));
      await tx.query('ROLLBACK TO SAVEPOINT before_migration');
      expect((await tx.query(`SELECT revision,"values" FROM ${schema}.runtime_configuration`)).rows).toEqual([{ revision: '7', values: stored }]);
    });
  });
});
