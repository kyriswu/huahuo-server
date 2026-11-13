import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { createServer } from 'node:http';
import { loadDocumentParserMachineConfig, type EcsDocumentParserConfig, type EnabledDocumentParserMachineConfig } from '../../src/config/document-parser-machine.js';
import { EcsPowerError, type EcsInstance, type EcsPowerPort } from '../../src/integrations/ecs-power.js';
import { DocumentParserMachine, ParserExecutionError, ParserMachineRedis, type ParserRequest } from '../../src/lib/document-parser-machine/index.js';
import { ParserMachineIdleMonitor } from '../../src/lib/document-parser-machine/monitor.js';

// Real Redis/Lua and two real clients; ECS/HTTP are controlled doubles, never live paid calls.
const url = process.env.REDIS_QUEUE_URL;
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname) || Number(new URL(url).pathname.slice(1)) < 10) throw new Error('REAL_ISOLATED_TEST_REDIS_REQUIRED');
const redis = new Redis(url, { maxRetriesPerRequest: 0, lazyConnect: true, enableOfflineQueue: false });
const otherRedis = new Redis(url, { maxRetriesPerRequest: 0, lazyConnect: true, enableOfflineQueue: false });
redis.on('error', () => undefined); otherRedis.on('error', () => undefined);
const prefixes: string[] = [];
beforeAll(async () => { await Promise.all([redis.connect(), otherRedis.connect()]); });
afterAll(async () => {
  for (const prefix of prefixes) {
    const keys = await redis.keys(`${prefix}:document-parser:{single}:*`);
    if (keys.length) await redis.del(...keys);
  }
  redis.disconnect(); otherRedis.disconnect();
});
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const request = (): ParserRequest => ({ requestId: randomUUID(), fingerprint: sha('document-revision-and-parser-options') });
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
class Cloud implements EcsPowerPort {
  describes = 0; starts = 0; stops = 0; autoStart = true;
  beforeDescribe?: () => Promise<void>;
  startError?: EcsPowerError; stopError?: EcsPowerError;
  instance: EcsInstance = {
    instanceId: 'i-integration12345', regionId: 'cn-beijing', instanceType: 'ecs.gn7i-c16g1.4xlarge',
    status: 'Running', chargeType: 'PostPaid', networkType: 'vpc', vpcId: 'vpc-test', privateIps: ['172.18.102.101'],
    localStorageAmount: 0, localStorageCapacity: 0, operationLocked: false,
  };
  async describe() { this.describes++; await this.beforeDescribe?.(); return { ...this.instance }; }
  async start() {
    this.starts++; if (this.startError) throw this.startError;
    this.instance.status = this.autoStart ? 'Running' : 'Starting';
  }
  async stopEconomically() { this.stops++; if (this.stopError) throw this.stopError; this.instance.status = 'Stopping'; }
}
function setup(overrides: Partial<EcsDocumentParserConfig> = {}, cloud = new Cloud()) {
  const loaded = loadDocumentParserMachineConfig({
    DOCUMENT_PARSER_MODE: 'ecs', DOCUMENT_PARSER_ECS_REGION_ID: 'cn-beijing', DOCUMENT_PARSER_ECS_INSTANCE_ID: cloud.instance.instanceId,
    DOCUMENT_PARSER_ECS_PRIVATE_IP: '172.18.102.101', ALIYUN_RAM_ACCESS_KEY_ID: 'test-ak', ALIYUN_RAM_ACCESS_KEY_SECRET: 'test-secret',
  });
  if (!loaded.enabled || loaded.mode !== 'ecs') throw new Error('TEST_CONFIG_REQUIRED');
  const config: EcsDocumentParserConfig = { ...loaded, pollMs: 5, startupTimeoutMs: 1000, queueTimeoutMs: 2000, ...overrides };
  const prefix = `test_parser_${randomUUID().replaceAll('-', '')}`; prefixes.push(prefix);
  const state = new ParserMachineRedis(redis, config, prefix);
  const state2 = new ParserMachineRedis(otherRedis, config, prefix);
  return { config, prefix, cloud, state, state2, machine: new DocumentParserMachine(state, cloud, config, async () => true), other: new DocumentParserMachine(state2, cloud, config, async () => true) };
}
async function age(state: ParserMachineRedis, milliseconds = 61000) {
  const [seconds, micros] = await redis.time();
  await redis.hset(`${state.keyPrefix}:state`, 'lastActivity', Number(seconds) * 1000 + Math.floor(Number(micros) / 1000) - milliseconds);
}
async function expire(state: ParserMachineRedis, input: ParserRequest) {
  const id = sha(input.requestId), key = `${state.keyPrefix}:jobs`;
  const raw = await redis.hget(key, id); if (!raw) throw new Error('TEST_REQUEST_MISSING');
  const job = JSON.parse(raw); job.expires = 1; await redis.hset(key, id, JSON.stringify(job));
}

