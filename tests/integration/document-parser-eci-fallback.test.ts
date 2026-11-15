import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { createDocumentParserConfig, type EcsDocumentParserConfig } from '../../src/config/document-parser-machine.js';
import {createDocumentParserEciConfig,singleA10InstanceTypes} from '../../src/config/document-parser-eci.js';
import { EcsPowerError, type EcsInstance, type EcsPowerPort } from '../../src/integrations/ecs-power.js';
import { EciProviderError, type GpuInstanceRef, type GpuInstanceSnapshot, type PreparedGpuSpotSpec } from '../../src/integrations/gpu-spot/types.js';
import { allocationHash, digest } from '../../src/integrations/gpu-spot/spec.js';
import { DocumentParserMachine, ParserMachineRedis } from '../../src/lib/document-parser-machine/index.js';
import type { ParserEciProvider } from '../../src/lib/document-parser-machine/eci-fallback.js';

// Real isolated Redis/Lua, two independent owners; all paid cloud and parser endpoints are doubles.
const url = process.env.REDIS_QUEUE_URL;
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname) || Number(new URL(url).pathname.slice(1)) < 10) throw new Error('REAL_ISOLATED_TEST_REDIS_REQUIRED');
const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false });
const otherRedis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false });
const prefixes: string[] = [];
redis.on('error', () => undefined); otherRedis.on('error', () => undefined);
beforeAll(async () => { await Promise.all([redis.connect(), otherRedis.connect()]); });
afterAll(async () => {
  for (const prefix of prefixes) {
    const keys = await redis.keys(`${prefix}:document-parser:{single}:*`);
    if (keys.length) await redis.del(...keys);
  }
  redis.disconnect(); otherRedis.disconnect();
});
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const request = () => ({ requestId: randomUUID(), fingerprint: sha('document+config') });
const stockError = () => new EcsPowerError('ECS_API_FAILED', 'rejected', 'OperationDenied.NoStock');
class Ecs implements EcsPowerPort {
  starts = 0; stops = 0; error?: EcsPowerError = stockError();
  instance: EcsInstance = {
    regionId: 'cn-beijing', instanceId: 'i-fallbacktest123', instanceType: 'ecs.gn7i-c16g1.4xlarge',
    status: 'Stopped', stoppedMode: 'StopCharging', chargeType: 'PostPaid', spotStrategy: 'NoSpot',
    networkType: 'vpc', vpcId: 'vpc-test', privateIps: ['172.18.102.101'],
    localStorageAmount: 0, localStorageCapacity: 0, operationLocked: false,
  };
  async describe() { return { ...this.instance }; }
  async start() { this.starts++; if (this.error) throw this.error; this.instance.status = 'Running'; }
  async stopEconomically() { this.stops++; this.instance.status = 'Stopped'; this.instance.stoppedMode = 'StopCharging'; }
}
class Eci implements ParserEciProvider {
  creates = 0; finds = 0; releases = 0; tokens: string[] = [];
  snapshot: GpuInstanceSnapshot | null = null;
  failures: EciProviderError[] = [];
  acceptBeforeFailure = false; visible = true; ready = true;
  deleteError?: EciProviderError;
  beforeRelease?: () => Promise<void>;
  seed(spec: { regionId: string; vpcId: string }, ownerHash: string) {
    this.snapshot = { ...spec, containerGroupId: `eci-fallback${this.creates}`, allocationHash: ownerHash,
      status: 'Running', spotStrategy: 'NoSpot', instanceType: 'ecs.gn7i-c8g1.2xlarge', privateIp: '172.18.102.202',
      containersReady: this.ready, reclaiming: false, eventReasons: [] };
  }
  async create(spec: PreparedGpuSpotSpec, token: string, ownerHash: string) {
    this.creates++; this.tokens.push(token);
    const failure = this.failures.shift();
    if (!failure || this.acceptBeforeFailure) this.seed(spec, ownerHash);
    if (failure) throw failure;
    return { containerGroupId: this.snapshot!.containerGroupId, requestId: 'create-request' };
  }
  async findByAllocation(spec: { regionId: string; vpcId: string }, ownerHash: string) {
    this.finds++;
    return this.visible && this.snapshot?.allocationHash === ownerHash
      ? { ...spec, containerGroupId: this.snapshot.containerGroupId, allocationHash: ownerHash } : null;
  }
  async describe(ref: GpuInstanceRef) {
    if (!this.visible || !this.snapshot) return null;
    if (ref.allocationHash !== this.snapshot.allocationHash) throw new EciProviderError('fatal', 'AllocationOwnershipMismatch');
    return { ...this.snapshot };
  }
  async release(ref: GpuInstanceRef) {
    if (ref.allocationHash !== this.snapshot?.allocationHash) throw new EciProviderError('fatal', 'AllocationOwnershipMismatch');
    this.releases++; await this.beforeRelease?.();
    if (this.deleteError) { this.snapshot = null; throw this.deleteError; }
    this.snapshot = null;
  }
}
function setup(options: { concurrency?: number; timeout?: number; health?: (context: { baseUrl: string }) => Promise<boolean> } = {}) {
  const cloud = new Ecs(), eci = new Eci();
  const loaded=createDocumentParserConfig({mode:'ecs',regionId:'cn-beijing',instanceId:cloud.instance.instanceId,privateIp:'172.18.102.101',credentials:async()=>({accessKeyId:'mock-ak',accessKeySecret:'mock-secret'}),
    eciFallback:createDocumentParserEciConfig({vpcId:'vpc-test',securityGroupId:'sg-test',vSwitchIds:['vsw-a','vsw-b','vsw-c','vsw-d'],instanceTypes:[...singleA10InstanceTypes],image:'test-registry-vpc.cn-beijing.cr.aliyuncs.com/ai_service/xberg:kbxml',acrInstanceId:'cri-test',extraStorageGiB:40,bucket:'test-bucket',keyPrefix:'huahuo'},'cn-beijing')});
  if (!loaded.enabled || loaded.mode !== 'ecs' || !loaded.eciFallback) throw new Error('TEST_CONFIG_REQUIRED');
  const config: EcsDocumentParserConfig = { ...loaded, pollMs: 5, startupTimeoutMs: options.timeout ?? 1000, queueTimeoutMs: 1000,
    concurrency: options.concurrency ?? 1, eciFallback: { ...loaded.eciFallback, retryMs: 20 } };
  const prefix = `test_fallback_${randomUUID().replaceAll('-', '')}`; prefixes.push(prefix);
  const state = new ParserMachineRedis(redis, config, prefix), otherState = new ParserMachineRedis(otherRedis, config, prefix);
  const health = options.health ?? (async () => true);
  return { state, otherState, config, eci, cloud,
    machine: new DocumentParserMachine(state, cloud, config, health, eci),
    other: new DocumentParserMachine(otherState, cloud, config, health, eci) };
}
async function age(state: ParserMachineRedis) {
  const [seconds, micros] = await redis.time();
  await redis.hset(`${state.keyPrefix}:state`, 'lastActivity', Number(seconds) * 1000 + Math.floor(Number(micros) / 1000) - 61000);
}

