import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { loadTestConfig as loadConfig } from '../sms-fixture.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { migrate } from '../../src/db/migrate.js';
import { BillingService } from '../../src/modules/billing/service.js';
import { TaskService } from '../../src/modules/tasks/service.js';
import { TaskEngine } from '../../src/modules/tasks/engine.js';
import { TaskScheduler } from '../../src/modules/tasks/scheduler.js';
import { TextIngestionService } from '../../src/modules/text-ingestion/service.js';
import { lockOwnedAttemptTx } from '../../src/modules/tasks/lifecycle.js';
import { transaction } from '../../src/modules/identity/store.js';
import type { TaskRow, TaskState } from '../../src/modules/tasks/model.js';
import { insertFixtureSession, insertFixtureUser } from './jwt-fixture.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL;
if (!migrationUrl || !/^huahuo_test_/.test(new URL(migrationUrl).pathname.slice(1))) throw new Error('TEST_DB_REQUIRED');
const env = { ...process.env, APP_ENV: 'test', BILLING_MODE: 'development', LOG_LEVEL: 'silent',
  APP_TOKEN_SECRET: 'task-reservation-'.repeat(4), APP_PUBLIC_BASE_URL: 'http://localhost:3000' };
const migrationConfig = loadConfig('migrate', { ...env, DATABASE_URL: migrationUrl });
const config = (role: 'api-server' | 'worker' | 'scheduler' | 'admin') => loadConfig(role, {
  ...env, ADMIN_SESSION_SECRET: 'admin-reservation-'.repeat(4), ADMIN_PUBLIC_BASE_URL: 'http://localhost:3001',
  DATABASE_URL: process.env[`TEST_DATABASE_${role === 'api-server' ? 'API' : role.toUpperCase()}_URL`],
});
const root = poolFor(migrationConfig), api = poolFor(config('api-server')),
  worker = poolFor(config('worker')), schedulerPool = poolFor(config('scheduler')), admin = poolFor(config('admin'));
const billing = new BillingService(api, config('api-server'));
const tasks = new TaskService(api, env.APP_TOKEN_SECRET, billing);
const scheduler = new TaskScheduler(schedulerPool, { publish: async () => {} });
const engine = new TaskEngine(worker, 60000, new BillingService(worker, config('worker')));

