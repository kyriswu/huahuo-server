import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../../src/config/config.js';
import { migrate } from '../../src/db/migrate.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { ApplicationMetrics, listenMetrics, closeMetrics } from '../../src/plugins/metrics.js';
import { TaskEngine } from '../../src/modules/tasks/engine.js';
import { QueuePublisher } from '../../src/modules/tasks/publisher.js';
import { createTaskWorkers } from '../../src/apps/worker.js';
import { hash, queues, type QueueName } from '../../src/modules/tasks/model.js';
import { insertFixtureUser } from './jwt-fixture.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL;
if (!migrationUrl || !/^huahuo_test_/.test(new URL(migrationUrl).pathname.slice(1))) throw new Error('TEST_DB_REQUIRED');
const cfg = loadConfig('worker', { ...process.env, APP_ENV: 'test', LOG_LEVEL: 'silent',
  DATABASE_URL: process.env.TEST_DATABASE_WORKER_URL, REDIS_KEY_PREFIX: 'metrics-' + randomUUID() });
const migrator = loadConfig('migrate', { DATABASE_URL: migrationUrl });
const root = poolFor(migrator), workerPool = poolFor(cfg);
const userId = randomUUID(), workspaceId = randomUUID();
const total = (body: string, kind: string, result: string) => body.split('\n')
  .filter(line => line.startsWith('task_processing_attempts_total{') && line.includes(`kind="${kind}"`) && line.includes(`result="${result}"`))
  .reduce((sum, line) => sum + Number(line.split(' ').at(-1)), 0);
const terminalTotal=(body:string,state:string)=>body.split('\n').filter(line=>line.startsWith('task_terminal_total{')&&line.includes(`state="${state}"`)).reduce((sum,line)=>sum+Number(line.split(' ').at(-1)),0);
async function queued(kind = 'maintenance.check', queue: QueueName = 'maintenance') {
  const id = randomUUID();
  await root.query(`INSERT INTO tasks(trace_id,id,kind,queue,state,user_id,workspace_id,created_at)
    VALUES(gen_random_uuid()::text,$1,$2,$3,'queued',$4,$5,now()-interval '1 second')`, [id, kind, queue, userId, workspaceId]);
  return id;
}
beforeAll(async () => {
  await migrate(migrator); await insertFixtureUser(root, userId);
  await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'metrics fixture',true,$3)", [workspaceId, userId, randomUUID()]);
}, 20000);
afterAll(async () => { await Promise.all([root.end(), workerPool.end()]); });

