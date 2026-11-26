import { randomUUID } from 'node:crypto';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { migrate } from '../../src/db/migrate.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { transaction } from '../../src/modules/identity/store.js';
import { enqueueIntent, funAsrTaskKind, funAsrTaskReference, type TaskRow } from '../../src/modules/tasks/model.js';
import { TaskEngine } from '../../src/modules/tasks/engine.js';
import { QueuePublisher } from '../../src/modules/tasks/publisher.js';
import { TaskScheduler, type Delivery } from '../../src/modules/tasks/scheduler.js';
import { deferTaskAttemptTx, wakeExternalTaskTx } from '../../src/modules/tasks/external-continuation.js';
import { lockOwnedAttemptTx } from '../../src/modules/tasks/lifecycle.js';

const database = process.env.TEST_DATABASE_MIGRATION_URL, redisUrl = process.env.REDIS_QUEUE_URL;
if (!database || !/^huahuo_test_[a-z0-9_]+$/u.test(new URL(database).pathname.slice(1))
  || new URL(database).hostname !== '127.0.0.1' || !redisUrl || new URL(redisUrl).hostname !== '127.0.0.1'
  || Number(new URL(redisUrl).pathname.slice(1)) < 10) throw new Error('ISOLATED_DEPENDENCIES_REQUIRED');
const env = { APP_ENV: 'test', LOG_LEVEL: 'silent', REDIS_CACHE_URL: process.env.REDIS_CACHE_URL, REDIS_QUEUE_URL: redisUrl };
const migrationConfig = loadConfig('migrate', { DATABASE_URL: database });
const root = poolFor(migrationConfig);
const schedulerPool = poolFor(loadConfig('scheduler', { ...env, DATABASE_URL: process.env.TEST_DATABASE_SCHEDULER_URL }));
const workerPool = poolFor(loadConfig('worker', { ...env, DATABASE_URL: process.env.TEST_DATABASE_WORKER_URL }));
const engine = new TaskEngine(workerPool, 15000);
const asrEngine = new TaskEngine(workerPool, 15000, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, { execute: async attempt => attempt.task.kind === funAsrTaskKind });
let publisher: QueuePublisher, scheduler: TaskScheduler, second: TaskScheduler, prefix: string;
const taskIds: string[] = [], workers: Worker[] = [], connections: Redis[] = [];

beforeAll(() => migrate(migrationConfig));
beforeEach(() => {
  prefix = 'delivery-repair-' + randomUUID();
  publisher = new QueuePublisher(loadConfig('scheduler', { ...env, DATABASE_URL: process.env.TEST_DATABASE_SCHEDULER_URL, REDIS_KEY_PREFIX: prefix }));
  scheduler = new TaskScheduler(schedulerPool, publisher);
  second = new TaskScheduler(schedulerPool, publisher);
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.close(true)));
  connections.splice(0).forEach(connection => connection.disconnect());
  await publisher.close();
  for (const table of ['task_outbox', 'task_attempts', 'task_events', 'task_results']) {
    await root.query(`DELETE FROM ${table} WHERE task_id=ANY($1::uuid[])`, [taskIds]);
  }
  await root.query('DELETE FROM tasks WHERE id=ANY($1::uuid[])', [taskIds]);
  taskIds.length = 0;
});
afterAll(() => Promise.all([root.end(), schedulerPool.end(), workerPool.end()]));

