import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { loadMigrationFiles } from '../../src/db/migration-files.js';
import { poolFor } from '../../src/plugins/dependencies.js';

const database = process.env.TEST_DATABASE_MIGRATION_URL;
if (!database || !/^huahuo_test_[a-z0-9_]+$/u.test(new URL(database).pathname.slice(1))) throw new Error('REAL_ISOLATED_TEST_DATABASE_REQUIRED');
const pool = poolFor(loadConfig('migrate', { DATABASE_URL: database }));
const migration = loadMigrationFiles().find(file => file.name === '0008_user_storage_counters.sql');
if (!migration) throw new Error('USER_STORAGE_COUNTERS_MIGRATION_MISSING');
const sql = migration.sql;
afterAll(() => pool.end());

/** Exercise the real SQL against transaction-scoped fixture tables, never public user data. */
async function fixture(run: (client: PoolClient, schema: string, migrationSql: string) => Promise<void>) {
  const schema = `storage_counters_${randomUUID().replaceAll('-', '')}`, client = await pool.connect();
  await client.query('BEGIN');
  try {
    await client.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.users (
        id uuid PRIMARY KEY, display_name text NOT NULL DEFAULT 'original user',
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT '2026-01-01',
        updated_at timestamptz NOT NULL DEFAULT '2026-01-02'
      );
      CREATE FUNCTION ${schema}.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at=now(); RETURN NEW; END; $$;
      CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON ${schema}.users
        FOR EACH ROW EXECUTE FUNCTION ${schema}.set_updated_at();
      CREATE TABLE ${schema}.storage_reservations (
        reservation_id uuid PRIMARY KEY, user_id uuid NOT NULL, resource_key text NOT NULL,
        requested_bytes bigint NOT NULL CHECK(requested_bytes>0),
        confirmed_bytes bigint NOT NULL DEFAULT 0 CHECK(confirmed_bytes>=0 AND confirmed_bytes<=requested_bytes),
        status text NOT NULL CHECK(status IN ('reserved','confirmed','released','expired')),
        expires_at timestamptz NOT NULL DEFAULT '2027-01-01',
        created_at timestamptz NOT NULL DEFAULT '2026-01-01',
        updated_at timestamptz NOT NULL DEFAULT '2026-01-02',
        UNIQUE(user_id,resource_key)
      );
      GRANT SELECT,INSERT,UPDATE ON ${schema}.users TO huahuo_api;
      GRANT SELECT ON ${schema}.users TO huahuo_worker;`);
    await run(client, schema, sql.replaceAll('public.', `${schema}.`));
  } finally { await client.query('ROLLBACK'); client.release(); }
}

async function addReservation(client: PoolClient, schema: string, userId: string, status: string, requested: string | number, confirmed: string | number) {
  const id = randomUUID();
  await client.query(`INSERT INTO ${schema}.storage_reservations
    (reservation_id,user_id,resource_key,status,requested_bytes,confirmed_bytes) VALUES($1,$2,$3,$4,$5,$6)`,
  [id, userId, `resource:${id}`, status, requested, confirmed]);
}

async function snapshot(client: PoolClient, schema: string) {
  return {
    users: (await client.query(`SELECT * FROM ${schema}.users ORDER BY id`)).rows,
    reservations: (await client.query(`SELECT * FROM ${schema}.storage_reservations ORDER BY reservation_id`)).rows,
    columns: (await client.query(`SELECT column_name,data_type,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema=$1 AND table_name='users' ORDER BY column_name`, [schema])).rows,
    trigger: (await client.query(`SELECT tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname='users_set_updated_at'`, [`${schema}.users`])).rows,
  };
}

describe('0008 user storage counters on isolated PostgreSQL tables', () => {
  it('initializes only active occupancy, keeps existing rows and timestamps, and gives new users zero counters', async () => {
    await fixture(async (client, schema, migrationSql) => {
      const first = randomUUID(), second = randomUUID(), empty = randomUUID();
      await client.query(`INSERT INTO ${schema}.users(id) VALUES($1),($2),($3)`, [first, second, empty]);
      for (const [status, requested, confirmed] of [
        ['confirmed', 100, 60], ['confirmed', 200, 150], ['reserved', 80, 0],
        ['reserved', 90, 15], ['released', 1000, 999], ['expired', 400, 200],
      ] as const) await addReservation(client, schema, first, status, requested, confirmed);
      await addReservation(client, schema, second, 'confirmed', 50, 50);
      const before = await snapshot(client, schema);

      await client.query(migrationSql);

      const after = await snapshot(client, schema);
      expect(after.users.map(row => Object.fromEntries(Object.entries(row)
        .filter(([key]) => key !== 'storage_used_bytes' && key !== 'storage_reserved_bytes')))).toEqual(before.users);
      expect(after.reservations).toEqual(before.reservations);
      expect(after.trigger).toEqual(before.trigger);
      expect(after.users.find(row => row.id === first)).toMatchObject({ storage_used_bytes: '210', storage_reserved_bytes: '170' });
      expect(after.users.find(row => row.id === second)).toMatchObject({ storage_used_bytes: '50', storage_reserved_bytes: '0' });
      expect(after.users.find(row => row.id === empty)).toMatchObject({ storage_used_bytes: '0', storage_reserved_bytes: '0' });
      expect(after.columns.filter(row => row.column_name.startsWith('storage_'))).toEqual([
        { column_name: 'storage_reserved_bytes', data_type: 'bigint', is_nullable: 'NO', column_default: '0' },
        { column_name: 'storage_used_bytes', data_type: 'bigint', is_nullable: 'NO', column_default: '0' },
      ]);

      const fresh = randomUUID();
      await client.query(`INSERT INTO ${schema}.users(id) VALUES($1)`, [fresh]);
      expect((await client.query(`SELECT storage_used_bytes,storage_reserved_bytes FROM ${schema}.users WHERE id=$1`, [fresh])).rows)
        .toEqual([{ storage_used_bytes: '0', storage_reserved_bytes: '0' }]);
      await client.query(`UPDATE ${schema}.users SET display_name='renamed' WHERE id=$1`, [fresh]);
      expect((await client.query(`SELECT display_name,updated_at>'2026-01-02'::timestamptz AS timestamp_updated
        FROM ${schema}.users WHERE id=$1`, [fresh])).rows).toEqual([{ display_name: 'renamed', timestamp_updated: true }]);
      await client.query(`DELETE FROM ${schema}.users WHERE id=$1`, [fresh]);
      expect((await client.query(`SELECT 1 FROM ${schema}.users WHERE id=$1`, [fresh])).rows).toEqual([]);
      expect((await client.query(`SELECT count(*)::int AS n FROM pg_constraint c
        JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.contype='f'`, [schema])).rows[0].n).toBe(0);
    });
  });

  it.each(['reserved', 'confirmed', 'released', 'expired'])('refuses an orphaned %s reservation without changing schema or data', async status => {
    await fixture(async (client, schema, migrationSql) => {
      await addReservation(client, schema, randomUUID(), status, 100, 40);
      const before = await snapshot(client, schema);
      await client.query('SAVEPOINT migration_start');
      await expect(client.query(migrationSql)).rejects.toThrow('STORAGE_COUNTER_ORPHAN_RESERVATIONS');
      await client.query('ROLLBACK TO SAVEPOINT migration_start');
      expect(await snapshot(client, schema)).toEqual(before);
    });
  });

  it('rejects negative or null counters and preserves the other counter on failed updates', async () => {
    await fixture(async (client, schema, migrationSql) => {
      const userId = randomUUID();
      await client.query(`INSERT INTO ${schema}.users(id) VALUES($1)`, [userId]);
      await client.query(migrationSql);
      for (const column of ['storage_used_bytes', 'storage_reserved_bytes']) {
        for (const [value, code] of [[-1, '23514'], [null, '23502']] as const) {
          await client.query('SAVEPOINT invalid_counter');
          await expect(client.query(`UPDATE ${schema}.users SET ${column}=$2 WHERE id=$1`, [userId, value])).rejects.toMatchObject({ code });
          await client.query('ROLLBACK TO SAVEPOINT invalid_counter');
          await client.query('RELEASE SAVEPOINT invalid_counter');
        }
      }
      expect((await client.query(`SELECT storage_used_bytes,storage_reserved_bytes FROM ${schema}.users WHERE id=$1`, [userId])).rows)
        .toEqual([{ storage_used_bytes: '0', storage_reserved_bytes: '0' }]);
    });
  });

  it('adds only counter-column update privileges to Worker and preserves API table privileges', async () => {
    await fixture(async (client, schema, migrationSql) => {
      await client.query(migrationSql);
      const workerColumns = await client.query(`SELECT attname FROM pg_attribute
        WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped
          AND has_column_privilege('huahuo_worker',attrelid,attnum,'UPDATE') ORDER BY attname`, [`${schema}.users`]);
      expect(workerColumns.rows.map(row => row.attname)).toEqual(['storage_reserved_bytes', 'storage_used_bytes']);
      expect((await client.query(`SELECT
        has_table_privilege('huahuo_worker',$1,'UPDATE') AS worker_table_update,
        has_table_privilege('huahuo_worker',$1,'INSERT') AS worker_insert,
        has_table_privilege('huahuo_worker',$1,'DELETE') AS worker_delete,
        has_table_privilege('huahuo_worker',$1,'SELECT') AS worker_select,
        has_table_privilege('huahuo_api',$1,'UPDATE') AS api_update,
        has_table_privilege('huahuo_api',$1,'INSERT') AS api_insert`, [`${schema}.users`])).rows).toEqual([{
        worker_table_update: false, worker_insert: false, worker_delete: false,
        worker_select: true, api_update: true, api_insert: true,
      }]);
    });
  });

  it('rolls back the entire migration when historical occupancy exceeds bigint', async () => {
    await fixture(async (client, schema, migrationSql) => {
      const userId = randomUUID();
      await client.query(`INSERT INTO ${schema}.users(id) VALUES($1)`, [userId]);
      await addReservation(client, schema, userId, 'confirmed', '9223372036854775807', '9223372036854775807');
      await addReservation(client, schema, userId, 'confirmed', 1, 1);
      const before = await snapshot(client, schema);
      await client.query('SAVEPOINT migration_start');
      await expect(client.query(migrationSql)).rejects.toMatchObject({ code: '22003' });
      await client.query('ROLLBACK TO SAVEPOINT migration_start');
      expect(await snapshot(client, schema)).toEqual(before);
    });
  });
});
