import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { loadMigrationFiles } from '../../src/db/migration-files.js';
import { poolFor } from '../../src/plugins/dependencies.js';

const database = process.env.TEST_DATABASE_MIGRATION_URL;
if (!database || !/^huahuo_test_[a-z0-9_]+$/u.test(new URL(database).pathname.slice(1))) throw new Error('ISOLATED_DATABASE_REQUIRED');
const pool = poolFor(loadConfig('migrate', { DATABASE_URL: database }));
const migration = loadMigrationFiles().find(file => file.name === '0017_disable_placeholder_maintenance.sql')!;
afterAll(() => pool.end());

it('disables only the bootstrap schedule and preserves custom schedules and task history', async () => {
  const tx = await pool.connect(), schema = `schedule_cleanup_${randomUUID().replaceAll('-', '')}`;
  await tx.query('BEGIN');
  try {
    await tx.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.task_schedules (LIKE public.task_schedules INCLUDING ALL);
      CREATE TABLE ${schema}.task_schedule_windows (LIKE public.task_schedule_windows INCLUDING ALL);
      CREATE TABLE ${schema}.tasks (LIKE public.tasks INCLUDING ALL);`);
    await tx.query(`INSERT INTO ${schema}.task_schedules(id,interval_seconds,enabled,last_window)
      VALUES('maintenance-check-v1',3600,true,42),('real-job',60,true,7),('paused-job',60,false,NULL)`);
    const taskId = randomUUID();
    await tx.query(`INSERT INTO ${schema}.tasks(id,kind,queue,state,trace_id,result_id)
      VALUES($1,'maintenance.check','maintenance','succeeded','schedule-history',$2)`, [taskId, randomUUID()]);
    await tx.query(`INSERT INTO ${schema}.task_schedule_windows(schedule_id,window_id,task_id)
      VALUES('maintenance-check-v1',42,$1)`, [taskId]);
    const history = (await tx.query(`SELECT * FROM ${schema}.tasks`)).rows;
    const windows = (await tx.query(`SELECT * FROM ${schema}.task_schedule_windows`)).rows;
    const sql = migration.sql.replaceAll('public.', `${schema}.`);
    await tx.query(sql);
    const schedules = (await tx.query(`SELECT id,enabled,last_window FROM ${schema}.task_schedules ORDER BY id`)).rows;
    expect(schedules).toEqual([
      { id: 'maintenance-check-v1', enabled: false, last_window: '42' },
      { id: 'paused-job', enabled: false, last_window: null },
      { id: 'real-job', enabled: true, last_window: '7' },
    ]);
    await tx.query(sql);
    expect((await tx.query(`SELECT id,enabled,last_window FROM ${schema}.task_schedules ORDER BY id`)).rows).toEqual(schedules);
    expect((await tx.query(`SELECT * FROM ${schema}.tasks`)).rows).toEqual(history);
    expect((await tx.query(`SELECT * FROM ${schema}.task_schedule_windows`)).rows).toEqual(windows);
    expect((await tx.query("SELECT count(*)::int AS n FROM pg_constraint WHERE connamespace=$1::regnamespace AND contype='f'", [schema])).rows[0].n).toBe(0);
  } finally { await tx.query('ROLLBACK'); tx.release(); }
});
