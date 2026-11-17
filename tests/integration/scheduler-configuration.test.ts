import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Redis } from 'ioredis';
import { loadTestConfig as loadConfig } from '../sms-fixture.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { migrate } from '../../src/db/migrate.js';
import { RuntimeSettings, currentRuntimeConfig } from '../../src/modules/runtime-settings/service.js';
import { TaskScheduler, type TaskPublisher } from '../../src/modules/tasks/scheduler.js';
import { enqueueIntent } from '../../src/modules/tasks/model.js';
import { transaction } from '../../src/modules/identity/store.js';
import { buildApiServer } from '../../src/apps/api-server.js';
import { buildAdminServer } from '../../src/apps/admin.js';
import { hashPassword } from '../../src/modules/identity/crypto.js';
import { fixtureScopeHeaders, insertFixtureSession, insertFixtureUser, testJwtEnv } from './jwt-fixture.js';

const database = process.env.TEST_DATABASE_MIGRATION_URL;
const redisUrl = process.env.REDIS_QUEUE_URL;
if (!database || !/^huahuo_test_/.test(new URL(database).pathname.slice(1))
  || !redisUrl || new URL(redisUrl).hostname !== '127.0.0.1' || Number(new URL(redisUrl).pathname.slice(1)) < 10) {
  throw new Error('ISOLATED_DEPENDENCIES_REQUIRED');
}
const env = {
  ...testJwtEnv, APP_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_SSL_MODE: 'disable',
  APP_TOKEN_SECRET: 'scheduler-api-fixture-'.repeat(3), ADMIN_SESSION_SECRET: 'scheduler-admin-fixture-'.repeat(3),
  APP_PUBLIC_BASE_URL: 'http://scheduler-api.test', ADMIN_PUBLIC_BASE_URL: 'http://scheduler-admin.test',
  REDIS_CACHE_URL: process.env.REDIS_CACHE_URL, REDIS_QUEUE_URL: redisUrl,
  REDIS_KEY_PREFIX: 'scheduler_config_' + randomUUID().replaceAll('-', ''),
  PROCESSING_NODES_ENABLED: 'false', PROCESSING_NODES_CLOUD_CONTROL_ENABLED: 'false',
  PROVIDER_MODE: 'disabled', RAG_PROVIDER_MODE: 'disabled', RAG_RERANK_PROVIDER: 'disabled',
  BILLING_MODE: 'disabled', ENABLE_DEMO_TASKS: 'true', METRICS_ENABLED: 'false',
};
const config = loadConfig('scheduler', { ...env, DATABASE_URL: process.env.TEST_DATABASE_SCHEDULER_URL });
const root = poolFor(loadConfig('migrate', { DATABASE_URL: database }));
const pool = poolFor(config);
const settings = new RuntimeSettings(pool, config);
const accepted: TaskPublisher = { publish: async () => undefined };
const userId = randomUUID(), sessionId = randomUUID(), workspaceId = randomUUID();
const taskIds: string[] = [], scheduleIds: string[] = [], nodeIds: string[] = [];
let bearer = '';
let originalValues: Record<string, unknown>;
let originalSchedules: Array<{ id: string; enabled: boolean }>;

async function policy(values: Record<string, unknown>) {
  await root.query('UPDATE runtime_configuration SET "values"="values" || $1::jsonb,revision=revision+1 WHERE singleton=true', [JSON.stringify(values)]);
}
async function schedule() {
  const id = 'scheduler-config-' + randomUUID(); scheduleIds.push(id);
  await root.query('INSERT INTO task_schedules(id,interval_seconds) VALUES($1,3600)', [id]);
  return id;
}
async function scheduledTask(id: string) {
  return (await root.query('SELECT t.* FROM tasks t JOIN task_schedule_windows w ON w.task_id=t.id WHERE w.schedule_id=$1', [id])).rows[0];
}
async function pendingTask(maxAttempts = 4, attempts = 0) {
  const id = randomUUID(); taskIds.push(id);
  // Sort this fixture ahead of records left by other independent integration files.
  await root.query(`INSERT INTO tasks(id,kind,queue,state,max_attempts,trace_id,created_at)
    VALUES($1,'maintenance.check','maintenance','queued',$2,$3,now()-interval '30 days')`, [id, maxAttempts, randomUUID()]);
  await transaction(pool, tx => enqueueIntent(tx, id));
  await root.query("UPDATE task_outbox SET attempts=$2,created_at=now()-interval '30 days' WHERE task_id=$1", [id, attempts]);
  return id;
}
async function nextDelay(id: string) {
  return Number((await root.query('SELECT extract(epoch FROM available_at-clock_timestamp())*1000 AS ms FROM task_outbox WHERE task_id=$1', [id])).rows[0].ms);
}
async function until(check: () => Promise<boolean>, child?: ReturnType<typeof spawn>) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error('SCHEDULER_FIXTURE_EXITED');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('SCHEDULER_FIXTURE_TIMEOUT');
}

