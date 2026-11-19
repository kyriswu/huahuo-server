import { beforeAll, afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadTestConfig as loadConfig } from '../sms-fixture.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { migrate } from '../../src/db/migrate.js';
import { TaskService } from '../../src/modules/tasks/service.js';
import { QueuePublisher } from '../../src/modules/tasks/publisher.js';
import { createTaskWorkers } from '../../src/apps/worker.js';
import type { TaskWorkers } from '../../src/modules/tasks/queue.js';
import { insertFixtureUser, insertFixtureSession, testJwtEnv } from './jwt-fixture.js';
import { fixtureScopeHeaders } from './jwt-fixture.js';
import { buildApiServer } from '../../src/apps/api-server.js';
import { hash } from '../../src/modules/tasks/model.js';
import { TaskScheduler } from '../../src/modules/tasks/scheduler.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
if (!migrationUrl || !/^huahuo_test_/.test(new URL(migrationUrl).pathname.slice(1))) throw new Error('TEST_DB_REQUIRED');
const env = { ...process.env, ...testJwtEnv, APP_ENV: 'test', LOG_LEVEL: 'silent', APP_TOKEN_SECRET: 'test-'.repeat(12),
  APP_PUBLIC_BASE_URL: 'http://localhost:3000', ENABLE_DEMO_TASKS: 'true',
  REDIS_KEY_PREFIX: 'release-' + randomUUID(), WORKER_QUEUES: 'content', TASK_LEASE_MS: '5000' };
const apiConfig = loadConfig('api-server', { ...env, DATABASE_URL: process.env.TEST_DATABASE_API_URL });
const workerConfig = loadConfig('worker', { ...env, DATABASE_URL: process.env.TEST_DATABASE_WORKER_URL });
const schedulerConfig = loadConfig('scheduler', { ...env, DATABASE_URL: process.env.TEST_DATABASE_SCHEDULER_URL });
const root = poolFor(loadConfig('migrate', { DATABASE_URL: migrationUrl }));
const apiPool = poolFor(apiConfig), workerPool = poolFor(workerConfig), schedulerPool = poolFor(schedulerConfig);
const publisher = new QueuePublisher(schedulerConfig);
const service = new TaskService(apiPool, apiConfig.appTokenSecret!);
const scope = { userId: randomUUID(), sessionId: randomUUID(), traceId: 'release-drain-test' };
const workspaceId = randomUUID();
let bearer: string;
beforeAll(async () => {
  await migrate(loadConfig('migrate', { DATABASE_URL: migrationUrl }));
  await insertFixtureUser(root, scope.userId); bearer = await insertFixtureSession(root, scope.userId, scope.sessionId);
  await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'release fixture',true,$3)", [workspaceId, scope.userId, randomUUID()]);
}, 20000);
afterAll(async () => { await publisher.close(); await Promise.all([apiPool.end(), workerPool.end(), schedulerPool.end(), root.end()]); });