describe('single document parser coordination: real isolated Redis, mock ECS/HTTP', () => {
  it('deduplicates simultaneous deliveries and completed deliveries across clients', async () => {
    const s = setup(), input = request(), started = deferred(), finish = deferred();
    const parse = vi.fn(async () => { started.resolve(); await finish.promise; return 'parsed'; });
    const first = s.machine.withDocumentParser(input, parse);
    await started.promise;
    try {
      await expect(s.other.withDocumentParser(input, parse)).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_DUPLICATE', requestState: 'active' });
      await expect(s.other.withDocumentParser({ ...input, fingerprint: sha('different') }, parse)).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_CONFLICT' });
    } finally { finish.resolve(); }
    expect(await first).toBe('parsed');
    await expect(s.other.withDocumentParser(input, parse)).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_DUPLICATE', requestState: 'succeeded' });
    expect(parse).toHaveBeenCalledTimes(1); expect(s.cloud.starts).toBe(0);
  });
  it.each([1, 2])('enforces %i shared slots with FIFO waiting across two real clients', async concurrency => {
    const s = setup({ concurrency }), releases = Array.from({ length: 4 }, () => deferred());
    let active = 0, maximum = 0;
    const started: number[] = [];
    const operations: Promise<number>[] = [];
    for (let i = 0; i < 4; i++) {
      operations.push((i % 2 ? s.other : s.machine).withDocumentParser(request(), async () => {
        active++; maximum = Math.max(maximum, active); started.push(i); await releases[i]!.promise; active--; return i;
      }));
      await vi.waitFor(async () => { const state = await s.state.status(); expect((state?.queued ?? 0) + (state?.active ?? 0)).toBe(i + 1); }, { interval: 5 });
    }
    await vi.waitFor(() => expect(started.length).toBe(concurrency), { interval: 5 });
    expect(maximum).toBe(concurrency);
    for (let i = 0; i < 4; i++) {
      releases[i]!.resolve();
      await vi.waitFor(() => expect(started).toContain(Math.min(3, i + concurrency)), { interval: 5 });
    }
    expect(await Promise.all(operations)).toEqual([0, 1, 2, 3]); expect(started).toEqual([0, 1, 2, 3]);
    expect(maximum).toBe(concurrency);
  });
  it('starts a stopped instance exactly once and waits for Running and service readiness', async () => {
    const s = setup({ concurrency: 2 }); s.cloud.instance.status = 'Stopped'; s.cloud.autoStart = false;
    let healthy = false;
    const health = vi.fn(async () => healthy), parse = vi.fn(async () => 'ok');
    const a = new DocumentParserMachine(s.state, s.cloud, s.config, health);
    const b = new DocumentParserMachine(s.state2, s.cloud, s.config, health);
    const first = a.withDocumentParser(request(), parse), second = b.withDocumentParser(request(), parse);
    await vi.waitFor(() => expect(s.cloud.starts).toBe(1), { interval: 5 });
    expect(parse).not.toHaveBeenCalled(); expect(health).not.toHaveBeenCalled();
    s.cloud.instance.status = 'Running';
    await vi.waitFor(() => expect(health).toHaveBeenCalled(), { interval: 5 }); expect(parse).not.toHaveBeenCalled();
    healthy = true;
    await Promise.all([first, second]); expect(s.cloud.starts).toBe(1); expect(parse).toHaveBeenCalledTimes(2);
  });
  it('counts idle time from completion and checks exact stopped billing mode asynchronously', async () => {
    const s = setup(), started = deferred(), finish = deferred();
    const operation = s.machine.withDocumentParser(request(), async () => { started.resolve(); await finish.promise; });
    await started.promise;
    await age(s.state); expect(await s.machine.tick()).toBe('busy'); expect(s.cloud.stops).toBe(0);
    finish.resolve(); await operation;
    expect(await s.machine.tick()).toBe('busy');
    await age(s.state, 59000); expect(await s.machine.tick()).toBe('busy');
    await age(s.state); expect(await s.machine.tick()).toBe('stop_submitted');
    expect((await s.state.status())?.phase).toBe('stopping');
    expect(await s.other.tick()).toBe('transition_pending'); expect(s.cloud.stops).toBe(1);
    s.cloud.instance.status = 'Stopped'; s.cloud.instance.stoppedMode = 'StopCharging';
    expect(await s.other.tick()).toBe('stop_confirmed'); expect((await s.state.status())?.phase).toBe('ready');
  });
  it('does not stop while requests are queued', async () => {
    const s = setup(), input = request();
    await s.state.register(sha(input.requestId), 'queued-owner', input.fingerprint);
    await age(s.state);
    expect(await s.machine.tick()).toBe('busy'); expect(s.cloud.describes).toBe(0); expect(s.cloud.stops).toBe(0);
  });
  it('lets a request arriving during DescribeInstances prevent the subsequent stop', async () => {
    const s = setup(); await s.machine.withDocumentParser(request(), async () => 'done'); await age(s.state);
    const arriving = request();
    s.cloud.beforeDescribe = async () => { s.cloud.beforeDescribe = undefined; await s.state2.register(sha(arriving.requestId), 'new-owner', arriving.fingerprint); };
    expect(await s.machine.tick()).toBe('busy'); expect(s.cloud.stops).toBe(0);
  });
  it('queues arrivals after stop intent and restarts only after stop confirmation', async () => {
    const s = setup(); await s.machine.withDocumentParser(request(), async () => 'done'); await age(s.state);
    expect(await s.machine.tick()).toBe('stop_submitted');
    const parse = vi.fn(async () => 'new-result'), next = s.other.withDocumentParser(request(), parse);
    await vi.waitFor(async () => expect((await s.state.status())?.queued).toBe(1), { interval: 5 });
    expect(parse).not.toHaveBeenCalled(); expect(s.cloud.starts).toBe(0);
    s.cloud.instance.status = 'Stopped'; s.cloud.instance.stoppedMode = 'StopCharging';
    expect(await next).toBe('new-result'); expect(s.cloud.starts).toBe(1); expect(s.cloud.stops).toBe(1);
    expect((await s.state.status())?.economicallyStopped).toBe(false);
  });
  it('reclaims an expired queued owner without ever reclaiming expired active work', async () => {
    const s = setup(), queued = request(), active = request();
    await s.state.register(sha(queued.requestId), 'dead-queued', queued.fingerprint); await expire(s.state, queued);
    await s.state2.register(sha(queued.requestId), 'replacement', queued.fingerprint);
    await expect(s.state.renew(sha(queued.requestId), 'dead-queued')).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_LEASE_LOST' });
    await s.state.finish(sha(queued.requestId), 'replacement', queued.fingerprint, 'cancelled');
    await s.state.register(sha(active.requestId), 'dead-active', active.fingerprint);
    expect(await s.state.claim(sha(active.requestId), 'dead-active')).toBe(true); await expire(s.state, active);
    await age(s.state);
    expect(await s.machine.tick()).toBe('busy'); expect((await s.state.status())?.uncertain).toBe(1);
    await expect(s.other.withDocumentParser(request(), async () => 'bad')).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_UNCERTAIN' });
    expect(s.cloud.stops).toBe(0);
    await s.machine.acknowledgeSettled(active); expect((await s.state.status())?.active).toBe(0);
  });
  it('keeps an ambiguous remote HTTP failure occupying its slot until explicitly reconciled', async () => {
    const s = setup(), input = request();
    await expect(s.machine.withDocumentParser(input, async () => { throw new Error('timeout signed-url secret'); })).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_EXECUTION_UNKNOWN' });
    expect(await s.state.status()).toMatchObject({ active: 1, uncertain: 1 }); await age(s.state);
    expect(await s.machine.tick()).toBe('busy');
    await expect(s.other.withDocumentParser(input, async () => 'bad')).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_DUPLICATE', requestState: 'unknown' });
    await s.machine.acknowledgeSettled(input); expect(await s.state.status()).toMatchObject({ active: 0, uncertain: 0 });
    expect(s.cloud.stops).toBe(0);
  });
  it('releases a definitively completed failure and retains its dedup receipt', async () => {
    const s = setup(), input = request();
    await expect(s.machine.withDocumentParser(input, async () => { throw new ParserExecutionError('PARSER_REJECTED_DOCUMENT', 'settled'); })).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_EXECUTION_FAILED' });
    expect((await s.state.status())?.active).toBe(0);
    await expect(s.other.withDocumentParser(input, async () => 'bad')).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_DUPLICATE', requestState: 'failed' });
  });
  it('reconciles ambiguous startup without ever blindly resending StartInstance', async () => {
    const s = setup({ startupTimeoutMs: 50 }); s.cloud.instance.status = 'Stopped';
    s.cloud.startError = new EcsPowerError('ECS_API_FAILED', 'unknown'); const input = request();
    await expect(s.machine.withDocumentParser(input, async () => 'bad')).rejects.toMatchObject({ code: 'ECS_API_FAILED' });
    expect((await s.state.status())?.phase).toBe('unknown-start'); s.cloud.startError = undefined;
    await expect(s.other.withDocumentParser(input, async () => 'bad')).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_STARTUP_TIMEOUT' });
    expect(s.cloud.starts).toBe(1);
    s.cloud.instance.status = 'Running';
    expect(await s.machine.withDocumentParser(input, async () => 'reconciled')).toBe('reconciled'); expect(s.cloud.starts).toBe(1);
  });
  it('permits a safe startup retry only after a definitive cloud rejection', async () => {
    const s = setup(); s.cloud.instance.status = 'Stopped'; s.cloud.startError = new EcsPowerError('ECS_API_FAILED', 'rejected', 'OperationDenied.NoStock');
    const input = request();
    await expect(s.machine.withDocumentParser(input, async () => 'bad')).rejects.toMatchObject({ providerCode: 'OperationDenied.NoStock' });
    expect((await s.state.status())?.phase).toBe('ready'); s.cloud.startError = undefined;
    expect(await s.other.withDocumentParser(input, async () => 'ok')).toBe('ok'); expect(s.cloud.starts).toBe(2);
  });
  it('does not resend an ambiguous stop or start while that stop is unresolved', async () => {
    const s = setup(); await s.machine.withDocumentParser(request(), async () => 'done'); await age(s.state);
    s.cloud.stopError = new EcsPowerError('ECS_API_FAILED', 'unknown');
    await expect(s.machine.tick()).rejects.toMatchObject({ outcome: 'unknown' });
    expect(await s.other.tick()).toBe('transition_pending'); expect(s.cloud.stops).toBe(1);
    const controller = new AbortController(), input = { ...request(), signal: controller.signal };
    const next = s.machine.withDocumentParser(input, async () => 'bad');
    const assertion = expect(next).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_CANCELLED' });
    await vi.waitFor(async () => expect((await s.state.status())?.queued).toBe(1), { interval: 5 });
    expect(s.cloud.starts).toBe(0); controller.abort(); await assertion;
    s.cloud.instance.status = 'Stopped'; s.cloud.instance.stoppedMode = 'StopCharging';
    expect(await s.machine.tick()).toBe('stop_confirmed');
  });
  it('never calls a normal charged stop economical-stop success', async () => {
    const s = setup(); await s.machine.withDocumentParser(request(), async () => 'done'); await age(s.state);
    await s.machine.tick(); s.cloud.instance.status = 'Stopped'; s.cloud.instance.stoppedMode = 'KeepCharging';
    await expect(s.other.tick()).rejects.toMatchObject({ code: 'ECS_STOP_NOT_ECONOMICAL' });
    expect((await s.state.status())?.phase).toBe('blocked');
    await expect(s.machine.withDocumentParser(request(), async () => 'bad')).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_UNCERTAIN' });
  });
  it('fails closed on a disconnected real Redis client without touching the cloud or parser', async () => {
    const s = setup(), disconnected = new Redis(url!, { maxRetriesPerRequest: 0, enableOfflineQueue: false, lazyConnect: true });
    disconnected.on('error', () => undefined); await disconnected.connect(); disconnected.disconnect();
    const state = new ParserMachineRedis(disconnected, s.config, s.prefix), machine = new DocumentParserMachine(state, s.cloud, s.config);
    const parse = vi.fn(async () => 'bad');
    await expect(machine.withDocumentParser(request(), parse)).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_REDIS_UNAVAILABLE' });
    await expect(machine.tick()).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_REDIS_UNAVAILABLE' });
    expect(parse).not.toHaveBeenCalled(); expect(s.cloud.describes).toBe(0);
  });
  it('enforces queue bounds and configuration consistency instead of silently changing global capacity', async () => {
    const s = setup({ maxPending: 1 }), first = request(), second = request();
    await s.state.register(sha(first.requestId), 'one', first.fingerprint);
    await expect(s.state2.register(sha(second.requestId), 'two', second.fingerprint)).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_QUEUE_FULL' });
    const different = new ParserMachineRedis(otherRedis, { ...s.config, concurrency: 2 }, s.prefix);
    await expect(different.register(sha(second.requestId), 'two', second.fingerprint)).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_CONFIG_MISMATCH' });
    await expect(different.configureWhenIdle()).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_BUSY' });
  });
  it('switches an idle deployment to a permanent API while keeping shared deduplication and zero cloud mutations', async () => {
    const s = setup(), completed = request(); await s.machine.withDocumentParser(completed, async () => 'done');
    const loaded = loadDocumentParserMachineConfig({ DOCUMENT_PARSER_MODE: 'always-on', DOCUMENT_PARSER_BASE_URL: 'https://parser.example.test/v2', DOCUMENT_PARSER_API_TOKEN: 'test-token' });
    if (!loaded.enabled) throw new Error('TEST_CONFIG_REQUIRED');
    const config: EnabledDocumentParserMachineConfig = { ...loaded, pollMs: 5 };
    const state = new ParserMachineRedis(otherRedis, config, s.prefix);
    await state.configureWhenIdle();
    const machine = new DocumentParserMachine(state, s.cloud, config, async () => true), before = { starts: s.cloud.starts, stops: s.cloud.stops, describes: s.cloud.describes };
    await expect(machine.withDocumentParser(completed, async () => 'bad')).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_DUPLICATE' });
    const result = await machine.withDocumentParser(request(), async ({ baseUrl, headers }) => ({ baseUrl, authenticated: headers.Authorization === 'Bearer test-token' }));
    expect(result).toEqual({ baseUrl: 'https://parser.example.test/v2', authenticated: true });
    await age(state); expect(await machine.tick()).toBe('always_on');
    expect({ starts: s.cloud.starts, stops: s.cloud.stops, describes: s.cloud.describes }).toEqual(before);
    await expect(s.machine.tick()).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_CONFIG_MISMATCH' });
  });
  it('does not treat missing machine metadata as idle or operate an unmanaged instance', async () => {
    const s = setup(); expect(await s.machine.tick()).toBe('unmanaged'); expect(s.cloud.describes).toBe(0);
    const input = request(); await s.state.register(sha(input.requestId), 'one', input.fingerprint);
    await redis.del(`${s.state.keyPrefix}:state`);
    await expect(s.machine.tick()).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_STATE_MISSING' });
    expect(s.cloud.stops).toBe(0);
  });
  it('renews queued and active leases during a long parse instead of reclaiming either slot', async () => {
    const s = setup({ leaseMs: 6000, queueTimeoutMs: 10000 }), entered = deferred(), finish = deferred();
    const renew = vi.spyOn(s.state, 'renew'), renewOther = vi.spyOn(s.state2, 'renew');
    const first = s.machine.withDocumentParser(request(), async () => { entered.resolve(); await finish.promise; return 'first'; });
    await entered.promise;
    const second = s.other.withDocumentParser(request(), async () => 'second');
    const completion=Promise.allSettled([first,second]);
    const before=await redis.hgetall(`${s.state.keyPrefix}:jobs`);
    try{
      await vi.waitFor(() => { expect(renew.mock.calls.length).toBeGreaterThanOrEqual(2); expect(renewOther.mock.calls.length).toBeGreaterThanOrEqual(1); }, { timeout: 5000, interval: 20 });
      expect(await s.state.status()).toMatchObject({ active: 1, queued: 1, uncertain: 0 });
      const after=await redis.hgetall(`${s.state.keyPrefix}:jobs`);
      for(const[id,record]of Object.entries(before))expect(JSON.parse(after[id]!).expires).toBeGreaterThan(JSON.parse(record).expires);
    }finally{finish.resolve();await completion;}
    expect(await completion).toEqual([{status:'fulfilled',value:'first'},{status:'fulfilled',value:'second'}]);
  },10000);
  it('aborts on heartbeat ownership loss and retains the remote request as uncertain', async () => {
    const s = setup({ leaseMs: 1200 }), input = request(), entered = deferred();
    let callbackSignal: AbortSignal | undefined;
    const operation = s.machine.withDocumentParser(input, async ({ signal }) => {
      callbackSignal = signal; entered.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('CLIENT_ABORT_IS_NOT_SERVER_CANCELLATION')), { once: true }));
    });
    const assertion = expect(operation).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_EXECUTION_UNKNOWN' });
    await entered.promise; await expire(s.state, input);
    await assertion; expect(callbackSignal?.aborted).toBe(true);
    expect(await s.state.status()).toMatchObject({ active: 1, uncertain: 1 }); expect(s.cloud.stops).toBe(0);
  });
  it('does not stop or delete another owner lock if the control lease is lost during cloud lookup', async () => {
    const s = setup(); await s.machine.withDocumentParser(request(), async () => 'done'); await age(s.state);
    s.cloud.beforeDescribe = async () => {
      s.cloud.beforeDescribe = undefined;
      await otherRedis.set(`${s.state.keyPrefix}:control`, 'replacement-owner', 'PX', 30000);
    };
    await expect(s.machine.tick()).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_LOCK_LOST' });
    expect(s.cloud.stops).toBe(0); expect(await redis.get(`${s.state.keyPrefix}:control`)).toBe('replacement-owner');
  });
  it('does not infer idleness from a partially lost active index', async () => {
    const s = setup(), input = request();
    await s.state.register(sha(input.requestId), 'one', input.fingerprint); await s.state.claim(sha(input.requestId), 'one');
    await redis.del(`${s.state.keyPrefix}:active`); await age(s.state);
    await expect(s.machine.tick()).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_STATE_INCONSISTENT' }); expect(s.cloud.stops).toBe(0);
  });
  it.each([false, true])('checks the configured HTTP readiness endpoint and never follows redirects (redirect=%s)', async redirect => {
    const calls: string[] = [], authenticated: boolean[] = [];
    const server = createServer((req, res) => {
      calls.push(req.url ?? ''); authenticated.push(req.headers.authorization === 'Bearer test-token');
      if (redirect && req.url === '/ready') { res.writeHead(302, { Location: '/must-not-follow' }); res.end(); }
      else { res.writeHead(200); res.end('ready'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (address === null || typeof address === 'string') throw new Error('TEST_ADDRESS_REQUIRED');
      const config = loadDocumentParserMachineConfig({ DOCUMENT_PARSER_MODE: 'always-on', DOCUMENT_PARSER_BASE_URL: `http://127.0.0.1:${address.port}/api`, DOCUMENT_PARSER_HEALTH_PATH: '/ready', DOCUMENT_PARSER_API_TOKEN: 'test-token' });
      if (!config.enabled) throw new Error('TEST_CONFIG_REQUIRED');
      const tuned = { ...config, pollMs: 5, startupTimeoutMs: 100 };
      const prefix = `test_parser_${randomUUID().replaceAll('-', '')}`; prefixes.push(prefix);
      const machine = new DocumentParserMachine(new ParserMachineRedis(redis, tuned, prefix), undefined, tuned), parse = vi.fn(async () => 'parsed');
      if (redirect) {
        await expect(machine.withDocumentParser(request(), parse)).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_STARTUP_TIMEOUT' });
        expect(parse).not.toHaveBeenCalled();
      } else expect(await machine.withDocumentParser(request(), parse)).toBe('parsed');
      expect(calls.length).toBeGreaterThan(0); expect(calls.every(path => path === '/ready')).toBe(true);
      expect(authenticated.every(Boolean)).toBe(true);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it('wakes the idle deadline through real Redis Pub/Sub and persists verified sleep until the next request', async () => {
    const s = setup({ idleMs: 80 }), subscriber = redis.duplicate({ lazyConnect: true });
    subscriber.on('error', () => undefined);
    const errors: unknown[] = [];
    const monitor = new ParserMachineIdleMonitor(s.machine, subscriber, s.state.eventsChannel, 80, { onError: error => errors.push(error) });
    await monitor.start();
    try {
      await s.machine.withDocumentParser(request(), async () => 'parsed');
      await vi.waitFor(() => expect(s.cloud.stops).toBe(1), { interval: 5, timeout: 2000 });
      s.cloud.instance.status = 'Stopped'; s.cloud.instance.stoppedMode = 'StopCharging';
      expect(await s.machine.tick()).toBe('stop_confirmed');
      expect((await s.state.status())?.economicallyStopped).toBe(true);
      await s.other.withDocumentParser(request(), async () => 'next-document');
      expect((await s.state.status())?.economicallyStopped).toBe(false);
      await vi.waitFor(() => expect(s.cloud.stops).toBe(2), { interval: 5, timeout: 2000 });
      expect(s.cloud.starts).toBe(1); expect(errors).toHaveLength(0);
    } finally { await monitor.close(); }
  });
  it('removes a cancelled admission from the waiting queue without submitting it',async()=>{
    const s=setup(),entered=deferred(),finish=deferred(),controller=new AbortController();
    const first=s.machine.withDocumentParser(request(),async()=>{entered.resolve();await finish.promise;});await entered.promise;
    const parse=vi.fn(async()=> 'must-not-submit');
    const second=s.other.withDocumentParser({...request(),admissionSignal:controller.signal},parse);
    const done=expect(second).rejects.toMatchObject({code:'DOCUMENT_PARSER_CANCELLED'});
    try{await vi.waitFor(async()=>expect((await s.state.status())?.queued).toBe(1),{interval:5});controller.abort();await done;
      expect((await s.state.status())?.queued).toBe(0);expect(parse).not.toHaveBeenCalled();
    }finally{finish.resolve();await first;}
  });
  it('keeps submitted work and its slot alive after admission cancellation until a remote result settles it',async()=>{
    const s=setup(),entered=deferred(),finish=deferred(),controller=new AbortController();let remoteSignal:AbortSignal|undefined;
    const task=s.machine.withDocumentParser({...request(),admissionSignal:controller.signal},async({signal})=>{remoteSignal=signal;entered.resolve();await finish.promise;return 'terminal';});
    await entered.promise;controller.abort();expect(remoteSignal?.aborted).toBe(false);expect((await s.state.status())?.active).toBe(1);
    finish.resolve();expect(await task).toBe('terminal');expect((await s.state.status())?.active).toBe(0);
  });
});