async function task(withIntent = true, kind = 'maintenance.check') {
  const id = randomUUID(); taskIds.push(id);
  // Give this fixture priority over unrelated tasks in the shared isolated DB.
  await root.query(`INSERT INTO tasks(id,kind,queue,state,trace_id,created_at)
    VALUES($1,$2,'maintenance','queued',$3,'1900-01-01')`, [id, kind, randomUUID()]);
  if (withIntent) {
    await transaction(schedulerPool, tx => enqueueIntent(tx, id));
    await root.query("UPDATE task_outbox SET created_at='1900-01-01' WHERE task_id=$1", [id]);
  }
  return id;
}
async function asrTask() {
  const id = randomUUID(); taskIds.push(id);
  await root.query(`INSERT INTO tasks(id,user_id,kind,queue,state,trace_id,created_at,max_attempts,external_reference)
    VALUES($1,$2,$3,'content','queued',$4,'1900-01-01',1,$5)`,
  [id, randomUUID(), funAsrTaskKind, randomUUID(), funAsrTaskReference(id)]);
  return id;
}
async function deliveries(id: string) {
  return (await root.query<Delivery & { status: string }>(`SELECT o.id,o.task_id,o.attempts,o.status,t.queue
    FROM task_outbox o JOIN tasks t ON t.id=o.task_id WHERE task_id=$1 ORDER BY o.created_at,o.id`, [id])).rows;
}
async function sent(delivery: Delivery) {
  await publisher.publish(delivery);
  await root.query("UPDATE task_outbox SET status='sent',sent_at=now()-interval '1 minute' WHERE id=$1", [delivery.id]);
}
async function repair(id: string) {
  await root.query("UPDATE task_outbox SET sent_at=now()-interval '1 minute' WHERE task_id=$1 AND status='sent'", [id]);
  await Promise.all([scheduler.recover(), second.recover()]);
}
async function dispatch(id: string) {
  const delivery = await scheduler.claim(); expect(delivery?.task_id).toBe(id);
  await publisher.publish(delivery!); await scheduler.acknowledge(delivery!);
}
async function redisJobs(id: string) {
  return (await publisher.queues.get('maintenance')!.getJobs(['wait', 'active', 'delayed', 'completed', 'failed']))
    .filter(job => job.data.taskId === id);
}
function manualWorker() {
  const connection = publisher.connection.duplicate({ maxRetriesPerRequest: null }); connections.push(connection);
  const worker = new Worker('maintenance', undefined, { connection, prefix, autorun: false }); workers.push(worker);
  return worker;
}