async function fixture(options: {
  state?: TaskState; attempt?: number; maxAttempts?: number; external?: TaskRow['external_state'];
  reference?: string; nullLease?: boolean; resumeCount?: number;
} = {}) {
  const userId = await insertFixtureUser(root), sessionId = randomUUID(), workspaceId = randomUUID(), id = randomUUID();
  await insertFixtureSession(root, userId, sessionId);
  await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'reservation fixture',true,$3)", [workspaceId, userId, randomUUID()]);
  const state = options.state ?? 'queued', attempt = options.attempt ?? 0;
  await root.query(`INSERT INTO tasks(available_at,trace_id,id,user_id,workspace_id,kind,queue,state,attempt_no,max_attempts,
    external_state,external_reference,lease_owner,lease_until,resume_count)
    VALUES(clock_timestamp()-interval '1 minute',gen_random_uuid()::text,$1,$2,$3,'demo.digest','content',$4,$5,$6,$7,$8,$9,$10,$11)`,
  [id, userId, workspaceId, state, attempt, options.maxAttempts ?? 3, options.external ?? 'none', options.reference ?? null,
    attempt ? randomUUID() : null, attempt && !options.nullLease ? new Date(Date.now() - 1000) : null, options.resumeCount ?? 0]);
  if (attempt) await root.query(`INSERT INTO task_attempts(task_id,attempt_no,version,owner,state)
    SELECT id,attempt_no,version,lease_owner,'running' FROM tasks WHERE id=$1`, [id]);
  const reservation = await billing.reserveCredits({ userId, taskId: id, requestedCredits: 5n, reservationKey: `task:${id}` });
  await root.query('UPDATE tasks SET reservation_id=$2 WHERE id=$1', [id, reservation.reservationId]);
  return { id, userId, reservationId: reservation.reservationId, scope: { userId, sessionId, traceId: randomUUID() } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function snapshot(f: Fixture) {
  const task = (await root.query<TaskRow>('SELECT * FROM tasks WHERE id=$1', [f.id])).rows[0]!;
  const reservation = (await root.query('SELECT status FROM credit_reservations WHERE reservation_id=$1', [f.reservationId])).rows[0]!;
  const balance = (await root.query(`SELECT sum(available_credits)::text available,sum(reserved_credits)::text reserved,
    sum(settled_credits)::text settled FROM credit_lots WHERE user_id=$1`, [f.userId])).rows[0]!;
  const releases = (await root.query("SELECT count(*)::int count FROM credit_ledger_entries WHERE reservation_id=$1 AND entry_type='release'", [f.reservationId])).rows[0]!.count;
  return { task, reservation, balance, releases };
}
async function expire(id: string) {
  await root.query("UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1", [id]);
}
beforeAll(async () => { await migrate(migrationConfig); });
afterAll(async () => { await Promise.all([root.end(), api.end(), worker.end(), schedulerPool.end(), admin.end()]); });

it.each([false, true])('recovers exhausted tasks with nullLease=%s and releases funds exactly once', async nullLease => {
  const f = await fixture({ state: 'running', attempt: 3, nullLease }), before = await snapshot(f);
  await scheduler.recover();
  const after = await snapshot(f);
  expect(after.task).toMatchObject({ state: 'failed', error_code: 'ATTEMPTS_EXHAUSTED', retryable: true, lease_owner: null, lease_until: null });
  expect(after.reservation.status).toBe('released');
  expect(after.balance).toEqual({ available: String(BigInt(before.balance.available) + 5n), reserved: '0', settled: '0' });
  expect(after.releases).toBe(1);
  expect((await root.query('SELECT state FROM task_attempts WHERE task_id=$1', [f.id])).rows[0]!.state).toBe('abandoned');
  expect((await root.query('SELECT state FROM task_events WHERE task_id=$1', [f.id])).rows.map(r => r.state)).toEqual(['failed']);
  await Promise.all([scheduler.recover(), billing.releaseReservation(f.reservationId)]);
  expect(await snapshot(f)).toEqual(after);
});

it('keeps a live cancellation reserved, then releases when the lease expires', async () => {
  const f = await fixture(), a = (await engine.claim(f.id, randomUUID()))!;
  expect((await tasks.mutate(f.scope, f.id, 'cancel', randomUUID(), {})).task.state).toBe('cancel_requested');
  await scheduler.recover();
  expect((await snapshot(f)).reservation.status).toBe('reserved');
  expect(await engine.finish(a, 'stale result', 0)).toBe(false);
  await expire(f.id); await scheduler.recover(); await scheduler.recover();
  expect(await snapshot(f)).toMatchObject({ task: { state: 'cancelled' }, reservation: { status: 'released' }, balance: { reserved: '0' }, releases: 1 });
});

it('cancels a queued task and releases its reservation in the same mutation', async () => {
  const f = await fixture(), key = randomUUID();
  const first = await tasks.mutate(f.scope, f.id, 'cancel', key, {});
  expect((await tasks.mutate(f.scope, f.id, 'cancel', key, {}))).toEqual(first);
  await tasks.mutate(f.scope, f.id, 'cancel', randomUUID(), {});
  expect(await snapshot(f)).toMatchObject({ task: { state: 'cancelled' }, reservation: { status: 'released' }, releases: 1 });
});

it('releases the replaced text task through the same cancellation primitive', async () => {
  const owner = await fixture(), cfg = config('api-server');
  const text = new TextIngestionService(api, { ...cfg, rag: { ...cfg.rag, enabled: true } });
  const source = await text.create(owner.scope, { source_type: 'MANUAL_INPUT', raw_content: 'original' }, randomUUID());
  const id = (await root.query('SELECT current_task_id FROM text_ingestion_jobs WHERE id=$1', [source.id])).rows[0]!.current_task_id;
  const reservation = await billing.reserveCredits({ userId: owner.userId, taskId: id, requestedCredits: 5n, reservationKey: `task:${id}` });
  await root.query('UPDATE tasks SET reservation_id=$2 WHERE id=$1', [id, reservation.reservationId]);
  const before = await text.get(owner.scope, source.id), key = randomUUID();
  const updated = await text.update(owner.scope, source.id, { raw_content: 'replacement' }, key, before.etag);
  expect(await text.update(owner.scope, source.id, { raw_content: 'replacement' }, key, before.etag)).toEqual(updated);
  const f = { ...owner, id, reservationId: reservation.reservationId };
  expect(await snapshot(f)).toMatchObject({ task: { state: 'cancelled' }, reservation: { status: 'released' }, releases: 1 });
});

it('retains the existing reservation across recovery and automatic retries, including resumed attempts', async () => {
  const f = await fixture({ state: 'running', attempt: 4, resumeCount: 3 });
  await scheduler.recover();
  expect(await snapshot(f)).toMatchObject({ task: { state: 'queued' }, reservation: { status: 'reserved' }, balance: { reserved: '5' }, releases: 0 });
  const a = (await engine.claim(f.id, randomUUID()))!;
  expect(await engine.fail(a, 'TEMPORARY', true)).toBe(true);
  expect(await snapshot(f)).toMatchObject({ task: { state: 'retry_scheduled', reservation_id: f.reservationId }, reservation: { status: 'reserved' }, releases: 0 });
});

it.each([
  { state: 'running' as const, external: 'unknown' as const },
  { state: 'running' as const, external: 'submitted' as const },
  { state: 'cancel_requested' as const, external: 'unknown' as const },
  { state: 'cancel_requested' as const, external: 'submitted' as const },
  { state: 'running' as const, external: 'none' as const, reference: 'xberg-bound:fixture' },
  { state: 'running' as const, external: 'none' as const, reference: 'node-start:fixture' },
])('reconciles external work without releasing funds: %j', async options => {
  const f = await fixture({ ...options, attempt: 3 });
  await root.query("UPDATE credit_reservations SET expires_at=now()-interval '1 hour' WHERE reservation_id=$1", [f.reservationId]);
  await scheduler.recover();
  expect(await snapshot(f)).toMatchObject({ task: { state: 'reconciling' }, reservation: { status: 'reserved' }, balance: { reserved: '5' }, releases: 0 });
});

it('Worker exhaustion and final failure use the same release even without a BillingService instance', async () => {
  const noBilling = new TaskEngine(worker, 60000);
  const exhausted = await fixture({ attempt: 3 });
  expect(await noBilling.claim(exhausted.id, randomUUID())).toBeNull();
  expect(await snapshot(exhausted)).toMatchObject({ task: { state: 'failed' }, reservation: { status: 'released' }, releases: 1 });
  const f = await fixture(), a = (await noBilling.claim(f.id, randomUUID()))!;
  expect(await noBilling.fail(a, 'PERMANENT', false)).toBe(true);
  expect(await noBilling.fail(a, 'PERMANENT', false)).toBe(false);
  expect(await snapshot(f)).toMatchObject({ task: { state: 'failed' }, reservation: { status: 'released' }, releases: 1 });
});

it('successful completion commits once and does not release', async () => {
  const f = await fixture(), a = (await engine.claim(f.id, randomUUID()))!;
  expect(await engine.finish(a, 'success', 7)).toBe(true);
  expect(await engine.finish(a, 'duplicate', 9)).toBe(false);
  expect(await snapshot(f)).toMatchObject({ task: { state: 'succeeded' }, reservation: { status: 'committed' }, balance: { reserved: '0', settled: '5' }, releases: 0 });
});

it('manual retry reserves again atomically and replay creates no extra reservation', async () => {
  const f = await fixture({ state: 'running', attempt: 3 });
  await scheduler.recover();
  const key = randomUUID(), first = await tasks.mutate(f.scope, f.id, 'retry', key, {});
  expect(first.task.state).toBe('queued');
  expect(await tasks.mutate(f.scope, f.id, 'retry', key, {})).toEqual(first);
  const after = await snapshot(f), renewed = after.task.reservation_id!;
  expect(renewed).not.toBe(f.reservationId);
  expect(after).toMatchObject({ reservation: { status: 'released' }, balance: { reserved: '5' }, releases: 1 });
  expect((await root.query('SELECT count(*)::int count FROM credit_reservations WHERE task_id=$1', [f.id])).rows[0]!.count).toBe(2);
  const a = (await engine.claim(f.id, randomUUID()))!;
  expect(await engine.finish(a, 'retry success', 13)).toBe(true);
  expect((await root.query('SELECT status FROM credit_reservations WHERE reservation_id=$1', [renewed])).rows[0]!.status).toBe('committed');
  expect((await snapshot(f)).balance).toMatchObject({ reserved: '0', settled: '5' });
});

it('insufficient funds roll back a manual retry, leaving the old failure and ledger intact', async () => {
  const f = await fixture({ state: 'running', attempt: 3 });
  await scheduler.recover();
  const before = await snapshot(f);
  // Use the rest of this user's balance through the real reservation API.
  await billing.reserveCredits({ userId: f.userId, requestedCredits: BigInt(before.balance.available), reservationKey: randomUUID() });
  const locked = await snapshot(f);
  await expect(tasks.mutate(f.scope, f.id, 'retry', randomUUID(), {})).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
  expect(await snapshot(f)).toEqual(locked);
  expect((await root.query('SELECT count(*)::int count FROM credit_reservations WHERE task_id=$1', [f.id])).rows[0]!.count).toBe(1);
});

it('does not bypass funding through the read-only Admin account', async () => {
  const f = await fixture({ state: 'running', attempt: 3 });
  await scheduler.recover();
  const before = await snapshot(f), adminTasks = new TaskService(admin, 'admin-reservation-'.repeat(4));
  await expect(adminTasks.adminRetry({ adminId: randomUUID(), sessionId: randomUUID(), username: 'fixture', role: 'superadmin' },
    f.id, randomUUID(), 'retry funded task', 'fixture')).rejects.toMatchObject({ code: 'BILLING_NOT_CONFIGURED' });
  expect(await snapshot(f)).toEqual(before);
});

it('concurrent schedulers recover and release each task only once', async () => {
  const fixtures = await Promise.all(Array.from({ length: 4 }, () => fixture({ state: 'running', attempt: 3 })));
  const second = new TaskScheduler(schedulerPool, { publish: async () => {} });
  await Promise.all([scheduler.recover(), second.recover()]);
  for (const f of fixtures) expect(await snapshot(f)).toMatchObject({ task: { state: 'failed' }, reservation: { status: 'released' }, releases: 1 });
});

it.each(['user', 'task'] as const)('rolls back a mismatched reservation %s without touching another balance', async field => {
  const f = await fixture({ state: 'running', attempt: 3 });
  const other = await fixture();
  await root.query(`UPDATE credit_reservations SET ${field === 'user' ? 'user_id' : 'task_id'}=$2 WHERE reservation_id=$1`,
    [f.reservationId, field === 'user' ? other.userId : other.id]);
  const before = await snapshot(f), otherBefore = await snapshot(other);
  try {
    expect((await scheduler.recover()).failures).toContainEqual({taskId:f.id,code:'TASK_RESERVATION_MISMATCH'});
    expect(await snapshot(f)).toEqual(before);
    expect(await snapshot(other)).toMatchObject({reservation:otherBefore.reservation,balance:otherBefore.balance,
      releases:otherBefore.releases,task:{state:otherBefore.task.state,version:otherBefore.task.version}});
    expect((await root.query('SELECT state FROM task_attempts WHERE task_id=$1', [f.id])).rows[0]!.state).toBe('running');
  } finally {
    await root.query('UPDATE credit_reservations SET user_id=$2,task_id=$3 WHERE reservation_id=$1', [f.reservationId, f.userId, f.id]);
    await scheduler.recover();
  }
});

it('a ledger write failure rolls back the task, attempt and balance together', async () => {
  const f = await fixture({ state: 'running', attempt: 3 }), before = await snapshot(f);
  const client = await schedulerPool.connect();
  // Fault injection wraps a real Scheduler connection; all SQL and rollback run in PostgreSQL.
  const fault = new Proxy(client, { get(target, property) {
    if (property === 'query') return (sql: string, args?: unknown[]) => sql.includes('INSERT INTO credit_ledger_entries')
      ? Promise.reject(new Error('FIXTURE_LEDGER_UNAVAILABLE')) : target.query(sql, args);
    if (property === 'release') return () => {};
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const pool = { connect: async () => fault, query: schedulerPool.query.bind(schedulerPool) } as unknown as pg.Pool;
  try {
    await expect(new TaskScheduler(pool, { publish: async () => {} }).recover()).rejects.toThrow('FIXTURE_LEDGER_UNAVAILABLE');
    expect(await snapshot(f)).toEqual(before);
    expect((await root.query('SELECT state FROM task_attempts WHERE task_id=$1', [f.id])).rows[0]!.state).toBe('running');
  } finally { client.release(); }
  await scheduler.recover();
  expect(await snapshot(f)).toMatchObject({ task: { state: 'failed' }, reservation: { status: 'released' }, releases: 1 });
});

it('a broken reservation cannot roll back a healthy task or stop dispatch', async () => {
  const broken = await fixture({state:'running',attempt:3}), good = await fixture({state:'running',attempt:3});
  await fixture();
  await root.query('UPDATE credit_reservations SET task_id=$2 WHERE reservation_id=$1',[broken.reservationId,randomUUID()]);
  const before = await snapshot(broken), delivered:string[]=[];
  const isolated = new TaskScheduler(schedulerPool,{publish:async d=>{delivered.push(d.task_id);}});
  try {
    const result = await isolated.tick();
    expect(result.recoveryFailures).toContainEqual({taskId:broken.id,code:'TASK_RESERVATION_MISMATCH'});
    expect(await snapshot(broken)).toEqual(before);
    expect(await snapshot(good)).toMatchObject({task:{state:'failed'},reservation:{status:'released'},releases:1});
    expect(delivered.length).toBeGreaterThan(0);
  } finally {
    await root.query('UPDATE credit_reservations SET task_id=$2 WHERE reservation_id=$1',[broken.reservationId,broken.id]);
    await isolated.recover();
  }
});

it('walks past a full page of bad tasks without starving a later recoverable task', async () => {
  const bad = await fixture({state:'running',attempt:3});
  const ids:string[]=[];
  // All bad fixtures intentionally have a dangling reservation only in this ephemeral DB.
  const missing = randomUUID();
  for(let n=0;n<50;n++){
    const id=randomUUID();ids.push(id);
    await root.query(`INSERT INTO tasks(trace_id,id,user_id,workspace_id,kind,queue,state,attempt_no,max_attempts,reservation_id,updated_at)
      SELECT gen_random_uuid()::text,$1,user_id,workspace_id,kind,queue,'running',3,3,$3,$4 FROM tasks WHERE id=$2`,
    [id,bad.id,n===0?missing:randomUUID(),new Date(Date.now()-100000+n)]);
  }
  const good=await fixture({state:'running',attempt:3});
  const scanner=new TaskScheduler(schedulerPool,{publish:async()=>{}});
  try{
    expect((await scanner.recover()).failures).toHaveLength(50);
    expect((await snapshot(good)).task.state).toBe('running');
    await scanner.recover();
    expect(await snapshot(good)).toMatchObject({task:{state:'failed'},reservation:{status:'released'},releases:1});
  }finally{await root.query('DELETE FROM tasks WHERE id=ANY($1::uuid[])',[ids]);}
});

it('uses database wall time after a transaction starts, fencing an expired Worker lease', async () => {
  const f=await fixture(),a=(await engine.claim(f.id,randomUUID()))!;
  await root.query("UPDATE tasks SET lease_until=clock_timestamp()+interval '100 milliseconds' WHERE id=$1",[f.id]);
  await transaction(worker,async tx=>{
    await tx.query('SELECT pg_sleep(0.15)');
    expect(await lockOwnedAttemptTx(tx,a)).toBeUndefined();
  });
  expect(await engine.fail(a,'LATE_FAILURE',false)).toBe(false);
  expect(await engine.finish(a,'late result',0)).toBe(false);
  expect(await engine.markExternal(a,'late-external-intent')).toBe(false);
  expect(await engine.waitingExternal(a,'late-remote-receipt')).toBe(false);
  expect((await snapshot(f)).reservation.status).toBe('reserved');
  await scheduler.recover();
  expect((await snapshot(f)).task.state).toBe('queued');
});

it('commits and unlocks earlier recovered tasks while a later task waits on a database lock', async () => {
  const first=await fixture({state:'running',attempt:3}),second=await fixture({state:'running',attempt:3});
  const lot=(await root.query('SELECT lot_id FROM credit_reservation_lots WHERE reservation_id=$1',[second.reservationId])).rows[0]!.lot_id;
  const blocker=await api.connect();await blocker.query('BEGIN');
  await blocker.query('SELECT lot_id FROM credit_lots WHERE lot_id=$1 FOR UPDATE',[lot]);
  const recovering=new TaskScheduler(schedulerPool,{publish:async()=>{}}).recover();
  try{
    await vi.waitFor(async()=>{expect((await snapshot(first)).task.state).toBe('failed');},{timeout:2000,interval:10});
    expect((await snapshot(first)).reservation.status).toBe('released');
    expect((await root.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE NOWAIT',[first.id])).rowCount).toBe(1);
    expect((await snapshot(second)).task.state).toBe('running');
  }finally{await blocker.query('ROLLBACK');blocker.release();await recovering;}
  expect((await snapshot(second)).task.state).toBe('failed');
});

it('does not resurrect an expired lease after a heartbeat waits for a row lock', async () => {
  const f=await fixture(),a=(await engine.claim(f.id,randomUUID()))!;
  await root.query("UPDATE tasks SET lease_until=clock_timestamp()+interval '2 seconds' WHERE id=$1",[f.id]);
  const blocker=await api.connect(),sender=await worker.connect();
  const pid=(await sender.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await blocker.query('BEGIN');await blocker.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[f.id]);
  const heartbeat=new TaskEngine({query:sender.query.bind(sender)} as unknown as pg.Pool,60000).heartbeat(a);
  try{
    await vi.waitFor(async()=>{expect((await root.query('SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) waiting',[pid])).rows[0]!.waiting).toBe(true);},{timeout:1000,interval:10});
    expect((await root.query('SELECT lease_until>clock_timestamp() AS live FROM tasks WHERE id=$1',[f.id])).rows[0]!.live).toBe(true);
    await root.query('SELECT pg_sleep(greatest(0,extract(epoch FROM lease_until-clock_timestamp()))+0.03) FROM tasks WHERE id=$1',[f.id]);
    await blocker.query('COMMIT');
    expect(await heartbeat).toBe(false);
  }finally{await blocker.query('ROLLBACK');blocker.release();await heartbeat.catch(()=>{});sender.release();}
  expect((await root.query('SELECT lease_until>clock_timestamp() AS live FROM tasks WHERE id=$1',[f.id])).rows[0]!.live).toBe(false);
  await scheduler.recover();
  expect((await snapshot(f)).task.state).toBe('queued');
});

it('the migration grants only release columns, preserves relation indexes and adds no physical foreign keys', async () => {
  for (const [table, column] of [['credit_reservations', 'status'], ['credit_lots', 'available_credits'], ['credit_lots', 'reserved_credits']]) {
    expect((await schedulerPool.query('SELECT has_column_privilege(current_user,$1,$2,\'UPDATE\') AS allowed', [table, column])).rows[0]!.allowed).toBe(true);
  }
  await expect(schedulerPool.query('UPDATE credit_lots SET settled_credits=settled_credits WHERE false')).rejects.toMatchObject({ code: '42501' });
  await expect(schedulerPool.query("INSERT INTO credit_lots(lot_id,user_id) VALUES($1,$2)", [randomUUID(), randomUUID()])).rejects.toMatchObject({ code: '42501' });
  await expect(schedulerPool.query("INSERT INTO account_memberships(user_id) VALUES($1)", [randomUUID()])).rejects.toMatchObject({ code: '42501' });
  expect((await root.query("SELECT count(*)::int count FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.contype='f'")).rows[0]!.count).toBe(0);
  expect((await root.query(`SELECT count(*)::int count FROM pg_index WHERE indisvalid AND indrelid IN
    ('credit_reservations'::regclass,'credit_reservation_lots'::regclass,'credit_lots'::regclass)`)).rows[0]!.count).toBeGreaterThanOrEqual(6);
});