beforeAll(async () => {
  await migrate(loadConfig('migrate', { DATABASE_URL: database }));
  originalValues = (await root.query('SELECT "values" FROM runtime_configuration WHERE singleton=true')).rows[0].values;
  originalSchedules = (await root.query<{ id: string; enabled: boolean }>('SELECT id,enabled FROM task_schedules')).rows;
  await root.query('UPDATE task_schedules SET enabled=false');
  await insertFixtureUser(root, userId); bearer = await insertFixtureSession(root, userId, sessionId);
  await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'scheduler config fixture',true,$3)", [workspaceId, userId, randomUUID()]);
}, 20000);

afterEach(async () => {
  await root.query('UPDATE runtime_configuration SET "values"=$1,revision=revision+1 WHERE singleton=true', [JSON.stringify(originalValues)]);
  const ids = (await root.query<{ id: string }>(`SELECT id FROM tasks WHERE id=ANY($1::uuid[]) OR user_id=$2
    OR id IN (SELECT task_id FROM task_schedule_windows WHERE schedule_id=ANY($3::text[]))
    OR external_reference=ANY($4::text[])`, [taskIds, userId, scheduleIds, nodeIds.map(id => 'node-start:' + id)])).rows.map(row => row.id);
  for (const table of ['task_outbox', 'task_attempts', 'task_events', 'task_results', 'storage_jobs']) {
    await root.query(`DELETE FROM ${table} WHERE task_id=ANY($1::uuid[])`, [ids]);
  }
  await root.query('DELETE FROM task_schedule_windows WHERE schedule_id=ANY($1::text[])', [scheduleIds]);
  await root.query('DELETE FROM task_schedules WHERE id=ANY($1::text[])', [scheduleIds]);
  await root.query('DELETE FROM tasks WHERE id=ANY($1::uuid[])', [ids]);
  await root.query('DELETE FROM task_inputs WHERE user_id=$1', [userId]);
  await root.query('DELETE FROM processing_node_assignments WHERE node_id=ANY($1::uuid[])', [nodeIds]);
  await root.query('DELETE FROM processing_nodes WHERE id=ANY($1::uuid[])', [nodeIds]);
  taskIds.length = scheduleIds.length = nodeIds.length = 0;
});

afterAll(async () => {
  for (const row of originalSchedules ?? []) await root.query('UPDATE task_schedules SET enabled=$2 WHERE id=$1', [row.id, row.enabled]);
  await root.query('DELETE FROM api_idempotency WHERE scope=$1 OR scope=$2', [userId, userId + ':' + workspaceId]);
  await root.query('DELETE FROM user_audit_events WHERE user_id=$1', [userId]);
  await root.query('DELETE FROM user_sessions WHERE user_id=$1', [userId]);
  await root.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
  await root.query('DELETE FROM users WHERE id=$1', [userId]);
  await Promise.all([pool.end(), root.end()]);
});

it('uses the current round policy for scheduled maintenance tasks', async () => {
  await policy({ 'tasks.maxAttempts': 6 });
  const scheduleId = await schedule();
  const scheduler = new TaskScheduler(pool, accepted);
  await settings.run(() => scheduler.schedules());
  expect((await scheduledTask(scheduleId)).max_attempts).toBe(6);
});

