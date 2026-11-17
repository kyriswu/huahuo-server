import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { loadMigrationFiles } from '../../src/db/migration-files.js';
import { poolFor } from '../../src/plugins/dependencies.js';

const database = process.env.TEST_DATABASE_MIGRATION_URL;
if (!database || !/^huahuo_test_[a-z0-9_]+$/u.test(new URL(database).pathname.slice(1))) throw new Error('REAL_ISOLATED_TEST_DATABASE_REQUIRED');
const pool = poolFor(loadConfig('migrate', { DATABASE_URL: database }));
const migration = loadMigrationFiles().find(file => file.name === '0006_oss_direct_access.sql');
if (!migration) throw new Error('OSS_DIRECT_MIGRATION_MISSING');
const sql = migration.sql;
afterAll(() => pool.end());

/** Only these temporary fixture tables are addressed by the real migration SQL.
 * No public business table or migration-history row is read, changed or reset. */
async function fixture(run: (client: PoolClient, schema: string, migrationSql: string) => Promise<void>) {
  const schema = `oss_direct_${randomUUID().replaceAll('-', '')}`, client = await pool.connect();
  await client.query('BEGIN');
  try {
    await client.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.resources (
        resource_id uuid PRIMARY KEY, sha256 char(64) NOT NULL,
        status text NOT NULL DEFAULT 'ready', processing_status text NOT NULL DEFAULT 'inspection_pending',
        CONSTRAINT resources_processing_status_check CHECK (processing_status IN ('inspection_pending','inspected','failed'))
      );
      CREATE TABLE ${schema}.tasks (
        id uuid PRIMARY KEY, kind text NOT NULL, state text NOT NULL, version integer NOT NULL DEFAULT 4,
        reservation_id uuid, external_state text NOT NULL DEFAULT 'none',
        lease_owner uuid, lease_until timestamptz, retryable boolean NOT NULL DEFAULT true,
        error_code text, cancel_requested_at timestamptz, event_sequence integer NOT NULL DEFAULT 7,
        updated_at timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00Z',
        CHECK (state IN ('queued','running','retry_scheduled','waiting_external','reconciling','cancel_requested','succeeded','failed','cancelled')),
        CHECK (external_state IN ('none','submitted','unknown'))
      );
      CREATE TABLE ${schema}.task_attempts (
        task_id uuid NOT NULL, attempt_no integer NOT NULL, state text NOT NULL,
        error_code text, finished_at timestamptz, PRIMARY KEY(task_id,attempt_no)
      );
      CREATE TABLE ${schema}.task_events (
        task_id uuid NOT NULL, sequence integer NOT NULL, state text NOT NULL,
        PRIMARY KEY(task_id,sequence)
      );
      CREATE TABLE ${schema}.task_outbox (
        id uuid PRIMARY KEY, task_id uuid NOT NULL, status text NOT NULL,
        lease_owner uuid, lease_until timestamptz, last_error text,
        CHECK (status IN ('pending','delivering','sent','superseded'))
      );`);
    await run(client, schema, sql.replaceAll('public.', `${schema}.`));
  } finally { await client.query('ROLLBACK'); client.release(); }
}
async function snapshot(client: PoolClient, schema: string) {
  const result: Record<string, unknown> = {};
  for (const table of ['resources', 'tasks', 'task_attempts', 'task_events', 'task_outbox']) {
    result[table] = (await client.query(`SELECT row_to_json(t) AS data FROM ${schema}.${table} t ORDER BY row_to_json(t)::text`)).rows;
  }
  result.resourceColumns = (await client.query(`SELECT column_name,is_nullable,column_default FROM information_schema.columns
    WHERE table_schema=$1 AND table_name='resources' ORDER BY column_name`, [schema])).rows;
  return result;
}

const active = ['queued', 'running', 'retry_scheduled', 'waiting_external', 'reconciling', 'cancel_requested'];
const terminal = ['succeeded', 'failed', 'cancelled'];

describe('0006 OSS direct-access retirement on isolated PostgreSQL tables', () => {
  it('keeps measured hashes and ready resources while allowing unmeasured new objects', async () => {
    await fixture(async (client, schema, migrationSql) => {
      const pending = randomUUID(), inspected = randomUUID(), failed = randomUUID(), digest = 'a'.repeat(64);
      await client.query(`INSERT INTO ${schema}.resources(resource_id,sha256,status,processing_status) VALUES
        ($1,$4,'ready','inspection_pending'),($2,$4,'ready','inspected'),($3,$4,'quarantined','failed')`, [pending, inspected, failed, digest]);
      await client.query(migrationSql);
      const rows = (await client.query(`SELECT * FROM ${schema}.resources`)).rows;
      expect(rows).toEqual(expect.arrayContaining([
        { resource_id: pending, sha256: digest, status: 'ready', processing_status: 'metadata_confirmed' },
        { resource_id: inspected, sha256: digest, status: 'ready', processing_status: 'inspected' },
        { resource_id: failed, sha256: digest, status: 'quarantined', processing_status: 'failed' },
      ]));
      const created = await client.query(`INSERT INTO ${schema}.resources(resource_id,sha256) VALUES($1,NULL) RETURNING *`, [randomUUID()]);
      expect(created.rows[0]).toMatchObject({ sha256: null, status: 'ready', processing_status: 'metadata_confirmed' });
      await client.query('SAVEPOINT obsolete_label');
      await expect(client.query(`INSERT INTO ${schema}.resources(resource_id,sha256,processing_status) VALUES($1,NULL,'inspection_pending')`, [randomUUID()])).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT obsolete_label');
      const foreignKeys = await client.query(`SELECT count(*) AS count FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.contype='f'`, [schema]);
      expect(Number(foreignKeys.rows[0].count)).toBe(0);
    });
  });

  it('retires only inspection work and preserves completed attempts and unrelated task history', async () => {
    await fixture(async (client, schema, migrationSql) => {
      const activeIds: string[] = [], unchangedIds: string[] = [], historicalAttempts: string[] = [];
      for (const kind of ['storage.inspect', 'storage.delete']) for (const state of [...active, ...terminal]) {
        const id = randomUUID(), owner = randomUUID();
        const retirement = kind === 'storage.inspect' && active.includes(state);
        (retirement ? activeIds : unchangedIds).push(id);
        // Terminal history and unrelated work may retain reservations/external state.
        await client.query(`INSERT INTO ${schema}.tasks(id,kind,state,lease_owner,lease_until,error_code,reservation_id,external_state,cancel_requested_at)
          VALUES($1,$2,$3,$4,'2026-01-02T00:00:00Z',$5,$6,$7,$8)`, [id, kind, state, owner, retirement ? null : 'HISTORICAL_ERROR', retirement ? null : randomUUID(), retirement ? 'none' : 'submitted', state === 'cancel_requested' ? '2025-12-31T00:00:00Z' : null]);
        await client.query(`INSERT INTO ${schema}.task_events VALUES($1,7,$2)`, [id, state]);
        await client.query(`INSERT INTO ${schema}.task_attempts VALUES($1,1,'failed','HISTORICAL_ATTEMPT','2025-12-31T00:00:00Z'),($1,2,$2,NULL,$3)`, [id, state, terminal.includes(state) ? '2026-01-01T00:00:00Z' : null]);
        historicalAttempts.push(id);
        for (const status of ['pending', 'delivering', 'sent', 'superseded']) {
          await client.query(`INSERT INTO ${schema}.task_outbox VALUES($1,$2,$3,$4,'2026-01-02T00:00:00Z','old-error')`, [randomUUID(), id, status, owner]);
        }
      }
      const unchanged = (await client.query(`SELECT * FROM ${schema}.tasks WHERE id=ANY($1::uuid[]) ORDER BY id`, [unchangedIds])).rows;
      const unchangedAttempts = (await client.query(`SELECT * FROM ${schema}.task_attempts WHERE task_id=ANY($1::uuid[]) ORDER BY task_id,attempt_no`, [unchangedIds])).rows;
      const oldEvents = (await client.query(`SELECT * FROM ${schema}.task_events ORDER BY task_id,sequence`)).rows;
      const oldAttempts = (await client.query(`SELECT * FROM ${schema}.task_attempts WHERE attempt_no=1 ORDER BY task_id`)).rows;
      const otherOutbox = (await client.query(`SELECT o.* FROM ${schema}.task_outbox o JOIN ${schema}.tasks t ON t.id=o.task_id WHERE t.kind='storage.delete' ORDER BY o.id`)).rows;
      const terminalOutbox = (await client.query(`SELECT * FROM ${schema}.task_outbox WHERE status IN ('sent','superseded') ORDER BY id`)).rows;
      await client.query(migrationSql);
      const retired = (await client.query(`SELECT * FROM ${schema}.tasks WHERE id=ANY($1::uuid[])`, [activeIds])).rows;
      expect(retired).toHaveLength(active.length);
      for (const task of retired) {
        expect(task).toMatchObject({ state: 'cancelled', version: 5, event_sequence: 8, lease_owner: null, lease_until: null, retryable: false, error_code: 'STORAGE_INSPECTION_REMOVED' });
        expect(task.cancel_requested_at).toBeInstanceOf(Date);
      }
      expect((await client.query(`SELECT * FROM ${schema}.tasks WHERE id=ANY($1::uuid[]) ORDER BY id`, [unchangedIds])).rows).toEqual(unchanged);
      expect((await client.query(`SELECT * FROM ${schema}.task_attempts WHERE attempt_no=1 ORDER BY task_id`)).rows).toEqual(oldAttempts);
      expect(oldAttempts).toHaveLength(historicalAttempts.length);
      expect((await client.query(`SELECT * FROM ${schema}.task_attempts WHERE task_id=ANY($1::uuid[]) ORDER BY task_id,attempt_no`, [unchangedIds])).rows).toEqual(unchangedAttempts);
      expect((await client.query(`SELECT * FROM ${schema}.task_events WHERE sequence=7 ORDER BY task_id,sequence`)).rows).toEqual(oldEvents);
      expect((await client.query(`SELECT * FROM ${schema}.task_attempts WHERE task_id=ANY($1::uuid[]) AND attempt_no=2`, [activeIds])).rows).toEqual(expect.arrayContaining(activeIds.map(task_id => expect.objectContaining({ task_id, state: 'cancelled', error_code: 'STORAGE_INSPECTION_REMOVED', finished_at: expect.any(Date) }))));
      expect((await client.query(`SELECT * FROM ${schema}.task_events WHERE sequence=8 ORDER BY task_id`)).rows).toEqual(activeIds.sort().map(task_id => ({ task_id, sequence: 8, state: 'cancelled' })));
      expect((await client.query(`SELECT o.* FROM ${schema}.task_outbox o JOIN ${schema}.tasks t ON t.id=o.task_id WHERE t.kind='storage.delete' ORDER BY o.id`)).rows).toEqual(otherOutbox);
      expect((await client.query(`SELECT * FROM ${schema}.task_outbox WHERE id=ANY($1::uuid[]) ORDER BY id`, [terminalOutbox.map(row => row.id)])).rows).toEqual(terminalOutbox);
      const obsoleteDeliveries = (await client.query(`SELECT o.* FROM ${schema}.task_outbox o JOIN ${schema}.tasks t ON t.id=o.task_id WHERE t.kind='storage.inspect' AND o.last_error='STORAGE_INSPECTION_REMOVED'`)).rows;
      expect(obsoleteDeliveries).toHaveLength((active.length + terminal.length) * 2);
      for (const outbox of obsoleteDeliveries) expect(outbox).toMatchObject({ status: 'superseded', lease_owner: null, lease_until: null });
    });
  });

  it.each(['reservation', 'submitted', 'unknown'])('rolls back every DDL and data change for an active inspection with %s', async anomaly => {
    await fixture(async (client, schema, migrationSql) => {
      await client.query(`INSERT INTO ${schema}.resources(resource_id,sha256) VALUES($1,$2)`, [randomUUID(), 'b'.repeat(64)]);
      const id = randomUUID();
      await client.query(`INSERT INTO ${schema}.tasks(id,kind,state,reservation_id,external_state) VALUES($1,'storage.inspect','running',$2,$3)`, [id, anomaly === 'reservation' ? randomUUID() : null, anomaly === 'reservation' ? 'none' : anomaly]);
      await client.query(`INSERT INTO ${schema}.task_attempts VALUES($1,1,'running',NULL,NULL)`, [id]);
      await client.query(`INSERT INTO ${schema}.task_events VALUES($1,7,'running')`, [id]);
      const before = await snapshot(client, schema);
      await client.query('SAVEPOINT migration_start');
      await expect(client.query(migrationSql)).rejects.toThrow('STORAGE_INSPECTION_RETIREMENT_REQUIRES_REVIEW');
      await client.query('ROLLBACK TO SAVEPOINT migration_start');
      expect(await snapshot(client, schema)).toEqual(before);
    });
  });
});
