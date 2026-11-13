import { afterEach, describe, expect, it, vi } from 'vitest';
import { EciProviderError, GpuAllocationError, GpuSpotAllocator, createGpuSpotModule, loadGpuSpotConfig, prepareGpuSpotSpec } from '../../src/integrations/gpu-spot/index.js';
import type { GpuAllocationCheckpoint, GpuAllocationSession, GpuInstanceSnapshot, GpuSpotProvider, GpuSpotSpec } from '../../src/integrations/gpu-spot/index.js';
import { allocationHash, createToken } from '../../src/integrations/gpu-spot/spec.js';

const spec: GpuSpotSpec = {
  regionId: 'cn-beijing', vpcId: 'vpc-test', securityGroupId: 'sg-test', vSwitchIds: ['vsw-zonea', 'vsw-zoneb'],
  instanceTypes: ['ecs.gn6i-c4g1.xlarge', 'ecs.gn7i-c8g1.2xlarge'],
  image: 'registry.example.com/huahuo/gpu:1.0.0', gpuCount: 1, activeDeadlineSeconds: 3600,
};
const allocationId = 'test-task:gpu:01';
const ref = { regionId: spec.regionId, vpcId: spec.vpcId, containerGroupId: 'eci-test', allocationHash: allocationHash(allocationId) };
const running: GpuInstanceSnapshot = { ...ref, status: 'Running', spotStrategy: 'SpotAsPriceGo', containersReady: false, reclaiming: false, eventReasons: [] };