describe('A10 ECS stock rejection → pay-as-you-go ECI (real Redis; mock cloud)', () => {
  it('uses the preferred ECS when starting succeeds, with no ECI allocation', async () => {
    const s = setup(); s.cloud.error = undefined;
    expect(await s.machine.withDocumentParser(request(), async c => c.baseUrl)).toBe('http://172.18.102.101:8000');
    expect(s.cloud.starts).toBe(1); expect(s.eci.creates).toBe(0);
  });
  it('shares one fallback across concurrent owners, waits for readiness and sends the dynamic private URL', async () => {
    const health = vi.fn(async (context: { baseUrl: string }) => Boolean(context.baseUrl)), s = setup({ concurrency: 2, health }); s.eci.ready = false;
    const parse = vi.fn(async (c: { baseUrl: string }) => c.baseUrl);
    const a = s.machine.withDocumentParser(request(), parse), b = s.other.withDocumentParser(request(), parse);
    await vi.waitFor(() => expect(s.eci.creates).toBe(1), { interval: 5 });
    expect(parse).not.toHaveBeenCalled(); expect(health).not.toHaveBeenCalled();
    s.eci.snapshot!.containersReady = true;
    expect(await Promise.all([a, b])).toEqual(['http://172.18.102.202:8000', 'http://172.18.102.202:8000']);
    expect(health.mock.calls.every(call => call[0]?.baseUrl === 'http://172.18.102.202:8000')).toBe(true);
    expect(s.cloud.starts).toBe(1); expect(s.eci.creates).toBe(1);
    expect(JSON.stringify(await s.state.status())).not.toMatch(/mock-ak|mock-secret/);
    await expect(s.otherState.lock('rollout','configure')).rejects.toMatchObject({code:'DOCUMENT_PARSER_BUSY'});
  });
  it.each(['Forbidden', 'InsufficientBalance', 'QuotaExceed.ElasticQuota'])('does not fall back on %s', async code => {
    const s = setup(); s.cloud.error = new EcsPowerError('ECS_API_FAILED', 'rejected', code);
    await expect(s.machine.withDocumentParser(request(), async () => 'bad')).rejects.toMatchObject({ providerCode: code });
    expect(s.eci.creates).toBe(0); expect((await s.state.status())?.eciTarget).toBeUndefined();
  });
  it('does not create ECI after an ambiguous ECS start, even when its provider code resembles a stock error', async () => {
    const s = setup({ timeout: 60 }); s.cloud.error = new EcsPowerError('ECS_API_FAILED', 'unknown', 'OperationDenied.NoStock');
    await expect(s.machine.withDocumentParser(request(), async () => 'bad')).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(s.other.withDocumentParser(request(), async () => 'bad')).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_STARTUP_TIMEOUT' });
    expect(s.cloud.starts).toBe(1); expect(s.eci.creates).toBe(0);
  });
  it('does not replace a Running ECS just because its HTTP health check times out', async () => {
    const s = setup({ timeout: 60, health: async () => false }); s.cloud.instance.status = 'Running';
    await expect(s.machine.withDocumentParser(request(), async () => 'bad')).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_STARTUP_TIMEOUT' });
    expect(s.cloud.starts).toBe(0); expect(s.eci.creates).toBe(0);
  });
  it.each([{ instanceType: 'ecs.gn6i-c4g1.xlarge' }, { vpcId: 'vpc-other' }, { spotStrategy: 'SpotAsPriceGo' }, { stoppedMode: 'KeepCharging' as const }])('rejects an incompatible preferred ECS before creating ECI: %j', async override => {
    const s = setup(); Object.assign(s.cloud.instance, override);
    await expect(s.machine.withDocumentParser(request(), async () => 'bad')).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_ECS_FALLBACK_INELIGIBLE' });
    expect(s.eci.creates).toBe(0); expect((await s.state.status())?.phase).toBe('ready');
  });
  it('retries a definitive ECI stock rejection with a new generation, while keeping one allocation owner', async () => {
    const s = setup(); s.eci.failures.push(new EciProviderError('capacity', 'OperationDenied.NoStock'));
    expect(await s.machine.withDocumentParser(request(), async () => 'ok')).toBe('ok');
    expect(s.cloud.starts).toBe(1); expect(s.eci.creates).toBe(2); expect(new Set(s.eci.tokens).size).toBe(2);
    expect((await s.state.status())?.eciTarget?.checkpoint?.generation).toBe(1);
  });
  it('adopts a matching accepted ECI after a lost create response, without another create', async () => {
    const s = setup(); s.eci.acceptBeforeFailure = true; s.eci.failures.push(new EciProviderError('transient', 'Timeout'));
    expect(await s.machine.withDocumentParser(request(), async c => c.baseUrl)).toBe('http://172.18.102.202:8000');
    expect(s.eci.creates).toBe(1); expect(s.eci.finds).toBeGreaterThan(0);
  });
  it('never infers safe replacement from an empty query after an ambiguous create', async () => {
    const s = setup({ timeout: 60 }); s.eci.failures.push(new EciProviderError('transient', 'Timeout'));
    await expect(s.machine.withDocumentParser(request(), async () => 'bad')).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_STARTUP_TIMEOUT' });
    await age(s.state); expect(await s.other.tick()).toBe('transition_pending');
    expect(s.eci.creates).toBe(1); expect(s.eci.releases).toBe(0);
    expect((await s.state.status())?.eciTarget?.checkpoint?.phase).toBe('unknown');
    expect((await s.state.status())?.economicallyStopped).toBe(false);
  });
  it('reconciles a durable prepared intent after process restart before executing on the same ECI', async () => {
    const s = setup(), input = request(), id = sha(input.requestId), owner = 'crashed-owner', allocationId = randomUUID();
    await s.state.register(id, owner, input.fingerprint); await s.state.claim(id, owner); await s.state.lock('control', 'request', id, owner);
    await s.state.phase('control', 'starting', id, owner);
    await s.state.setEciTarget('control', { allocationId, checkpoint: {
      allocationId, phase: 'prepared', generation: 0, requestHash: digest(JSON.stringify(s.config.eciFallback!.spec)),
    } });
    await s.state.finish(id, owner, input.fingerprint, 'cancelled'); await s.state.unlock('control');
    s.eci.seed(s.config.eciFallback!.spec, allocationHash(allocationId));
    expect(await s.other.withDocumentParser(input, async c => c.baseUrl)).toBe('http://172.18.102.202:8000');
    expect(s.cloud.starts).toBe(0); expect(s.eci.creates).toBe(0); expect(s.eci.finds).toBeGreaterThan(0);
  });
  it('keeps a pending NoStockWarning on the same submitted ECI instead of creating another', async () => {
    const s = setup(), parse = vi.fn(async () => 'ok'); s.eci.ready = false;
    const operation = s.machine.withDocumentParser(request(), parse);
    await vi.waitFor(() => expect(s.eci.snapshot).not.toBeNull(), { interval: 5 });
    s.eci.snapshot!.status = 'Pending'; s.eci.snapshot!.eventReasons = ['NoStockWarning'];
    await new Promise(resolve => setTimeout(resolve, 25)); expect(parse).not.toHaveBeenCalled(); expect(s.eci.creates).toBe(1);
    s.eci.snapshot!.status = 'Running'; s.eci.snapshot!.containersReady = true;
    expect(await operation).toBe('ok'); expect(s.eci.creates).toBe(1);
  });
  it.each([{ privateIp: '8.8.8.8' }, { instanceType: 'ecs.gn6i-c4g1.xlarge' }, { spotStrategy: 'SpotAsPriceGo' }])('refuses a running ECI with incompatible metadata: %j', async override => {
    const s = setup(); s.eci.ready = false;
    const parse = vi.fn(async () => 'bad'), operation = s.machine.withDocumentParser(request(), parse);
    const assertion = expect(operation).rejects.toBeInstanceOf(Error);
    await vi.waitFor(() => expect(s.eci.snapshot).not.toBeNull(), { interval: 5 });
    Object.assign(s.eci.snapshot!, override, { containersReady: true });
    await assertion; expect(parse).not.toHaveBeenCalled(); expect(s.eci.creates).toBe(1);
  });
  it('retains the ECI and its endpoint while remote execution is unknown, then resumes without creating again', async () => {
    const s = setup(), input = request();
    await expect(s.machine.withDocumentParser(input, async () => { throw new Error('remote connection lost'); })).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_EXECUTION_UNKNOWN' });
    await age(s.state); expect(await s.other.tick()).toBe('busy'); expect(s.eci.releases).toBe(0);
    expect(await s.other.withDocumentParser({ ...input, resume: true }, async c => c.baseUrl)).toBe('http://172.18.102.202:8000');
    expect(s.eci.creates).toBe(1); expect(s.cloud.starts).toBe(1);
  });
  it('deletes the owned idle ECI, confirms absence, and prefers ECS on the next cycle', async () => {
    const s = setup(); await s.machine.withDocumentParser(request(), async () => 'done');
    expect(await s.machine.tick()).toBe('busy'); await age(s.state);
    expect(await s.machine.tick()).toBe('transition_pending'); expect(s.eci.releases).toBe(1); expect(s.cloud.stops).toBe(0);
    expect((await s.state.status())?.eciTarget?.deleteAccepted).toBe(true);
    expect(await s.other.tick()).toBe('stop_confirmed');
    expect((await s.state.status())?.eciTarget).toBeUndefined(); expect((await s.state.status())?.economicallyStopped).toBe(true);
    s.cloud.error = undefined;
    expect(await s.other.withDocumentParser(request(), async c => c.baseUrl)).toBe('http://172.18.102.101:8000');
    expect(s.cloud.starts).toBe(2); expect(s.eci.creates).toBe(1);
  });
  it('does not claim deletion success from an empty query after a lost delete response', async () => {
    const s = setup(); await s.machine.withDocumentParser(request(), async () => 'done'); await age(s.state);
    s.eci.deleteError = new EciProviderError('transient', 'Timeout');
    expect(await s.machine.tick()).toBe('transition_pending'); expect(await s.other.tick()).toBe('transition_pending');
    expect((await s.state.status())?.eciTarget?.deleteAccepted).toBeUndefined();
    expect((await s.state.status())?.economicallyStopped).toBe(false); expect(s.eci.creates).toBe(1);
  });
  it('holds arriving requests behind the ECI deletion fence and returns to ECS only after deletion is observed', async () => {
    const s = setup(); await s.machine.withDocumentParser(request(), async () => 'done'); await age(s.state);
    let finishDelete!: () => void;
    const held = new Promise<void>(resolve => { finishDelete = resolve; });
    s.eci.beforeRelease = async () => held;
    const stopping = s.machine.tick();
    await vi.waitFor(() => expect(s.eci.releases).toBe(1), { interval: 5 });
    s.cloud.error = undefined;
    const parse = vi.fn(async (c: { baseUrl: string }) => c.baseUrl), next = s.other.withDocumentParser(request(), parse);
    await vi.waitFor(async () => expect((await s.state.status())?.queued).toBe(1), { interval: 5 });
    expect(parse).not.toHaveBeenCalled(); expect(s.cloud.starts).toBe(1);
    finishDelete(); await stopping;
    expect(await next).toBe('http://172.18.102.101:8000'); expect(s.eci.creates).toBe(1); expect(s.eci.releases).toBe(1);
  });
  it('cleans up an explicitly rejected ECI startup and allows the next request to try ECS again', async () => {
    const s = setup(); s.eci.failures.push(new EciProviderError('fatal', 'Forbidden'));
    await expect(s.machine.withDocumentParser(request(), async () => 'bad')).rejects.toMatchObject({ code: 'DOCUMENT_PARSER_ECI_API_REJECTED' });
    await age(s.state); expect(await s.other.tick()).toBe('stop_confirmed'); expect(s.eci.releases).toBe(0);
    s.cloud.error = undefined; expect(await s.other.withDocumentParser(request(), async () => 'ok')).toBe('ok');
    expect(s.cloud.starts).toBe(2);
  });
});