it('counts committed attempt results once, excluding rollback, expired leases, duplicates and unknown external outcomes', async () => {
  const metrics = new ApplicationMetrics(cfg);
  const engine = new TaskEngine(workerPool, 60000, undefined, undefined, undefined, undefined, undefined, undefined, undefined, metrics);
  const listener = await listenMetrics(metrics, '127.0.0.1', 0);
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/metrics`;
  try {
    const before = await (await fetch(url)).text(); expect(total(before, 'maintenance.check', 'success')).toBe(0);
    const first = (await engine.claim(await queued(), randomUUID()))!;
    await expect(engine.finish(first, hash('rollback'), 0, async () => { throw new Error('ROLLBACK_PROBE'); })).rejects.toThrow('ROLLBACK_PROBE');
    expect((await root.query('SELECT state FROM tasks WHERE id=$1', [first.task.id])).rows[0].state).toBe('running');
    expect(total(await (await fetch(url)).text(), 'maintenance.check', 'success')).toBe(0);
    expect(terminalTotal(await (await fetch(url)).text(),'succeeded')).toBe(0);
    expect(await engine.finish(first, hash('committed'), 0)).toBe(true);
    expect(await engine.finish(first, hash('duplicate'), 0)).toBe(false);
    expect((await root.query('SELECT state FROM tasks WHERE id=$1', [first.task.id])).rows[0].state).toBe('succeeded');

    const failed = (await engine.claim(await queued(), randomUUID()))!;
    expect(await engine.fail(failed, 'TEST_FINAL_FAILURE', false)).toBe(true);
    expect(await engine.fail(failed, 'TEST_DUPLICATE_FAILURE', false)).toBe(false);
    expect((await root.query('SELECT state FROM tasks WHERE id=$1', [failed.task.id])).rows[0].state).toBe('failed');
    const unknown = (await engine.claim(await queued(), randomUUID()))!;
    expect(await engine.markExternal(unknown, 'test-unknown')).toBe(true);
    expect(await engine.fail(unknown, 'TEST_EXTERNAL_UNKNOWN', true)).toBe(true);
    expect((await root.query('SELECT state FROM tasks WHERE id=$1', [unknown.task.id])).rows[0].state).toBe('reconciling');
    const expired = (await engine.claim(await queued(), randomUUID()))!;
    await root.query("UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1", [expired.task.id]);
    expect(await engine.finish(expired, hash('expired'), 0)).toBe(false);
    const after = await (await fetch(url)).text();
    expect(total(after, 'maintenance.check', 'success')).toBe(1);
    expect(total(after, 'maintenance.check', 'failure')).toBe(1);
    expect(terminalTotal(after,'succeeded')).toBe(1);expect(terminalTotal(after,'failed')).toBe(1);expect(terminalTotal(after,'cancelled')).toBe(0);
    expect(after.split('\n').filter(line=>line.startsWith('task_terminal_duration_seconds_count{')).reduce((sum,line)=>sum+Number(line.split(' ').at(-1)),0)).toBe(2);
    expect(after).not.toContain(first.task.id);
  } finally { await closeMetrics(listener); }
});

it('scrapes every BullMQ consumer across two worker runtimes without merging away either worker', async () => {
  const firstMetrics = new ApplicationMetrics(cfg), secondMetrics = new ApplicationMetrics(cfg);
  const first = createTaskWorkers(workerPool, { ...cfg, instanceId: randomUUID(), workerQueues: ['content', 'ai'] }, firstMetrics);
  const second = createTaskWorkers(workerPool, { ...cfg, instanceId: randomUUID(), workerQueues: ['commercial', 'maintenance'] }, secondMetrics);
  const publisher = new QueuePublisher(cfg);
  const one = await listenMetrics(firstMetrics, '127.0.0.1', 0), two = await listenMetrics(secondMetrics, '127.0.0.1', 0);
  const read = async (server: typeof one) => (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/metrics`)).text();
  try {
    const tasks = [];
    for (const queue of queues) {
      const id = await queued('maintenance.check', queue); tasks.push({ id, expected: 'succeeded' });
      await publisher.queues.get(queue)!.add('execute', { taskId: id }, { jobId: randomUUID(), removeOnComplete: true });
    }
    const unsupported = await queued('private-kind-' + randomUUID(), 'content'); tasks.push({ id: unsupported, expected: 'failed' });
    await publisher.queues.get('content')!.add('execute', { taskId: unsupported }, { jobId: randomUUID(), removeOnComplete: true });
    const deadline = Date.now() + 15000;
    while (true) {
      const rows: { id: string; state: string }[] = (await root.query('SELECT id,state FROM tasks WHERE id=ANY($1::uuid[])', [tasks.map(t => t.id)])).rows;
      if (tasks.every(t => rows.some(row => row.id === t.id && row.state === t.expected))) break;
      if (Date.now() > deadline) throw new Error('METRICS_WORKER_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const [a, b] = await Promise.all([read(one), read(two)]);
    expect(total(a, 'maintenance.check', 'success')).toBe(2);
    expect(total(b, 'maintenance.check', 'success')).toBe(2);
    expect(total(a, 'other', 'failure')).toBe(1);
    expect(total(b, 'other', 'failure')).toBe(0);
    expect(a).not.toContain('private-kind-');
    expect(first.workers).toHaveLength(2); expect(second.workers).toHaveLength(2);
  } finally {
    await Promise.all([first.close(), second.close()]); await publisher.close();
    await Promise.all([closeMetrics(one), closeMetrics(two)]);
  }
}, 25000);
