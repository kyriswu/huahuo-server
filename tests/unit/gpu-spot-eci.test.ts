import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { CreateContainerGroupResponse, CreateContainerGroupResponseBody, DeleteContainerGroupResponse, DeleteContainerGroupResponseBody, DescribeContainerGroupsResponse, DescribeContainerGroupsResponseBody, DescribeContainerGroupsResponseBodyContainerGroups } from '@alicloud/eci20180808';
import { AliyunEciGpuProvider, buildEciCreateRequest, classifyEciError } from '../../src/integrations/gpu-spot/aliyun-eci.js';
import type { EciNetworkQuery, EciSdkPort } from '../../src/integrations/gpu-spot/aliyun-eci.js';
import { prepareGpuSpotSpec } from '../../src/integrations/gpu-spot/spec.js';

const allocationHash = 'a'.repeat(64);
const { default: EciClient } = createRequire(import.meta.url)('@alicloud/eci20180808') as typeof import('@alicloud/eci20180808');
const { default: OpenApiClient } = createRequire(import.meta.url)('@alicloud/openapi-core') as typeof import('@alicloud/openapi-core');
const ref = { regionId: 'cn-beijing', vpcId: 'vpc-test', containerGroupId: 'eci-test', allocationHash };
const spec = prepareGpuSpotSpec({
  regionId: ref.regionId, vpcId: ref.vpcId, securityGroupId: 'sg-test', vSwitchIds: ['vsw-a', 'vsw-b'],
  instanceTypes: ['ecs.gn6i-c4g1.xlarge', 'ecs.gn7i-c8g1.2xlarge'], image: 'registry.example.com/huahuo/gpu:1.0.0',
  gpuCount: 1, activeDeadlineSeconds: 3600, gpuDriverVersion: 'tesla=580',
  command: ['python'], args: ['worker.py'], environment: { PRIVATE_TOKEN: 'test-value' },
});

const networkResponse: EciNetworkQuery = async (action, query) => ({ body: action === 'DescribeVSwitchAttributes'
  ? { VSwitchId: query.VSwitchId, VpcId: spec.vpcId, ZoneId: `cn-beijing-${query.VSwitchId?.slice(-1)}`, AvailableIpAddressCount: 100 }
  : { SecurityGroupId: query.SecurityGroupId, VpcId: spec.vpcId } });

function describeResponse(group: Record<string, unknown> | null = {}) {
  return new DescribeContainerGroupsResponse({ body: new DescribeContainerGroupsResponseBody({
    containerGroups: group === null ? [] : [new DescribeContainerGroupsResponseBodyContainerGroups({
      containerGroupId: ref.containerGroupId, vpcId: ref.vpcId, status: 'Running', spotStrategy: 'SpotAsPriceGo', instanceType: spec.instanceTypes[0], intranetIp: '10.0.0.12',
      tags: [{ key: 'managed-by', value: 'huahuo-server' }, { key: 'huahuo-gpu-allocation', value: allocationHash }],
      containers: [{ ready: true }], events: [{ reason: 'SpotToBeReleased', message: 'secret upstream content' }],
      ...group,
    })],
  }) });
}

function setup() {
  const sdk = {
    createContainerGroupWithOptions: vi.fn<EciSdkPort['createContainerGroupWithOptions']>().mockResolvedValue(new CreateContainerGroupResponse({ body: new CreateContainerGroupResponseBody({ containerGroupId: ref.containerGroupId, requestId: 'request-1' }) })),
    describeContainerGroupsWithOptions: vi.fn<EciSdkPort['describeContainerGroupsWithOptions']>().mockResolvedValue(describeResponse()),
    deleteContainerGroupWithOptions: vi.fn<EciSdkPort['deleteContainerGroupWithOptions']>().mockResolvedValue(new DeleteContainerGroupResponse({ body: new DeleteContainerGroupResponseBody({ requestId: 'request-2' }) })),
  };
  const network = vi.fn<EciNetworkQuery>(networkResponse);
  const provider = new AliyunEciGpuProvider({ regionId: ref.regionId, credentials: async () => ({ accessKeyId: 'test-id', accessKeySecret: 'test-secret' }) }, sdk, network);
  return { provider, sdk, network };
}

afterEach(() => vi.restoreAllMocks());

