import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { loadMigrationFiles } from '../../src/db/migration-files.js';
import { poolFor } from '../../src/plugins/dependencies.js';

const database = process.env.TEST_DATABASE_MIGRATION_URL;
if (!database || !/^huahuo_test_[a-z0-9_]+$/u.test(new URL(database).pathname.slice(1))) throw new Error('REAL_ISOLATED_TEST_DATABASE_REQUIRED');
const pool = poolFor(loadConfig('migrate', { DATABASE_URL: database }));
const migration = loadMigrationFiles().find(file => file.name === '0007_generic_direct_upload.sql');
if (!migration) throw new Error('GENERIC_UPLOAD_MIGRATION_MISSING');
const sql = migration.sql;
afterAll(() => pool.end());

/** The actual migration only touches transaction-scoped fixture tables, never public data. */
async function fixture(run: (client: PoolClient, schema: string, migrationSql: string) => Promise<void>) {
  const schema = `generic_upload_${randomUUID().replaceAll('-', '')}`, client = await pool.connect();
  await client.query('BEGIN');
  try {
    await client.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.resources (
        resource_id uuid PRIMARY KEY, upload_id uuid UNIQUE NOT NULL, user_id uuid NOT NULL,
        source_scene text NOT NULL, duration_seconds double precision NOT NULL,
        file_name text NOT NULL, sha256 char(64), status text NOT NULL DEFAULT 'ready',
        processing_status text NOT NULL DEFAULT 'metadata_confirmed'
      );
      CREATE TABLE ${schema}.upload_sessions (
        upload_id uuid PRIMARY KEY, resource_id uuid UNIQUE NOT NULL, reservation_id uuid UNIQUE NOT NULL,
        source_scene text NOT NULL, duration_seconds double precision NOT NULL,
        expected_sha256 char(64), received_sha256 char(64), verified_duration double precision,
        status text NOT NULL, expires_at timestamptz NOT NULL
      );
      CREATE INDEX upload_expiry ON ${schema}.upload_sessions(status,expires_at);
      CREATE TABLE ${schema}.storage_reservations (
        reservation_id uuid PRIMARY KEY, user_id uuid NOT NULL, resource_key text NOT NULL,
        requested_bytes bigint NOT NULL, confirmed_bytes bigint, status text NOT NULL
      );
      CREATE TABLE ${schema}.tasks (id uuid PRIMARY KEY,kind text NOT NULL,state text NOT NULL);
      CREATE TABLE ${schema}.storage_jobs (task_id uuid PRIMARY KEY,upload_id uuid,operation text NOT NULL);
      CREATE TABLE ${schema}.resource_refs (
        resource_id uuid NOT NULL, ref_kind text NOT NULL, ref_id_external text NOT NULL,
        user_id uuid, workspace_id uuid
      );`);
    await run(client, schema, sql.replaceAll('public.', `${schema}.`));
  } finally { await client.query('ROLLBACK'); client.release(); }
}

async function snapshot(client: PoolClient, schema: string) {
  const result: Record<string, unknown> = {};
  for (const table of ['resources', 'upload_sessions', 'storage_reservations', 'resource_refs', 'tasks', 'storage_jobs']) {
    result[table] = (await client.query(`SELECT row_to_json(t) AS data FROM ${schema}.${table} t ORDER BY row_to_json(t)::text`)).rows;
  }
  result.columns = (await client.query(`SELECT table_name,column_name,data_type,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,column_name`, [schema])).rows;
  return result;
}

async function legacyUpload(client: PoolClient, schema: string, status: string, futureExpiry = false) {
  const uploadId = randomUUID(), resourceId = randomUUID(), reservationId = randomUUID();
  await client.query(`INSERT INTO ${schema}.upload_sessions
    (upload_id,resource_id,reservation_id,source_scene,duration_seconds,expected_sha256,received_sha256,verified_duration,status,expires_at)
    VALUES($1,$2,$3,'old-business-scene',23,$4,$4,23,$5,now()+$6::interval)`,
  [uploadId, resourceId, reservationId, 'a'.repeat(64), status, futureExpiry ? '1 hour' : '-1 hour']);
  return { uploadId, resourceId, reservationId };
}

async function rejectsWithoutChanges(client: PoolClient, schema: string, migrationSql: string, message: string) {
  const before = await snapshot(client, schema);
  await client.query('SAVEPOINT migration_start');
  await expect(client.query(migrationSql)).rejects.toThrow(message);
  await client.query('ROLLBACK TO SAVEPOINT migration_start');
  expect(await snapshot(client, schema)).toEqual(before);
}

describe('0007 generic uploads on isolated PostgreSQL tables', () => {
  it('preserves historical resources, measured hashes, references and confirmed occupancy while removing only unused metadata', async () => {
    await fixture(async (client, schema, migrationSql) => {
      const old = await legacyUpload(client, schema, 'completed'), userId = randomUUID(), digest = 'b'.repeat(64);
      await client.query(`INSERT INTO ${schema}.resources
        (resource_id,upload_id,user_id,source_scene,duration_seconds,file_name,sha256,processing_status)
        VALUES($1,$2,$3,'note_import',23,'history.txt',$4,'inspected')`, [old.resourceId, old.uploadId, userId, digest]);
      await client.query(`INSERT INTO ${schema}.storage_reservations
        VALUES($1,$2,$3,100,100,'confirmed')`, [old.reservationId, userId, `resource:${old.resourceId}`]);
      await client.query(`INSERT INTO ${schema}.resource_refs(resource_id,ref_kind,ref_id_external) VALUES($1,'note','historical-note')`, [old.resourceId]);
      const reservations = (await client.query(`SELECT * FROM ${schema}.storage_reservations`)).rows;
      await client.query(migrationSql);
      expect((await client.query(`SELECT * FROM ${schema}.resources`)).rows).toEqual([{
        resource_id: old.resourceId, upload_id: old.uploadId, user_id: userId, file_name: 'history.txt',
        sha256: digest, status: 'ready', processing_status: 'inspected',
      }]);
      expect((await client.query(`SELECT * FROM ${schema}.storage_reservations`)).rows).toEqual(reservations);
      expect((await client.query(`SELECT r.resource_id,f.ref_id_external FROM ${schema}.resources r
        JOIN ${schema}.resource_refs f ON f.resource_id=r.resource_id`)).rows)
        .toEqual([{ resource_id: old.resourceId, ref_id_external: 'historical-note' }]);
      expect((await client.query('SELECT to_regclass($1) AS name', [`${schema}.upload_sessions`])).rows[0].name).toBeNull();
      const columns = (await client.query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1`, [schema])).rows;
      expect(columns.filter(row => ['source_scene','duration_seconds','expected_sha256','received_sha256','verified_duration'].includes(row.column_name))).toEqual([]);
      const foreignKeys = await client.query(`SELECT count(*)::int AS n FROM pg_constraint c
        JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.contype='f'`, [schema]);
      expect(foreignKeys.rows[0].n).toBe(0);
      const id = randomUUID();
      await client.query(`INSERT INTO ${schema}.resources(resource_id,upload_id,user_id,file_name)
        VALUES($1,$2,$3,'generic.bin')`, [id, randomUUID(), userId]);
      await client.query(`UPDATE ${schema}.resources SET file_name='renamed.bin' WHERE resource_id=$1`, [id]);
      expect((await client.query(`SELECT file_name,sha256 FROM ${schema}.resources WHERE resource_id=$1`, [id])).rows)
        .toEqual([{ file_name: 'renamed.bin', sha256: null }]);
      await client.query(`DELETE FROM ${schema}.resources WHERE resource_id=$1`, [id]);
      expect((await client.query(`SELECT 1 FROM ${schema}.resources WHERE resource_id=$1`, [id])).rows).toEqual([]);
    });
  });

  it.each(['initiated', 'uploading', 'uploaded'])('refuses a legacy %s upload without changing data or columns', async status => {
    await fixture(async (client, schema, migrationSql) => {
      await legacyUpload(client, schema, status);
      await rejectsWithoutChanges(client, schema, migrationSql, 'GENERIC_UPLOAD_ACTIVE_LEGACY_UPLOADS');
    });
  });

  it('refuses unresolved storage reservations even when the old upload is already terminal', async () => {
    await fixture(async (client, schema, migrationSql) => {
      const old = await legacyUpload(client, schema, 'failed');
      await client.query(`INSERT INTO ${schema}.storage_reservations
        VALUES($1,$2,$3,100,NULL,'reserved')`, [old.reservationId, randomUUID(), `resource:${old.resourceId}`]);
      await rejectsWithoutChanges(client, schema, migrationSql, 'GENERIC_UPLOAD_LEGACY_RESERVATIONS_PENDING');
    });
  });

  it.each(['completed', 'failed', 'expired'])('refuses an unexpired legacy authorization even when its session is %s', async status => {
    await fixture(async (client, schema, migrationSql) => {
      await legacyUpload(client, schema, status, true);
      await rejectsWithoutChanges(client, schema, migrationSql, 'GENERIC_UPLOAD_LEGACY_AUTHORIZATION_ACTIVE');
    });
  });
  it('refuses unfinished legacy cleanup even when its upload is expired and quota released', async () => {
    await fixture(async (client, schema, migrationSql) => {
      await legacyUpload(client, schema, 'expired');
      await client.query(`INSERT INTO ${schema}.tasks VALUES($1,'storage.expire','running')`, [randomUUID()]);
      await rejectsWithoutChanges(client, schema, migrationSql, 'GENERIC_UPLOAD_LEGACY_CLEANUP_PENDING');
    });
  });

  it.each(['failed','cancelled','missing'])('preserves old object locators when cleanup is %s, regardless of released quota', async state => {
    await fixture(async (client, schema, migrationSql) => {
      const old = await legacyUpload(client, schema, 'expired'), taskId = randomUUID();
      await client.query(`INSERT INTO ${schema}.storage_reservations VALUES($1,$2,$3,100,0,'released')`, [old.reservationId, randomUUID(), `resource:${old.resourceId}`]);
      if (state !== 'missing') {
        await client.query(`INSERT INTO ${schema}.tasks VALUES($1,'storage.expire',$2)`, [taskId,state]);
        await client.query(`INSERT INTO ${schema}.storage_jobs VALUES($1,$2,'expire')`, [taskId,old.uploadId]);
      }
      await rejectsWithoutChanges(client,schema,migrationSql,'GENERIC_UPLOAD_LEGACY_CLEANUP_UNCONFIRMED');
    });
  });

  it.each(['failed','expired'])('retires a %s session only with successful matching cleanup evidence', async status => {
    await fixture(async (client, schema, migrationSql) => {
      const old = await legacyUpload(client, schema, status), taskId = randomUUID();
      await client.query(`INSERT INTO ${schema}.tasks VALUES($1,'storage.expire','succeeded')`, [taskId]);
      await client.query(`INSERT INTO ${schema}.storage_jobs VALUES($1,$2,'expire')`, [taskId,old.uploadId]);
      await client.query(migrationSql);
      expect((await client.query('SELECT to_regclass($1) AS name', [`${schema}.upload_sessions`])).rows[0].name).toBeNull();
      const indexes=(await client.query(`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname IN ('storage_reservations_active_user','resource_refs_owner')`,[schema])).rows;
      expect(indexes).toHaveLength(2);
      expect(indexes.find(row=>row.indexname==='storage_reservations_active_user')?.indexdef).toContain('INCLUDE (requested_bytes, confirmed_bytes) WHERE');
      expect(indexes.find(row=>row.indexname==='resource_refs_owner')?.indexdef).toContain('(user_id, ref_kind, ref_id_external, workspace_id)');
    });
  });

});