function setup(maxAttempts = 3) {
  const provider = {
    create: vi.fn<GpuSpotProvider['create']>().mockResolvedValue({ containerGroupId: ref.containerGroupId, requestId: 'request-1' }),
    describe: vi.fn<GpuSpotProvider['describe']>().mockResolvedValue(running),
    release: vi.fn<GpuSpotProvider['release']>().mockResolvedValue(undefined),
  };
  const saves: GpuAllocationCheckpoint[] = [];
  const persist = vi.fn(async (checkpoint: GpuAllocationCheckpoint) => { saves.push({ ...checkpoint }); });
  const session: GpuAllocationSession = { allocationId, persist };
  const allocator = new GpuSpotAllocator(provider, { maxAttempts, initialDelayMs: 10, maxDelayMs: 20 });
  return { provider, allocator, session, saves, persist };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('GPU spot configuration', () => {
  const env = {
    GPU_SPOT_PROVIDER: 'aliyun-eci', GPU_SPOT_REGION_ID: 'cn-beijing', GPU_SPOT_VPC_ID: 'vpc-test', ALIYUN_RAM_ACCESS_KEY_ID: 'test-id',
    ALIYUN_RAM_ACCESS_KEY_SECRET: 'test-secret', ALIYUN_RAM_SECURITY_TOKEN: '', GPU_SPOT_SECURITY_GROUP_ID: 'sg-test',
    GPU_SPOT_VSWITCH_IDS: 'vsw-zonea, vsw-zoneb', GPU_SPOT_INSTANCE_TYPES: spec.instanceTypes.join(','), GPU_SPOT_IMAGE: spec.image,
  };

  it('is disabled with no cloud credentials and does not instantiate a provider', () => {
    expect(loadGpuSpotConfig({})).toEqual({ provider: 'disabled' });
    expect(createGpuSpotModule(loadGpuSpotConfig({}))).toBeUndefined();
  });

  it('defaults to the user-selected market strategy with a finite runtime', async () => {
    const config = loadGpuSpotConfig(env);
    expect(config.provider).toBe('aliyun-eci');
    if (config.provider !== 'aliyun-eci') throw new Error('unexpected disabled');
    expect(config.spec).toMatchObject({ spot: { strategy: 'SpotAsPriceGo' }, spotDuration: 1, activeDeadlineSeconds: 3600, gpuCount: 1 });
    expect(config.spec.vSwitchIds).toEqual(['vsw-zonea', 'vsw-zoneb']);
    expect(await config.connection.credentials()).toEqual({ accessKeyId: 'test-id', accessKeySecret: 'test-secret' });
    expect(createGpuSpotModule(config)?.allocator).toBeInstanceOf(GpuSpotAllocator);
  });

  it('supports explicit capped prices and STS without borrowing OSS credentials', async () => {
    const config = loadGpuSpotConfig({ ...env, GPU_SPOT_STRATEGY: 'SpotWithPriceLimit', GPU_SPOT_PRICE_LIMIT: '0.125', ALIYUN_RAM_SECURITY_TOKEN: 'test-sts' });
    if (config.provider !== 'aliyun-eci') throw new Error('unexpected disabled');
    expect(config.spec.spot).toEqual({ strategy: 'SpotWithPriceLimit', priceLimit: 0.125 });
    expect(await config.connection.credentials()).toMatchObject({ securityToken: 'test-sts' });
    expect(() => loadGpuSpotConfig({ ...env, ALIYUN_RAM_ACCESS_KEY_SECRET: '', STORAGE_ALIYUN_OSS_ACCESS_KEY_SECRET: 'unused' })).toThrow('ALIYUN_RAM_ACCESS_KEY_SECRET');
  });

  it.each<Record<string, string>>([
    { GPU_SPOT_STRATEGY: 'NoSpot' }, { GPU_SPOT_PRICE_LIMIT: '1' }, { GPU_SPOT_GPU_COUNT: '0' },
    { GPU_SPOT_STRATEGY: 'SpotWithPriceLimit', GPU_SPOT_PRICE_LIMIT: '0.1234' },
    { GPU_SPOT_STRATEGY: 'SpotWithPriceLimit', GPU_SPOT_PRICE_LIMIT: '-1' },
    { GPU_SPOT_DURATION_HOURS: '2' }, { GPU_SPOT_ACTIVE_DEADLINE_SECONDS: '0' },
    { GPU_SPOT_MAX_ATTEMPTS: 'Infinity' }, { GPU_SPOT_MAX_DELAY_MS: '1' },
  ])('rejects invalid billing or retry configuration before any cloud call: %j', patch => {
    expect(() => loadGpuSpotConfig({ ...env, ...patch })).toThrow('INVALID_GPU_SPOT_CONFIG:');
  });

  it.each<Partial<GpuSpotSpec>>([
    { instanceTypes: ['ecs.c7.xlarge'] }, { instanceTypes: Array.from({ length: 6 }, (_, i) => `ecs.gn6i-c4g1.${i}xlarge`) },
    { vSwitchIds: ['vsw-duplicate', 'vsw-duplicate'] }, { vSwitchIds: [] }, { securityGroupId: '' }, { vpcId: '' },
    { gpuDriverVersion: 'tesla=535.161.08' }, { environment: { 'INVALID-KEY': 'value' } },
    { environment: { TOKEN: 'x'.repeat(257) } }, { command: ['\0'] },
  ])('validates GPU, network and container constraints: %j', patch => {
    expect(() => prepareGpuSpotSpec({ ...spec, ...patch })).toThrow('INVALID_GPU_SPOT_CONFIG:');
  });
});

describe('GPU spot submission and durable recovery (mock provider)', () => {
  it('saves intent before submission and replays a saved identity without another cloud call', async () => {
    const { provider, allocator, session, saves } = setup();
    provider.create.mockImplementation(async () => {
      expect(saves.at(-1)).toMatchObject({ phase: 'prepared', generation: 0 });
      return { containerGroupId: ref.containerGroupId };
    });
    expect(await allocator.submit(spec, session)).toEqual(ref);
    expect(saves.at(-1)).toMatchObject({ phase: 'submitted', containerGroupId: 'eci-test' });
    expect(await allocator.submit(spec, { ...session, checkpoint: saves.at(-1) })).toEqual(ref);
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it('rotates the token only after confirmed capacity rejection and persists every new intent', async () => {
    const { provider, allocator, session, saves } = setup();
    provider.create.mockRejectedValueOnce(new EciProviderError('capacity', 'Spot.NotMatched'));
    const promise = allocator.submit(spec, session);
    expect(await promise).toEqual(ref);
    expect(provider.create.mock.calls.map(call => call[1])).toEqual([createToken(allocationId, 0), createToken(allocationId, 1)]);
    expect(saves.map(checkpoint => [checkpoint.generation, checkpoint.phase])).toEqual([[0, 'prepared'], [0, 'capacity_unavailable'], [1, 'prepared'], [1, 'submitted']]);
  });

  it('keeps the original token after timeout even when a later attempt reports no stock', async () => {
    const { provider, allocator, session } = setup();
    provider.create.mockRejectedValueOnce(new EciProviderError('transient', 'ETIMEDOUT'))
      .mockRejectedValueOnce(new EciProviderError('capacity', 'Spot.NotMatched'));
    const promise = allocator.submit(spec, session);
    expect(await promise).toEqual(ref);
    expect(new Set(provider.create.mock.calls.map(call => call[1])).size).toBe(1);
    expect(provider.create.mock.calls.every(call => call[1].length === 64)).toBe(true);
  });

  it('resumes an unknown submission with the same request and token', async () => {
    const { provider, allocator, session, saves } = setup(1);
    provider.create.mockRejectedValueOnce(new EciProviderError('transient', 'ETIMEDOUT'));
    await expect(allocator.submit(spec, session)).rejects.toMatchObject({ code: 'GPU_SUBMISSION_UNKNOWN', checkpoint: { phase: 'unknown' } });
    await allocator.submit(spec, { ...session, checkpoint: saves.at(-1) });
    expect(provider.create.mock.calls[0]?.[1]).toEqual(provider.create.mock.calls[1]?.[1]);
  });

  it('treats a prepared intent recovered after a crash as potentially submitted', async () => {
    const { allocator, session, provider, saves } = setup(1);
    provider.create.mockImplementationOnce(async () => { throw new Error('unrecognized adapter failure with secret'); });
    await expect(allocator.submit(spec, session)).rejects.toMatchObject({ code: 'GPU_SUBMISSION_UNKNOWN' });
    provider.create.mockRejectedValueOnce(new EciProviderError('capacity', 'Spot.NotMatched'));
    await expect(allocator.submit(spec, { ...session, checkpoint: saves[0] })).rejects.toMatchObject({ code: 'GPU_SUBMISSION_UNKNOWN', checkpoint: { generation: 0 } });
  });

  it('returns a resumable capacity checkpoint after a bounded number of attempts', async () => {
    const { allocator, session, provider, saves } = setup(2);
    provider.create.mockRejectedValue(new EciProviderError('capacity', 'Spot.NotMatched'));
    const failure = expect(allocator.submit(spec, session)).rejects.toMatchObject({ code: 'GPU_CAPACITY_UNAVAILABLE', checkpoint: { generation: 1, phase: 'capacity_unavailable' } });
    await failure;
    provider.create.mockResolvedValue({ containerGroupId: ref.containerGroupId });
    await allocator.submit(spec, { ...session, checkpoint: saves.at(-1) });
    expect(provider.create.mock.calls.at(-1)?.[1]).toBe(createToken(allocationId, 2));
  });

  it('does not retry credentials, quota, balance or parameter errors', async () => {
    const { allocator, provider, session } = setup();
    provider.create.mockRejectedValue(new EciProviderError('fatal', 'Account.Arrearage'));
    await expect(allocator.submit(spec, session)).rejects.toMatchObject({ kind: 'fatal', providerCode: 'Account.Arrearage' });
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it('reports exhausted throttling separately from GPU stock', async () => {
    const { allocator, provider, session } = setup(1);
    provider.create.mockRejectedValue(new EciProviderError('throttled', 'Throttling'));
    await expect(allocator.submit(spec, session)).rejects.toMatchObject({ code: 'GPU_RETRY_EXHAUSTED' });
  });

  it('rejects a changed request or allocation scope before another cloud call', async () => {
    const { allocator, provider, session, saves } = setup();
    await allocator.submit(spec, session);
    const resumed = { ...session, checkpoint: saves.at(-1) };
    await expect(allocator.submit({ ...spec, image: 'registry.example.com/another:1' }, resumed)).rejects.toThrow('GPU_ALLOCATION_CHECKPOINT_MISMATCH');
    await expect(allocator.submit({ ...spec, vpcId: 'vpc-other' }, resumed)).rejects.toThrow('GPU_ALLOCATION_CHECKPOINT_MISMATCH');
    await expect(allocator.submit({ ...spec, instanceTypes: [...spec.instanceTypes].reverse() }, resumed)).rejects.toThrow('GPU_ALLOCATION_CHECKPOINT_MISMATCH');
    await expect(allocator.submit(spec, { ...resumed, allocationId: 'another-task' })).rejects.toThrow('GPU_ALLOCATION_CHECKPOINT_MISMATCH');
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it('normalizes environment order and snapshots mutable caller arrays', async () => {
    const { allocator, provider, session, saves } = setup();
    const input = { ...spec, vSwitchIds: [...spec.vSwitchIds], environment: { B: '2', A: '1' } };
    await allocator.submit(input, session);
    input.vSwitchIds.push('vsw-other');
    expect(provider.create.mock.calls[0]?.[0].vSwitchIds).toEqual(spec.vSwitchIds);
    await allocator.submit({ ...spec, environment: { A: '1', B: '2' } }, { ...session, checkpoint: saves.at(-1) });
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it('never calls the provider if saving the intent fails', async () => {
    const { allocator, provider, session, persist } = setup();
    persist.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(allocator.submit(spec, session)).rejects.toMatchObject({ code: 'GPU_CHECKPOINT_SAVE_FAILED', checkpoint: { phase: 'prepared' } });
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('preserves the known cloud identity when saving the response fails', async () => {
    const { allocator, session, persist } = setup();
    persist.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(allocator.submit(spec, session)).rejects.toMatchObject({ code: 'GPU_CHECKPOINT_SAVE_FAILED', checkpoint: { phase: 'submitted', containerGroupId: ref.containerGroupId } });
  });

  it('cancels a wait without submitting or releasing a cloud instance', async () => {
    const { allocator, provider, session } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(allocator.submit(spec, session, controller.signal)).rejects.toBeInstanceOf(GpuAllocationError);
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.release).not.toHaveBeenCalled();
  });

  it('stops capacity retry when aborted during backoff', async () => {
    const { allocator, provider, session } = setup();
    const controller = new AbortController();
    provider.create.mockRejectedValue(new EciProviderError('capacity', 'Spot.NotMatched'));
    const failure = expect(allocator.submit(spec, session, controller.signal)).rejects.toMatchObject({ code: 'GPU_ALLOCATION_CANCELLED' });
    await new Promise(resolve => setTimeout(resolve, 1));
    controller.abort();
    await failure;
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it('records acceptance if cancellation arrives during the cloud call', async () => {
    const { allocator, provider, session, saves } = setup();
    const controller = new AbortController();
    provider.create.mockImplementationOnce(async () => { controller.abort(); return { containerGroupId: ref.containerGroupId }; });
    expect(await allocator.submit(spec, session, controller.signal)).toEqual(ref);
    expect(saves.at(-1)?.phase).toBe('submitted');
    expect(provider.release).not.toHaveBeenCalled();
  });
});

describe('GPU acquisition through async scheduling (mock provider)', () => {
  it('waits for initializing metadata on the saved instance without submitting again', async () => {
    const { allocator, provider, session, saves } = setup();
    provider.describe.mockRejectedValueOnce(new EciProviderError('transient', 'InstanceMetadataPending'));
    expect(await allocator.acquire(spec, session, { pollIntervalMs: 1 })).toEqual(running);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.describe).toHaveBeenCalledTimes(2);
    expect(saves.at(-1)).toMatchObject({ phase: 'submitted', containerGroupId: ref.containerGroupId });
  });

  it('validates observation settings before the first billable operation', async () => {
    const { allocator, provider, session } = setup();
    await expect(allocator.acquire(spec, session, { pollIntervalMs: 0 })).rejects.toThrow('INVALID_GPU_SPOT_CONFIG:pollIntervalMs');
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('retries confirmed ScheduleFailed/NoStock with a new persisted token', async () => {
    const { allocator, provider, session, saves } = setup();
    provider.create.mockResolvedValueOnce({ containerGroupId: 'eci-nostock' });
    provider.describe.mockResolvedValueOnce({ ...running, containerGroupId: 'eci-nostock', status: 'ScheduleFailed', eventReasons: ['NoStock'] });
    expect(await allocator.acquire(spec, session, { pollIntervalMs: 1 })).toEqual(running);
    expect(provider.create.mock.calls.map(call => call[1])).toEqual([createToken(allocationId, 0), createToken(allocationId, 1)]);
    expect(saves.map(checkpoint => checkpoint.phase)).toEqual(['prepared', 'submitted', 'capacity_unavailable', 'prepared', 'submitted']);
    expect(saves[2]?.containerGroupId).toBeUndefined();
    expect(provider.release).not.toHaveBeenCalled();
  });

  it('uses one total attempt budget for API stock errors and async stock failures', async () => {
    const { allocator, provider, session } = setup(3);
    provider.create.mockRejectedValueOnce(new EciProviderError('capacity', 'Spot.NotMatched'));
    provider.describe.mockResolvedValueOnce({ ...running, status: 'ScheduleFailed', eventReasons: ['NoStock'] });
    expect(await allocator.acquire(spec, session)).toEqual(running);
    expect(provider.create).toHaveBeenCalledTimes(3);
    expect(provider.create.mock.calls.map(call => call[1])).toEqual([0, 1, 2].map(generation => createToken(allocationId, generation)));
  });

  it('keeps polling a Scheduling warning instead of launching a duplicate instance', async () => {
    const { allocator, provider, session } = setup();
    provider.describe.mockResolvedValueOnce({ ...running, status: 'Scheduling', eventReasons: ['NoStock'] });
    expect(await allocator.acquire(spec, session, { pollIntervalMs: 1 })).toEqual(running);
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 'Failed', eventReasons: ['NoStock'] },
    { status: 'Expired', eventReasons: ['SpotToBeReleased'] },
    { status: 'ScheduleFailed', eventReasons: ['InsufficientBalance'] },
    { status: 'ScheduleFailed', eventReasons: ['NoStock', 'QuotaExceeded'] },
  ])('does not replay a business job or retry non-stock failure: %j', async patch => {
    const { allocator, provider, session, saves } = setup();
    provider.describe.mockResolvedValueOnce({ ...running, ...patch });
    await expect(allocator.acquire(spec, session)).rejects.toThrow('GPU_INSTANCE_');
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(saves.at(-1)?.phase).toBe('submitted');
  });

  it('does not create a replacement after a visibility timeout', async () => {
    const { allocator, provider, session, saves } = setup();
    provider.describe.mockResolvedValue(null);
    await expect(allocator.acquire(spec, session, { timeoutMs: 15, pollIntervalMs: 5 })).rejects.toThrow('GPU_WAIT_TIMEOUT');
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(saves.at(-1)).toMatchObject({ phase: 'submitted', containerGroupId: 'eci-test' });
  });

  it('stops at the attempt limit for repeated asynchronous no-stock failures', async () => {
    const { allocator, provider, session, saves } = setup(2);
    provider.describe.mockResolvedValue({ ...running, status: 'ScheduleFailed', eventReasons: ['NoStock'] });
    await expect(allocator.acquire(spec, session)).rejects.toMatchObject({ code: 'GPU_CAPACITY_UNAVAILABLE', checkpoint: { generation: 1 } });
    expect(provider.create).toHaveBeenCalledTimes(2);
    expect(saves.at(-1)?.phase).toBe('capacity_unavailable');
  });

  it('keeps the same token while resolving ambiguous submissions inside acquire', async () => {
    const { allocator, provider, session } = setup();
    provider.create.mockRejectedValueOnce(new EciProviderError('transient', 'ETIMEDOUT'));
    expect(await allocator.acquire(spec, session)).toEqual(running);
    expect(new Set(provider.create.mock.calls.map(call => call[1])).size).toBe(1);
  });
});

describe('GPU lifecycle observations (mock provider)', () => {
  it('waits for Running, keeps container readiness separate, and never submits during polling', async () => {
    const { allocator, provider } = setup();
    provider.describe.mockResolvedValueOnce({ ...running, status: 'Pending' });
    const promise = allocator.waitForRunning(ref, { pollIntervalMs: 10 });
    expect(await promise).toMatchObject({ status: 'Running', containersReady: false });
    expect(provider.create).not.toHaveBeenCalled();
  });

  it.each(['Failed', 'ScheduleFailed', 'Succeeded', 'Expired', 'Terminating'])('stops on %s without allocating a replacement', async status => {
    const { allocator, provider } = setup();
    provider.describe.mockResolvedValueOnce({ ...running, status });
    await expect(allocator.waitForRunning(ref)).rejects.toThrow(`GPU_INSTANCE_${status.toUpperCase()}`);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('treats invisible metadata as unknown, with a bounded observation timeout', async () => {
    const { allocator, provider } = setup();
    provider.describe.mockResolvedValue(null);
    await expect(allocator.waitForRunning(ref, { timeoutMs: 25, pollIntervalMs: 10 })).rejects.toThrow('GPU_WAIT_TIMEOUT');
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('reports imminent spot reclamation even if the instance still says Running', async () => {
    const { allocator, provider } = setup();
    provider.describe.mockResolvedValueOnce({ ...running, reclaiming: true, eventReasons: ['SpotToBeReleased'] });
    await expect(allocator.waitForRunning(ref)).rejects.toThrow('GPU_INSTANCE_RECLAIMING');
  });

  it('reports unexpected pay-as-you-go fallback without blocking explicit release', async () => {
    const { allocator, provider } = setup();
    provider.describe.mockResolvedValueOnce({ ...running, spotStrategy: 'NoSpot', eventReasons: ['SpotDegraded'] });
    await expect(allocator.waitForRunning(ref)).rejects.toThrow('GPU_INSTANCE_NOT_SPOT');
    await allocator.release(ref);
    expect(provider.release).toHaveBeenCalledTimes(1);
  });

  it('uses a stable release token and never exposes raw SDK errors', async () => {
    const { allocator, provider } = setup();
    await allocator.release(ref);
    await allocator.release(ref);
    expect(provider.release.mock.calls[0]).toEqual(provider.release.mock.calls[1]);
    const failure = new EciProviderError('fatal', 'Forbidden', 'request-1');
    expect(failure.message).toBe('ECI_FATAL');
    expect('cause' in failure).toBe(false);
  });
});