it('applies the API creation policy and keeps an unclaimed task budget during delivery repair', async () => {
  await policy({ 'tasks.maxAttempts': 4 });
  const api = await buildApiServer({ config: loadConfig('api-server', { ...env, DATABASE_URL: process.env.TEST_DATABASE_API_URL }) });
  try {
    const response = await api.inject({ method: 'POST', url: '/api/v1/tasks/demo', headers: { ...fixtureScopeHeaders(bearer), 'x-idempotency-key': randomUUID() }, payload: { workspaceId, text: 'policy fixture' } });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().data.task.taskId as string;
    expect((await root.query('SELECT max_attempts FROM tasks WHERE id=$1', [id])).rows[0].max_attempts).toBe(4);
    await root.query("UPDATE tasks SET created_at=now()-interval '30 days' WHERE id=$1", [id]);
    await root.query('DELETE FROM task_outbox WHERE task_id=$1', [id]);
    await policy({ 'tasks.maxAttempts': 7 });
    await settings.run(() => new TaskScheduler(pool, accepted).recover());
    expect((await root.query('SELECT max_attempts,version,attempt_no FROM tasks WHERE id=$1', [id])).rows[0]).toMatchObject({ max_attempts: 4, version: 1, attempt_no: 0 });
    expect((await root.query('SELECT count(*)::int n FROM task_outbox WHERE task_id=$1', [id])).rows[0].n).toBe(1);
  } finally { await api.close(); }
});

it('uses configured retry base and cap for failed Redis delivery, including jitter', async () => {
  await policy({ 'tasks.retryBaseMs': 12000, 'tasks.retryMaxMs': 15000 });
  const failed: TaskPublisher = { publish: async () => { throw new Error('fixture queue unavailable'); } };
  const first = await pendingTask();
  await settings.run(() => new TaskScheduler(pool, failed).dispatch());
  expect(await nextDelay(first)).toBeGreaterThan(8500); expect(await nextDelay(first)).toBeLessThanOrEqual(15000);
  const capped = await pendingTask(4, 10);
  await settings.run(() => new TaskScheduler(pool, failed).dispatch());
  expect(await nextDelay(capped)).toBeGreaterThan(10750); expect(await nextDelay(capped)).toBeLessThanOrEqual(18750);
});

it('keeps one snapshot across a configuration edit in a round and refreshes the next round', async () => {
  await policy({ 'tasks.maxAttempts': 4, 'tasks.retryBaseMs': 12000, 'tasks.retryMaxMs': 15000 });
  const firstId = await pendingTask(), firstSchedule = await schedule();
  let calls = 0;
  const publisher: TaskPublisher = { publish: async () => {
    calls++;
    if (calls === 1) await policy({ 'tasks.maxAttempts': 7, 'tasks.retryBaseMs': 30000, 'tasks.retryMaxMs': 30000 });
    throw new Error('fixture queue unavailable');
  } };
  const scheduler = new TaskScheduler(pool, publisher);
  await settings.run(() => scheduler.tick());
  expect((await scheduledTask(firstSchedule)).max_attempts).toBe(4);
  expect(await nextDelay(firstId)).toBeGreaterThan(8500); expect(await nextDelay(firstId)).toBeLessThanOrEqual(15000);
  expect(currentRuntimeConfig()).toBeUndefined();
  await root.query("UPDATE task_outbox SET available_at=now(),created_at=now()-interval '30 days' WHERE task_id=$1", [firstId]);
  const secondSchedule = await schedule();
  await settings.run(() => scheduler.tick());
  expect((await scheduledTask(secondSchedule)).max_attempts).toBe(7);
  expect(await nextDelay(firstId)).toBeGreaterThan(22000); expect(await nextDelay(firstId)).toBeLessThanOrEqual(37500);
});