async function publish() {
  const id = (await service.create(scope, { workspaceId, text: 'release drain' }, randomUUID())).task.taskId;
  await deliver(id);
  return id;
}
async function deliver(id: string) {
  // Deliver only this fixture's outbox entry; the shared test DB also contains
  // unrelated fixtures. Scheduler claim/repair is covered by tasks.test.ts.
  const row = (await root.query('SELECT id,task_id,attempts FROM task_outbox WHERE task_id=$1', [id])).rows[0];
  await publisher.publish({ ...row, queue: 'content' });
}
async function state(id: string) { return (await root.query('SELECT state,attempt_no,lease_until,lease_until>now() AS leased FROM tasks WHERE id=$1', [id])).rows[0]; }
async function until(check: () => Promise<boolean>) {
  for (let n = 0; n < 400; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('RELEASE_DRAIN_TIMEOUT');
}

it('drains one worker with live lease renewal while a replacement finishes new work', async () => {
  // Deliberately longer than the retired ten-second exit deadline; no provider calls.
  workerConfig.testTaskDelayMs = 11000;
  const old = createTaskWorkers(workerPool, workerConfig);
  let replacement: TaskWorkers | undefined;
  try {
    const first = await publish();
    await until(async () => (await state(first)).state === 'running');
    const originalLease = (await state(first)).lease_until as Date;
    expect(old.activeJobs()).toBe(1);
    await old.drain();
    expect(old.healthy()).toBe(false);
    let closed = false;
    const closing = old.close().then(() => { closed = true; });
    const second = await publish();
    // Observe an actual renewal after draining, rather than depending on a
    // 1.2-second lease surviving host/VM startup jitter. Work exceeds two leases.
    await until(async () => (await state(first)).lease_until?.getTime() > originalLease.getTime());
    expect(closed).toBe(false);
    expect(await state(first)).toMatchObject({ state: 'running', leased: true, attempt_no: 1 });
    expect(await state(second)).toMatchObject({ state: 'queued', attempt_no: 0 });
    const nextConfig = loadConfig('worker', { ...env, DATABASE_URL: process.env.TEST_DATABASE_WORKER_URL });
    replacement = createTaskWorkers(workerPool, nextConfig);
    await until(async () => (await state(second)).state === 'succeeded');
    expect(closed).toBe(false);
    await closing;
    expect(old.activeJobs()).toBe(0);
    expect(await state(first)).toMatchObject({ state: 'succeeded', attempt_no: 1 });
    expect(await state(second)).toMatchObject({ state: 'succeeded', attempt_no: 1 });
  } finally { await old.close(); await replacement?.close(); }
}, 30000);

it('updates all shared-queue consumers before API handover, including late requests to the drained API', async () => {
  // Same code, separate instances: validates ordering and durable ownership,
  // not compatibility between two historical images or an external gateway.
  const roleConfig = (role: 'api-server' | 'worker') => loadConfig(role, {
    ...env, BILLING_MODE: 'disabled',
    DATABASE_URL: process.env[role === 'api-server' ? 'TEST_DATABASE_API_URL' : 'TEST_DATABASE_WORKER_URL'],
  });
  const oldApi = await buildApiServer({ config: roleConfig('api-server') });
  const nextApi = await buildApiServer({ config: roleConfig('api-server') });
  const oldWorkers = [createTaskWorkers(workerPool, roleConfig('worker')), createTaskWorkers(workerPool, roleConfig('worker'))];
  const nextConfig = roleConfig('worker');
  // Shorten only the fixture's delivery repair interval. Production remains 30s.
  const nextScheduler = new TaskScheduler(schedulerPool, publisher, randomUUID(), 50);
  let next: TaskWorkers | undefined;
  const accept = async (api: typeof oldApi, text: string, key = randomUUID()) => {
    const response = await api.inject({ method: 'POST', url: '/api/v1/tasks/demo',
      headers: { ...fixtureScopeHeaders(bearer), 'x-idempotency-key': key }, payload: { workspaceId, text } });
    expect(response.statusCode).toBe(200);
    return response.json().data.task.taskId as string;
  };
  try {
    await until(async () => oldWorkers.every(worker => worker.healthy()));
    const key = randomUUID(), text = 'accepted before worker update';
    const backlog = await accept(oldApi, text, key);
    expect(await state(backlog)).toMatchObject({ state: 'queued', attempt_no: 0 });

    next = createTaskWorkers(workerPool, nextConfig);
    await until(async () => next!.healthy());
    await Promise.all(oldWorkers.map(worker => worker.drain()));
    expect(oldWorkers.every(worker => !worker.healthy())).toBe(true);
    await nextScheduler.tick();

    await until(async () => (await nextApi.inject('/health/ready')).statusCode === 200);
    await oldApi.lifecycle.drain();
    expect((await oldApi.inject('/health/ready')).statusCode).toBe(503);
    expect((await oldApi.inject('/health/live')).statusCode).toBe(200);
    const late = await accept(oldApi, 'late request still routed to old API');
    const current = await accept(nextApi, 'request routed to replacement API');
    const ids = [backlog, late, current];
    await until(async () => {
      // Run the real PG recovery + outbox claim/publish/ack path. A delivery
      // fetched concurrently with pause may be acknowledged without a PG claim.
      await nextScheduler.tick();
      return (await root.query("SELECT count(*)::int n FROM tasks WHERE id=ANY($1::uuid[]) AND state='succeeded'", [ids])).rows[0].n === ids.length;
    }).catch(async error => {
      const tasks = (await root.query('SELECT id,state,attempt_no,error_code,lease_owner FROM tasks WHERE id=ANY($1::uuid[])', [ids])).rows;
      const jobs = await Promise.all(ids.map(async id => {
        const row = (await root.query('SELECT id,status FROM task_outbox WHERE task_id=$1', [id])).rows[0];
        const job = await publisher.queues.get('content')!.getJob(row.id);
        return { taskId: id, outbox: row.status, queueState: await job?.getState(), failure: job?.failedReason };
      }));
      throw new Error(JSON.stringify({ tasks, jobs, nextHealthy: next?.healthy() }), { cause: error });
    });
    const attempts = (await root.query('SELECT task_id,attempt_no,owner FROM task_attempts WHERE task_id=ANY($1::uuid[])', [ids])).rows;
    expect(attempts).toHaveLength(ids.length);
    expect(attempts.every(attempt => attempt.attempt_no === 1 && attempt.owner === nextConfig.instanceId)).toBe(true);
    expect(await accept(nextApi, text, key)).toBe(backlog);
    const result = await nextApi.inject({ url: `/api/v1/tasks/${backlog}/result`, headers: { ...fixtureScopeHeaders(bearer) } });
    expect(result.statusCode).toBe(200);
    expect(result.json().data).toMatchObject({ taskId: backlog, digest: hash(text), byteCount: Buffer.byteLength(text) });
    expect((await root.query('SELECT count(*)::int n FROM task_results WHERE task_id=ANY($1::uuid[])', [ids])).rows[0].n).toBe(ids.length);
  } finally {
    await Promise.all(oldWorkers.map(worker => worker.close())); await next?.close();
    await Promise.all([oldApi.close(), nextApi.close()]);
  }
}, 30000);