describe('official ECI request construction (no network)', () => {
  it('sets GPU count, multi-zone/multi-spec market policy and bounded workload settings', () => {
    const request = buildEciCreateRequest(spec, 'test-token', allocationHash);
    expect(request).toMatchObject({
      instanceType: spec.instanceTypes.join(','), vSwitchId: 'vsw-a,vsw-b', securityGroupId: 'sg-test',
      spotStrategy: 'SpotAsPriceGo', spotDuration: 1, gpuDriverVersion: 'tesla=580',
      activeDeadlineSeconds: 3600, autoCreateEip: false, restartPolicy: 'Never', scheduleStrategy: 'VSwitchRandom',
      container: [{ gpu: 1, image: spec.image, environmentVarHide: true, command: ['python'], arg: ['worker.py'] }],
    });
    expect(request.spotPriceLimit).toBeUndefined();
    expect(request.cpu).toBeUndefined();
    expect(request.memory).toBeUndefined();
    request.validate();
  });

  it('sets a price cap only for SpotWithPriceLimit', () => {
    const capped = prepareGpuSpotSpec({ ...spec, spot: { strategy: 'SpotWithPriceLimit', priceLimit: 0.123 } });
    expect(buildEciCreateRequest(capped, 'test-token', allocationHash)).toMatchObject({ spotStrategy: 'SpotWithPriceLimit', spotPriceLimit: 0.123 });
  });

  it('preserves the four T4 priorities and three zones in a single official SDK create request', async () => {
    const selected = prepareGpuSpotSpec({ ...spec,
      instanceTypes: ['ecs.gn6i-c4g1.xlarge', 'ecs.gn6i-c8g1.2xlarge', 'ecs.gn6i-c16g1.4xlarge', 'ecs.gn6i-c24g1.6xlarge'],
      vSwitchIds: ['vsw-a', 'vsw-b', 'vsw-c'],
    });
    const callApi = vi.spyOn(EciClient.prototype, 'callApi').mockResolvedValue({
      body: { ContainerGroupId: ref.containerGroupId, RequestId: 'request-ordered' }, headers: {}, statusCode: 200,
    });
    const provider = new AliyunEciGpuProvider({ regionId: ref.regionId, credentials: async () => ({ accessKeyId: 'test-id', accessKeySecret: 'test-secret' }) }, undefined, networkResponse);
    await provider.create(selected, 'ordered-token', allocationHash);
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi.mock.calls[0]?.[1].body).toMatchObject({
      InstanceType: 'ecs.gn6i-c4g1.xlarge,ecs.gn6i-c8g1.2xlarge,ecs.gn6i-c16g1.4xlarge,ecs.gn6i-c24g1.6xlarge',
      VSwitchId: 'vsw-a,vsw-b,vsw-c', ScheduleStrategy: 'VSwitchRandom', 'Container.1.Gpu': '1',
    });
  });

  it('loads the actual CommonJS SDK under ESM and constructs official RPC parameters', async () => {
    const callApi = vi.spyOn(EciClient.prototype, 'callApi').mockResolvedValue({
      body: { ContainerGroupId: ref.containerGroupId, RequestId: 'request-1' }, headers: {}, statusCode: 200,
    });
    const credentials = vi.fn(async () => ({ accessKeyId: 'test-id', accessKeySecret: 'test-secret', securityToken: 'test-sts' }));
    const provider = new AliyunEciGpuProvider({ regionId: ref.regionId, credentials }, undefined, networkResponse);
    expect(await provider.create(spec, 'test-token', allocationHash)).toEqual({ containerGroupId: 'eci-test', requestId: 'request-1' });
    const [params, request, runtime] = callApi.mock.calls[0]!;
    expect(params).toMatchObject({ action: 'CreateContainerGroup', version: '2018-08-08', protocol: 'HTTPS', method: 'POST' });
    expect(request.query).toEqual({});
    expect(request.body).toMatchObject({
      'Container.1.Gpu': '1', 'Container.1.Image': spec.image, 'Container.1.EnvironmentVarHide': 'true',
      SpotStrategy: 'SpotAsPriceGo', InstanceType: spec.instanceTypes.join(','), AutoCreateEip: 'false', ClientToken: 'test-token',
    });
    expect(request.body?.VpcId).toBeUndefined();
    expect(runtime).toMatchObject({ autoretry: false, maxAttempts: 1, ignoreSSL: false });
    expect((callApi.mock.contexts[0] as InstanceType<typeof EciClient>)._retryOptions.retryable).toBe(false);
    await provider.create(spec, 'test-token', allocationHash);
    expect(credentials).toHaveBeenCalledTimes(2);
  });

  it('sends exactly one SDK transport request on an ambiguous network failure', async () => {
    const dara = createRequire(import.meta.url)('@darabonba/typescript') as typeof import('@darabonba/typescript');
    const transport = vi.spyOn(dara, 'doAction').mockRejectedValue(new Error('test transport timeout'));
    const provider = new AliyunEciGpuProvider({ regionId: ref.regionId, credentials: async () => ({ accessKeyId: 'test-id', accessKeySecret: 'test-secret' }) }, undefined, networkResponse);
    await expect(provider.create(spec, 'test-token', allocationHash)).rejects.toMatchObject({ kind: 'transient' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('keeps large workload values out of the URL while preserving the signed create parameters', async () => {
    const dara = createRequire(import.meta.url)('@darabonba/typescript') as typeof import('@darabonba/typescript');
    const transport = vi.spyOn(dara, 'doAction').mockImplementation(async request => {
      expect(request.method).toBe('POST');
      expect(request.query).toEqual({});
      expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
      if (!request.body) throw new Error('missing POST body');
      const chunks: Buffer[] = [];
      for await (const chunk of request.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const bytes = Buffer.concat(chunks);
      expect(bytes.length).toBeGreaterThan(8192);
      const form = new URLSearchParams(bytes.toString());
      expect(form.get('ClientToken')).toBe('large-stable-token');
      expect(form.get('InstanceType')).toBe(spec.instanceTypes.join(','));
      expect(form.get('Container.1.Image')).toBe(spec.image);
      expect([...form.keys()].filter(key => /^Container\.1\.EnvironmentVar\.\d+\.Value$/.test(key))).toHaveLength(40);
      const response = new IncomingMessage(new Socket());
      response.statusCode = 200;
      response.statusMessage = 'OK';
      response.headers = { 'content-type': 'application/json' };
      response.push(Buffer.from('{"ContainerGroupId":"eci-test","RequestId":"request-form"}'));
      response.push(null);
      return new dara.Response(response);
    });
    const large = prepareGpuSpotSpec({ ...spec, environment: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`WORKLOAD_OPTION_${index}`, 'x'.repeat(256)])) });
    const provider = new AliyunEciGpuProvider({ regionId: ref.regionId, credentials: async () => ({ accessKeyId: 'test-id', accessKeySecret: 'test-secret' }) }, undefined, networkResponse);
    await expect(provider.create(large, 'large-stable-token', allocationHash)).resolves.toEqual({ containerGroupId: ref.containerGroupId, requestId: 'request-form' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('ECI network preflight (mock cloud reads)', () => {
  it('verifies every configured switch and security group without creating resources', async () => {
    const { provider, sdk, network } = setup();
    expect(await provider.preflight(spec)).toEqual({
      regionId: spec.regionId, vpcId: spec.vpcId, securityGroupId: spec.securityGroupId,
      vSwitches: [{ vSwitchId: 'vsw-a', zoneId: 'cn-beijing-a', availableIpAddressCount: 100 }, { vSwitchId: 'vsw-b', zoneId: 'cn-beijing-b', availableIpAddressCount: 100 }],
    });
    expect(network.mock.calls).toEqual([
      ['DescribeVSwitchAttributes', { RegionId: spec.regionId, VSwitchId: 'vsw-a' }],
      ['DescribeVSwitchAttributes', { RegionId: spec.regionId, VSwitchId: 'vsw-b' }],
      ['DescribeSecurityGroupAttribute', { RegionId: spec.regionId, SecurityGroupId: spec.securityGroupId }],
    ]);
    expect(sdk.createContainerGroupWithOptions).not.toHaveBeenCalled();
    expect(sdk.deleteContainerGroupWithOptions).not.toHaveBeenCalled();
  });

  it('waits for all membership reads before calling CreateContainerGroup', async () => {
    const { provider, sdk, network } = setup();
    let finishLastRead!: (value: unknown) => void;
    network.mockImplementation((action, query) => action === 'DescribeSecurityGroupAttribute'
      ? new Promise(resolve => { finishLastRead = resolve; }) : networkResponse(action, query));
    const promise = provider.create(spec, 'test-token', allocationHash);
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(3), { interval: 1 });
    expect(sdk.createContainerGroupWithOptions).not.toHaveBeenCalled();
    finishLastRead({ body: { SecurityGroupId: spec.securityGroupId, VpcId: spec.vpcId } });
    await promise;
    expect(sdk.createContainerGroupWithOptions).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['DescribeVSwitchAttributes', 'VSwitchVpcMismatch'],
    ['DescribeSecurityGroupAttribute', 'SecurityGroupVpcMismatch'],
  ] as const)('rejects foreign VPC membership from %s before cloud creation', async (changedAction, providerCode) => {
    const { provider, sdk, network } = setup();
    network.mockImplementation(async (action, query) => {
      if (action === changedAction) return { body: { VSwitchId: query.VSwitchId, SecurityGroupId: query.SecurityGroupId, VpcId: 'vpc-other', ZoneId: 'cn-beijing-a' } };
      return networkResponse(action, query);
    });
    await expect(provider.create(spec, 'test-token', allocationHash)).rejects.toMatchObject({ kind: 'fatal', providerCode });
    expect(sdk.createContainerGroupWithOptions).not.toHaveBeenCalled();
  });

  it('rejects a switch in another region even if its VPC claim matches', async () => {
    const { provider, sdk, network } = setup();
    network.mockResolvedValueOnce({ body: { VSwitchId: 'vsw-a', VpcId: spec.vpcId, ZoneId: 'cn-hangzhou-a' } });
    await expect(provider.create(spec, 'test-token', allocationHash)).rejects.toMatchObject({ providerCode: 'VSwitchIdentityMismatch' });
    expect(sdk.createContainerGroupWithOptions).not.toHaveBeenCalled();
  });

  it('sanitizes permission errors and does not bypass preflight on failed reads', async () => {
    const { provider, sdk, network } = setup();
    network.mockRejectedValueOnce({ statusCode: 403, code: 'Forbidden', requestId: 'read-1', message: 'test-secret-must-not-leak' });
    await expect(provider.create(spec, 'test-token', allocationHash)).rejects.toMatchObject({ kind: 'fatal', providerCode: 'NetworkPreflight.Forbidden', message: 'ECI_FATAL' });
    expect(network).toHaveBeenCalledTimes(3);
    expect(sdk.createContainerGroupWithOptions).not.toHaveBeenCalled();
  });

  it('rejects malformed membership responses before cloud creation', async () => {
    const { provider, sdk, network } = setup();
    network.mockResolvedValueOnce({ unexpected: 'response' });
    await expect(provider.create(spec, 'test-token', allocationHash)).rejects.toMatchObject({ providerCode: 'InvalidNetworkResponse' });
    expect(sdk.createContainerGroupWithOptions).not.toHaveBeenCalled();
  });

  it('uses official read-only RPCs at the regional VPC/ECS endpoints (real SDK, mock transport)', async () => {
    const { sdk } = setup();
    const reads = vi.spyOn(OpenApiClient.prototype, 'callApi').mockImplementation(async (params, request) => {
      const query = request.query as Record<string, string>;
      if (params.action === 'DescribeVSwitchAttributes') return networkResponse('DescribeVSwitchAttributes', query) as Promise<Record<string, unknown>>;
      if (params.action === 'DescribeSecurityGroupAttribute') return networkResponse('DescribeSecurityGroupAttribute', query) as Promise<Record<string, unknown>>;
      throw new Error('unexpected write operation');
    });
    const provider = new AliyunEciGpuProvider({ regionId: spec.regionId, credentials: async () => ({ accessKeyId: 'test-id', accessKeySecret: 'test-secret' }) }, sdk);
    await provider.preflight(spec);
    expect(reads).toHaveBeenCalledTimes(3);
    expect(reads.mock.calls[0]?.[0]).toMatchObject({ action: 'DescribeVSwitchAttributes', version: '2016-04-28', protocol: 'HTTPS' });
    expect(reads.mock.calls[2]?.[0]).toMatchObject({ action: 'DescribeSecurityGroupAttribute', version: '2014-05-26', protocol: 'HTTPS' });
    expect(reads.mock.contexts.map(context => (context as InstanceType<typeof OpenApiClient>)._endpoint)).toEqual(['vpc.cn-beijing.aliyuncs.com', 'vpc.cn-beijing.aliyuncs.com', 'ecs.cn-beijing.aliyuncs.com']);
    expect(sdk.createContainerGroupWithOptions).not.toHaveBeenCalled();
  });
});

describe('ECI cloud adapter lifecycle (mock SDK)', () => {
  it.each([
    { status: 'Scheduling', vpcId: undefined, tags: [] },
    { status: 'Pending', vpcId: '', tags: [] },
    { status: 'Pending', tags: [] },
  ])('waits for incomplete initialization metadata without granting ownership: %j', async group => {
    const { provider, sdk } = setup();
    sdk.describeContainerGroupsWithOptions.mockResolvedValueOnce(describeResponse(group));
    await expect(provider.describe(ref)).rejects.toMatchObject({ kind: 'transient', providerCode: 'InstanceMetadataPending' });
    expect(sdk.deleteContainerGroupWithOptions).not.toHaveBeenCalled();
  });

  it.each([
    { group: { status: 'Scheduling', vpcId: 'vpc-other', tags: [] }, providerCode: 'InstanceVpcMismatch' },
    { group: { status: 'Pending', vpcId: undefined, tags: [{ key: 'managed-by', value: 'another-project' }] }, providerCode: 'AllocationOwnershipMismatch' },
  ])('rejects a real mismatch even during initialization: %j', async ({ group, providerCode }) => {
    const { provider, sdk } = setup();
    sdk.describeContainerGroupsWithOptions.mockResolvedValueOnce(describeResponse(group));
    await expect(provider.describe(ref)).rejects.toMatchObject({ kind: 'fatal', providerCode });
  });

  it.each([
    { status: 'Running', vpcId: undefined },
    { status: 'Running', tags: [] },
  ])('rejects missing ownership metadata after initialization: %j', async group => {
    const { provider, sdk } = setup();
    sdk.describeContainerGroupsWithOptions.mockResolvedValueOnce(describeResponse(group));
    await expect(provider.describe(ref)).rejects.toMatchObject({ kind: 'fatal', providerCode: 'InstanceMetadataMissing' });
  });

  it('does not release an initializing instance before its ownership metadata is available', async () => {
    const { provider, sdk } = setup();
    sdk.describeContainerGroupsWithOptions.mockResolvedValueOnce(describeResponse({ status: 'Scheduling', vpcId: undefined, tags: [] }));
    await expect(provider.release(ref, 'release-token')).rejects.toMatchObject({ kind: 'transient', providerCode: 'InstanceMetadataPending' });
    expect(sdk.deleteContainerGroupWithOptions).not.toHaveBeenCalled();
  });

  it('queries exactly one JSON-encoded identity and reports reclamation without raw messages', async () => {
    const { provider, sdk } = setup();
    expect(await provider.describe(ref)).toEqual({
      ...ref, status: 'Running', spotStrategy: 'SpotAsPriceGo', instanceType: spec.instanceTypes[0], privateIp: '10.0.0.12',
      containersReady: true, reclaiming: true, eventReasons: ['SpotToBeReleased'],
    });
    expect(sdk.describeContainerGroupsWithOptions.mock.calls[0]?.[0]).toMatchObject({ containerGroupIds: '["eci-test"]', withEvent: true, limit: 1 });
  });

  it('distinguishes an empty permission-filtered list from a malformed response', async () => {
    const { provider, sdk } = setup();
    sdk.describeContainerGroupsWithOptions.mockResolvedValueOnce(describeResponse(null))
      .mockResolvedValueOnce(new DescribeContainerGroupsResponse({ body: new DescribeContainerGroupsResponseBody({}) }));
    expect(await provider.describe(ref)).toBeNull();
    await expect(provider.describe(ref)).rejects.toMatchObject({ kind: 'transient', providerCode: 'InvalidResponse' });
  });

  it.each([
    { tags: [{ key: 'managed-by', value: 'another-project' }] },
    { tags: [{ key: 'managed-by', value: 'huahuo-server' }, { key: 'huahuo-gpu-allocation', value: 'another-task' }] },
  ])('refuses to release a group with mismatched ownership tags: %j', async group => {
    const { provider, sdk } = setup();
    sdk.describeContainerGroupsWithOptions.mockResolvedValueOnce(describeResponse(group));
    await expect(provider.release(ref, 'release-token')).rejects.toMatchObject({ providerCode: 'AllocationOwnershipMismatch' });
    expect(sdk.deleteContainerGroupWithOptions).not.toHaveBeenCalled();
  });

  it('does not delete on empty visibility or a mismatched returned identity', async () => {
    const { provider, sdk } = setup();
    sdk.describeContainerGroupsWithOptions.mockResolvedValueOnce(describeResponse(null)).mockResolvedValueOnce(describeResponse({ containerGroupId: 'eci-other' }));
    await expect(provider.release(ref, 'release-token')).rejects.toMatchObject({ providerCode: 'InstanceNotVisible' });
    await expect(provider.release(ref, 'release-token')).rejects.toMatchObject({ providerCode: 'InvalidResponse' });
    expect(sdk.deleteContainerGroupWithOptions).not.toHaveBeenCalled();
  });

  it('refuses to release a group outside the configured VPC', async () => {
    const { provider, sdk } = setup();
    sdk.describeContainerGroupsWithOptions.mockResolvedValueOnce(describeResponse({ vpcId: 'vpc-other' }));
    await expect(provider.release(ref, 'release-token')).rejects.toMatchObject({ providerCode: 'InstanceVpcMismatch' });
    expect(sdk.deleteContainerGroupWithOptions).not.toHaveBeenCalled();
  });

  it('sends a graceful, idempotent delete request after checking managed ownership', async () => {
    const { provider, sdk } = setup();
    await provider.release(ref, 'release-token');
    expect(sdk.deleteContainerGroupWithOptions.mock.calls[0]?.[0]).toMatchObject({ regionId: 'cn-beijing', containerGroupId: 'eci-test', clientToken: 'release-token', force: false });
    expect(sdk.describeContainerGroupsWithOptions.mock.invocationCallOrder[0]).toBeLessThan(sdk.deleteContainerGroupWithOptions.mock.invocationCallOrder[0]!);
  });

  it('sanitizes upstream failure text and handles only explicit not-found as a delete race', async () => {
    const { provider, sdk } = setup();
    sdk.createContainerGroupWithOptions.mockRejectedValueOnce({ statusCode: 403, code: 'Forbidden', requestId: 'request-3', message: 'accessKeySecret=do-not-leak' });
    await expect(provider.create(spec, 'test-token', allocationHash)).rejects.toMatchObject({ message: 'ECI_FATAL', providerCode: 'Forbidden', requestId: 'request-3' });
    sdk.deleteContainerGroupWithOptions.mockRejectedValueOnce({ statusCode: 404, code: 'InvalidContainerGroupId.NotFound' })
      .mockRejectedValueOnce({ statusCode: 403, code: 'Forbidden' });
    await provider.release(ref, 'release-token');
    await expect(provider.release(ref, 'release-token')).rejects.toMatchObject({ kind: 'fatal' });
  });

  it('rejects a malformed create response as unknown instead of declaring success', async () => {
    const { provider, sdk } = setup();
    sdk.createContainerGroupWithOptions.mockResolvedValueOnce(new CreateContainerGroupResponse({ body: new CreateContainerGroupResponseBody({ requestId: 'request-4' }) }));
    await expect(provider.create(spec, 'test-token', allocationHash)).rejects.toMatchObject({ kind: 'transient', providerCode: 'InvalidResponse' });
  });

  it('refuses cross-region operations before touching the SDK', async () => {
    const { provider, sdk } = setup();
    await expect(provider.describe({ ...ref, regionId: 'cn-hangzhou' })).rejects.toThrow('GPU_REGION_MISMATCH');
    expect(sdk.describeContainerGroupsWithOptions).not.toHaveBeenCalled();
  });
});

describe('ECI error classification', () => {
  it.each([
    [403, 'Spot.NotMatched', 'capacity'], [400, 'InsufficientResource', 'capacity'],
    [403, 'OperationDenied.NoStock', 'capacity'],
    [429, 'Throttling', 'throttled'], [403, 'Throttling.User', 'throttled'],
    [400, 'Account.Arrearage', 'fatal'], [403, 'QuotaExceeded', 'fatal'],
    [403, 'Throttling.Vcpu.PerDay', 'fatal'], [403, 'Forbidden', 'fatal'],
    [400, 'IdempotentParameterMismatch', 'fatal'], [500, 'InternalError', 'transient'],
    [503, 'ServiceUnavailable', 'transient'], [undefined, 'ETIMEDOUT', 'transient'],
  ])('classifies HTTP %s / %s as %s', (statusCode, code, kind) => {
    expect(classifyEciError({ statusCode, code, message: 'private upstream message' }).kind).toBe(kind);
  });

  it('does not expose arbitrary code/request-id text or retain the upstream error', () => {
    const result = classifyEciError({ statusCode: 403, code: 'secret content\n123', requestId: 'sensitive value', message: 'credentials' });
    expect(result.providerCode).toBe('Unknown');
    expect(result.requestId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('credentials');
  });
});