it('does not create or deliver work when the round configuration is invalid', async () => {
  const scheduleId = await schedule(), id = await pendingTask();
  await policy({ 'tasks.maxAttempts': 99 });
  let deliveries = 0;
  const scheduler = new TaskScheduler(pool, { publish: async () => { deliveries++; } });
  await expect(settings.run(() => scheduler.tick())).rejects.toMatchObject({ code: 'CONFIGURATION_INVALID' });
  expect(deliveries).toBe(0); expect(await scheduledTask(scheduleId)).toBeUndefined();
  expect((await root.query('SELECT status,attempts FROM task_outbox WHERE task_id=$1', [id])).rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
});

it('wires runtime snapshots and configuration-error recovery into the actual Scheduler entrypoint', async () => {
  await policy({ 'tasks.maxAttempts': 99 });
  const scheduleId = await schedule();
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_PORT_REQUIRED');
  const port = address.port; await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  // The runner supplies isolated dependency URLs; never inherit model/cloud secrets.
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'TZ', 'VOLTA_HOME']) if (process.env[key]) childEnv[key] = process.env[key];
  Object.assign(childEnv, env, { DATABASE_URL: process.env.TEST_DATABASE_SCHEDULER_URL, HOST: '127.0.0.1', PORT: String(port), SCHEDULER_INTERVAL_MS: '100' });
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/entrypoints/scheduler.ts'], { env: childEnv, stdio: 'ignore' });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  try {
    await until(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel(); return response.status === 200;
      } catch { return false; }
    }, child);
    const readiness = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(1000) });
    expect(readiness.status).toBe(503); await readiness.body?.cancel();
    expect(await scheduledTask(scheduleId)).toBeUndefined();
    await policy({ 'tasks.maxAttempts': 8 });
    await until(async () => Boolean(await scheduledTask(scheduleId)), child);
    expect((await scheduledTask(scheduleId)).max_attempts).toBe(8);
  } finally {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { expect(await exited).toBe(0); } finally { clearTimeout(timer); }
    const redis = new Redis(redisUrl!, { maxRetriesPerRequest: 0 }); redis.on('error', () => undefined);
    try { const keys = await redis.keys(env.REDIS_KEY_PREFIX + ':*'); if (keys.length) await redis.del(...keys); } finally { redis.disconnect(); }
  }
}, 15000);

it('uses the runtime creation policy for an Admin node-start request without executing cloud work', async () => {
  await policy({ 'tasks.maxAttempts': 5 });
  const nodeId = randomUUID(), adminId = randomUUID(), username = 'scheduler-' + adminId;
  nodeIds.push(nodeId);
  const password = 'scheduler-fixture-password';
  await root.query("INSERT INTO admin_users(id,username,password_hash,role) VALUES($1,$2,$3,'superadmin')", [adminId, username, await hashPassword(password)]);
  await root.query('INSERT INTO processing_nodes(id,config,revision) VALUES($1,$2,1)', [nodeId, JSON.stringify({
    name: 'fixture node', capabilities: ['document'], resourceClass: 'cpu', mode: 'ecs',
    regionId: 'cn-beijing', instanceId: 'i-fixture123456', privateIp: '172.18.0.2', baseUrl: 'http://172.18.0.2:8000',
    healthPath: '/health', tokenEnv: null, concurrency: 1, idleSeconds: 60, startupSeconds: 60, queueSeconds: 60, enabled: true,
  })]);
  const admin = await buildAdminServer({ config: loadConfig('admin', { ...env, PROCESSING_NODES_CLOUD_CONTROL_ENABLED: 'true', DATABASE_URL: process.env.TEST_DATABASE_ADMIN_URL }) });
  try {
    const login = await admin.inject({ method: 'POST', url: '/admin/api/v1/login', headers: { origin: env.ADMIN_PUBLIC_BASE_URL }, payload: { username, password } });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const response = await admin.inject({ method: 'POST', url: '/admin/api/v1/processing-nodes/' + nodeId + '/start', headers: { cookie, origin: env.ADMIN_PUBLIC_BASE_URL, 'x-csrf-token': login.json().data.csrfToken } });
    expect(response.statusCode, response.body).toBe(202);
    expect((await root.query('SELECT state,max_attempts,attempt_no FROM tasks WHERE id=$1', [response.json().data.taskId])).rows[0]).toMatchObject({ state: 'queued', max_attempts: 5, attempt_no: 0 });
  } finally {
    await admin.close();
    await root.query('DELETE FROM admin_audit_events WHERE admin_id=$1', [adminId]);
    await root.query('DELETE FROM admin_sessions WHERE admin_id=$1', [adminId]);
    await root.query('DELETE FROM admin_users WHERE id=$1', [adminId]);
  }
});