describe('delivery repair with real isolated PostgreSQL and Redis', () => {
  it('keeps one outbox row and one waiting Redis job across repeated concurrent repair rounds', async () => {
    const id = await task(), delivery = (await deliveries(id))[0]!;
    await sent(delivery);
    for (let round = 0; round < 5; round++) {
      await repair(id);
      expect(await deliveries(id)).toEqual([expect.objectContaining({ id: delivery.id, status: 'pending' })]);
      await Promise.all([scheduler.dispatch(), second.dispatch()]);
      expect(await deliveries(id)).toEqual([expect.objectContaining({ id: delivery.id, status: 'sent', attempts: round + 1 })]);
      expect((await redisJobs(id)).map(job => job.id)).toEqual([delivery.id]);
    }
    expect((await root.query('SELECT state,attempt_no FROM tasks WHERE id=$1', [id])).rows[0]).toEqual({ state: 'queued', attempt_no: 0 });
  });

  it('rearms only the latest successful delivery and creates an intent when no sent history exists', async () => {
    const id = await task(), latest = (await deliveries(id))[0]!, older = randomUUID();
    await sent(latest);
    await root.query(`INSERT INTO task_outbox(id,task_id,status,sent_at,created_at)
      VALUES($1,$2,'sent',now()-interval '2 minutes','1899-01-01')`, [older, id]);
    await Promise.all([scheduler.recover(), second.recover()]);
    expect(await deliveries(id)).toEqual([
      expect.objectContaining({ id: older, status: 'sent' }), expect.objectContaining({ id: latest.id, status: 'pending' }),
    ]);
    const missing = await task(false);
    await Promise.all([scheduler.recover(), second.recover()]);
    expect(await deliveries(missing)).toEqual([expect.objectContaining({ task_id: missing, status: 'pending' })]);
  });

  it.each(['completed', 'failed'] as const)('requeues a retained %s Redis job when PG work was never claimed', async state => {
    const id = await task(), delivery = (await deliveries(id))[0]!;
    await sent(delivery);
    const worker = manualWorker(), token = randomUUID(), job = await worker.getNextJob(token, { block: false });
    expect(job.id).toBe(delivery.id);
    if (state === 'completed') await job.moveToCompleted(null, token, false);
    else await job.moveToFailed(new Error('before PG claim'), token, false);
    expect(await job.getState()).toBe(state);
    await repair(id); await dispatch(id);
    expect(await job.getState()).toBe('waiting');
    expect((await redisJobs(id)).map(item => item.id)).toEqual([delivery.id]);
    const nextToken = randomUUID(), next = await worker.getNextJob(nextToken, { block: false });
    expect(next.id).toBe(delivery.id);
    const attempt = await engine.claim(id, randomUUID()); expect(attempt).not.toBeNull();
    expect(await engine.execute(attempt!)).toBe(true);
    await next.moveToCompleted(null, nextToken, false);
    expect((await root.query('SELECT count(*)::int n FROM task_results WHERE task_id=$1', [id])).rows[0].n).toBe(1);
    expect(await deliveries(id)).toHaveLength(1);
  });

  it('preserves active and delayed deliveries and recreates a lost Redis job with the same ID', async () => {
    const id = await task(), delivery = (await deliveries(id))[0]!;
    await sent(delivery);
    const worker = manualWorker(), token = randomUUID(), job = await worker.getNextJob(token, { block: false });
    await repair(id); await dispatch(id); expect(await job.getState()).toBe('active');
    await job.moveToDelayed(Date.now() + 60_000, token);
    await repair(id); await dispatch(id); expect(await job.getState()).toBe('delayed');
    expect(await redisJobs(id)).toHaveLength(1);
    await job.remove(); await repair(id); await dispatch(id);
    expect((await publisher.queues.get('maintenance')!.getJob(delivery.id))?.data).toEqual({ taskId: id });
    expect(await deliveries(id)).toHaveLength(1);
  });

  it('keeps automatic retries and external continuations as new explicit intents', async () => {
    for (const kind of ['maintenance.check', 'processing.node-start']) {
      const id = await task(true, kind), first = (await deliveries(id))[0]!;
      await sent(first);
      const attempt = (await engine.claim(id, randomUUID()))!;
      if (kind === 'maintenance.check') await engine.fail(attempt, 'TEMPORARY_FAILURE', true);
      else {
        await engine.markExternal(attempt, 'node-start:' + randomUUID());
        await engine.defer(attempt, 0);
      }
      const intents = await deliveries(id);
      expect(intents).toHaveLength(2);
      expect(intents.find(delivery => delivery.id === first.id)?.status).toBe('sent');
      const next = intents.find(delivery => delivery.status === 'pending')!; expect(next.id).not.toBe(first.id);
      await repair(id); expect(await deliveries(id)).toEqual(intents);
      await root.query('UPDATE tasks SET available_at=now() WHERE id=$1', [id]);
      const claimed = (await engine.claim(id, randomUUID()))!;
      expect(claimed.attempt).toBe(2); expect(claimed.task.resume_count).toBe(kind === 'maintenance.check' ? 0 : 1);
    }
  });

  it('keeps a deferred ASR attempt idle until its outbox is brought forward by a callback', async () => {
    const id = await asrTask();
    expect(await engine.claim(id, randomUUID())).toBeNull();
    const first = (await asrEngine.claim(id, randomUUID()))!;
    expect(first.task.resume_count).toBe(0);
    await transaction(workerPool, async tx => {
      const row = (await lockOwnedAttemptTx(tx, first))!;
      await deferTaskAttemptTx(tx, row, first, 120_000);
    });
    expect(await asrEngine.claim(id, randomUUID())).toBeNull();
    expect(await deliveries(id)).toHaveLength(1);
    await transaction(workerPool, async tx => {
      const row = (await tx.query<TaskRow>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
      expect(await wakeExternalTaskTx(tx, row)).toBe(true);
    });
    expect(await deliveries(id)).toHaveLength(1);
    const resumed = (await asrEngine.claim(id, randomUUID()))!;
    expect(resumed.task.attempt_no - resumed.task.resume_count).toBe(1);
    expect(await asrEngine.execute(resumed)).toBe(true);
  });

  it('repairs an expired ASR attempt and any lost delivery for its deferred continuation', async () => {
    const id = await asrTask();
    await asrEngine.claim(id, randomUUID());
    await root.query("UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1", [id]);
    await Promise.all([scheduler.recover(), second.recover()]);
    expect(await deliveries(id)).toEqual([expect.objectContaining({task_id:id,status:'pending'})]);
    const resumed = (await asrEngine.claim(id, randomUUID()))!;
    expect(resumed.task.resume_count).toBe(1);
    await transaction(workerPool, async tx => {
      const row = (await lockOwnedAttemptTx(tx, resumed))!;
      await deferTaskAttemptTx(tx, row, resumed, 60_000);
    });
    await root.query('DELETE FROM task_outbox WHERE task_id=$1', [id]);
    await root.query("UPDATE tasks SET available_at=now()-interval '1 second' WHERE id=$1", [id]);
    await Promise.all([scheduler.recover(), second.recover()]);
    expect(await deliveries(id)).toEqual([expect.objectContaining({task_id:id,status:'pending'})]);
    expect((await asrEngine.claim(id, randomUUID()))?.task.resume_count).toBe(2);
  });
});
