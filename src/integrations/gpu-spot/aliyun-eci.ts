import { createRequire } from 'node:module';
import { CreateContainerGroupRequest, CreateContainerGroupRequestContainer, CreateContainerGroupRequestContainerEnvironmentVar, CreateContainerGroupRequestTag, DeleteContainerGroupRequest, DescribeContainerGroupsRequest } from '@alicloud/eci20180808';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { RetryOptions, RuntimeOptions } from '@darabonba/typescript';
import { integer, invalid, prepareGpuSpotSpec, validateRef } from './spec.js';
import { EciProviderError } from './types.js';
import type { GpuInstanceRef, GpuInstanceSnapshot, GpuNetworkSnapshot, GpuSpotProvider, GpuSpotSpec, PreparedGpuSpotSpec } from './types.js';

export interface EciCredentials { accessKeyId: string; accessKeySecret: string; securityToken?: string }
export interface EciConnection {
  regionId: string;
  credentials: () => Promise<EciCredentials>;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
}

// Read the CommonJS export once, consistently in Node ESM and the test runner.
const { default: EciClient } = createRequire(import.meta.url)('@alicloud/eci20180808') as typeof import('@alicloud/eci20180808');
const { default: OpenApiClient } = createRequire(import.meta.url)('@alicloud/openapi-core') as typeof import('@alicloud/openapi-core');
type EciSdkClient = InstanceType<typeof EciClient>;
class EciFormDataClient extends EciClient {
  override callApi(params: $OpenApiUtil.Params, request: $OpenApiUtil.OpenApiRequest, runtime: RuntimeOptions): ReturnType<EciSdkClient['callApi']> {
    if (params.action === 'CreateContainerGroup' && params.method === 'POST' && params.reqBodyType === 'formData'
      && request.query && request.body == null) {
      // The generated SDK otherwise puts all workload values in the URL, causing HTTP 414.
      // Keep the same parameters and idempotency token in the signed POST form body.
      return super.callApi(params, new $OpenApiUtil.OpenApiRequest({ ...request, body: request.query, query: {} }), runtime);
    }
    return super.callApi(params, request, runtime);
  }
}
export type EciSdkPort = Pick<EciSdkClient, 'createContainerGroupWithOptions' | 'describeContainerGroupsWithOptions' | 'deleteContainerGroupWithOptions'>;
export type EciNetworkQuery = (action: 'DescribeVSwitchAttributes' | 'DescribeSecurityGroupAttribute', query: Record<string, string>) => Promise<unknown>;

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

export function classifyEciError(error: unknown): EciProviderError {
  if (error instanceof EciProviderError) return error;
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const code = safeIdentifier(record.code) ?? 'Unknown';
  const requestId = safeIdentifier(record.requestId);
  const status = typeof record.statusCode === 'number' ? record.statusCode : undefined;
  // No code/message substring heuristics for quota, credentials, permissions or billing errors.
  if (status !== undefined && status >= 400 && status < 500) {
    if (['Spot.NotMatched', 'OperationDenied.NoStock', 'InsufficientResource', 'ResourceNotEnough'].includes(code)) return new EciProviderError('capacity', code, requestId);
    if (['InvalidContainerGroupId.NotFound', 'ContainerGroupNotFound'].includes(code)) return new EciProviderError('not_found', code, requestId);
    if (code === 'Throttling' || code === 'Throttling.User' || code === 'Throttling.Api' || status === 429) return new EciProviderError('throttled', code, requestId);
    return new EciProviderError('fatal', code, requestId);
  }
  // 5xx, transport timeouts, malformed responses and unrecognized SDK exceptions are ambiguous.
  return new EciProviderError('transient', code, requestId);
}

export function buildEciCreateRequest(spec: PreparedGpuSpotSpec, clientToken: string, allocationHash: string): CreateContainerGroupRequest {
  return new CreateContainerGroupRequest({
    regionId: spec.regionId,
    securityGroupId: spec.securityGroupId,
    vSwitchId: spec.vSwitchIds.join(','),
    // ECI's multi-spec API retries in the supplied priority order.
    instanceType: spec.instanceTypes.join(','),
    containerGroupName: `huahuo-gpu-${allocationHash.slice(0, 24)}`,
    clientToken,
    spotStrategy: spec.spot.strategy,
    ...(spec.spot.strategy === 'SpotWithPriceLimit' ? { spotPriceLimit: spec.spot.priceLimit } : {}),
    spotDuration: spec.spotDuration,
    activeDeadlineSeconds: spec.activeDeadlineSeconds,
    gpuDriverVersion: spec.gpuDriverVersion,
    resourceGroupId: spec.resourceGroupId,
    scheduleStrategy: 'VSwitchRandom',
    restartPolicy: 'Never',
    autoCreateEip: false,
    autoMatchImageCache: false,
    tag: [
      new CreateContainerGroupRequestTag({ key: 'managed-by', value: 'huahuo-server' }),
      new CreateContainerGroupRequestTag({ key: 'huahuo-gpu-allocation', value: allocationHash }),
    ],
    container: [new CreateContainerGroupRequestContainer({
      name: 'gpu-workload', image: spec.image, gpu: spec.gpuCount,
      command: spec.command.length ? spec.command : undefined,
      arg: spec.args.length ? spec.args : undefined,
      environmentVar: Object.entries(spec.environment).map(([key, value]) => new CreateContainerGroupRequestContainerEnvironmentVar({ key, value })),
      environmentVarHide: true,
      imagePullPolicy: 'IfNotPresent',
    })],
  });
}

export class AliyunEciGpuProvider implements GpuSpotProvider {
  private readonly connectTimeoutMs: number;
  private readonly readTimeoutMs: number;

  constructor(private readonly connection: EciConnection, private readonly sdkOverride?: EciSdkPort, private readonly networkOverride?: EciNetworkQuery) {
    if (!/^[a-z]{2,8}(?:-[a-z0-9]+)+$/.test(connection.regionId)) invalid('regionId');
    this.connectTimeoutMs = integer(connection.connectTimeoutMs ?? 5000, 'connectTimeoutMs', 100, 60000);
    this.readTimeoutMs = integer(connection.readTimeoutMs ?? 15000, 'readTimeoutMs', 100, 120000);
  }

  private runtime(): RuntimeOptions {
    return new RuntimeOptions({
      connectTimeout: this.connectTimeoutMs, readTimeout: this.readTimeoutMs,
      autoretry: false, maxAttempts: 1,
      ignoreSSL: false,
    });
  }

  private async sdkConfig(endpoint: string): Promise<$OpenApiUtil.Config> {
    let credentials: EciCredentials;
    try { credentials = await this.connection.credentials(); }
    catch { throw new EciProviderError('fatal', 'CredentialsUnavailable'); }
    if (!credentials.accessKeyId?.trim() || !credentials.accessKeySecret?.trim()
      || (credentials.securityToken !== undefined && !credentials.securityToken.trim())) invalid('credentials');
    // Resolve credentials per operation to support an owning worker's refreshable STS source.
    return new $OpenApiUtil.Config({
      ...credentials,
      type: credentials.securityToken ? 'sts' : 'access_key',
      regionId: this.connection.regionId,
      endpoint,
      protocol: 'HTTPS',
      retryOptions: new RetryOptions({ retryable: false }),
    });
  }

  private async sdk(): Promise<EciSdkPort> {
    if (this.sdkOverride) return this.sdkOverride;
    return new EciFormDataClient(await this.sdkConfig(`eci.${this.connection.regionId}.aliyuncs.com`));
  }

  private async networkQuery(action: Parameters<EciNetworkQuery>[0], query: Record<string, string>): Promise<unknown> {
    if (this.networkOverride) return this.networkOverride(action, query);
    const service = action === 'DescribeVSwitchAttributes' ? 'vpc' : 'ecs';
    const client = new OpenApiClient(await this.sdkConfig(`${service}.${this.connection.regionId}.aliyuncs.com`));
    return client.callApi(new $OpenApiUtil.Params({
      action, version: service === 'vpc' ? '2016-04-28' : '2014-05-26',
      protocol: 'HTTPS', pathname: '/', method: 'POST', authType: 'AK', style: 'RPC', reqBodyType: 'formData', bodyType: 'json',
    }), new $OpenApiUtil.OpenApiRequest({ query }), this.runtime());
  }

  /** Read-only membership check. No cloud create/delete operations are performed. */
  async preflight(input: GpuSpotSpec): Promise<GpuNetworkSnapshot> {
    const spec = prepareGpuSpotSpec(input);
    this.assertRegion(spec.regionId);
    const results = await Promise.allSettled([
      ...spec.vSwitchIds.map(VSwitchId => this.networkQuery('DescribeVSwitchAttributes', { RegionId: spec.regionId, VSwitchId })),
      this.networkQuery('DescribeSecurityGroupAttribute', { RegionId: spec.regionId, SecurityGroupId: spec.securityGroupId }),
    ]);
    // Finish every read before deciding whether any creation is permitted.
    const bodies = results.map(result => {
      if (result.status === 'rejected') {
        const failure = classifyEciError(result.reason);
        throw new EciProviderError('fatal', `NetworkPreflight.${failure.providerCode}`, failure.requestId);
      }
      const response = result.value;
      if (typeof response !== 'object' || response === null || !('body' in response)
        || typeof response.body !== 'object' || response.body === null) throw new EciProviderError('fatal', 'InvalidNetworkResponse');
      return response.body as Record<string, unknown>;
    });
    const vSwitches = spec.vSwitchIds.map((vSwitchId, index) => {
      const body = bodies[index]!;
      if (body.VSwitchId !== vSwitchId || typeof body.ZoneId !== 'string' || !body.ZoneId.startsWith(`${spec.regionId}-`)) throw new EciProviderError('fatal', 'VSwitchIdentityMismatch');
      if (body.VpcId !== spec.vpcId) throw new EciProviderError('fatal', 'VSwitchVpcMismatch');
      const available = body.AvailableIpAddressCount;
      return { vSwitchId, zoneId: body.ZoneId, ...(typeof available === 'number' && Number.isSafeInteger(available) && available >= 0 ? { availableIpAddressCount: available } : {}) };
    });
    const group = bodies.at(-1)!;
    if (group.SecurityGroupId !== spec.securityGroupId) throw new EciProviderError('fatal', 'SecurityGroupIdentityMismatch');
    if (group.VpcId !== spec.vpcId) throw new EciProviderError('fatal', 'SecurityGroupVpcMismatch');
    return { regionId: spec.regionId, vpcId: spec.vpcId, securityGroupId: spec.securityGroupId, vSwitches };
  }

  private assertRegion(regionId: string): void {
    if (regionId !== this.connection.regionId) throw new Error('GPU_REGION_MISMATCH');
  }

  async create(spec: PreparedGpuSpotSpec, clientToken: string, allocationHash: string): Promise<{ containerGroupId: string; requestId?: string }> {
    this.assertRegion(spec.regionId);
    if (!/^[\x21-\x7e]{1,64}$/.test(clientToken) || !/^[a-f0-9]{64}$/.test(allocationHash)) invalid('submissionIdentity');
    const prepared = prepareGpuSpotSpec(spec);
    await this.preflight(prepared);
    const client = await this.sdk();
    try {
      const response = await client.createContainerGroupWithOptions(buildEciCreateRequest(prepared, clientToken, allocationHash), this.runtime());
      const body = response.body;
      if (!body?.containerGroupId || !/^eci-[a-zA-Z0-9]+$/.test(body.containerGroupId)) throw new EciProviderError('transient', 'InvalidResponse');
      return { containerGroupId: body.containerGroupId, requestId: safeIdentifier(body.requestId) };
    } catch (error) { throw classifyEciError(error); }
  }

  async describe(ref: GpuInstanceRef): Promise<GpuInstanceSnapshot | null> {
    validateRef(ref);
    this.assertRegion(ref.regionId);
    const client = await this.sdk();
    try {
      const response = await client.describeContainerGroupsWithOptions(new DescribeContainerGroupsRequest({
        regionId: ref.regionId, containerGroupIds: JSON.stringify([ref.containerGroupId]), withEvent: true, limit: 1,
      }), this.runtime());
      if (!Array.isArray(response.body?.containerGroups)) throw new EciProviderError('transient', 'InvalidResponse');
      const groups = response.body.containerGroups;
      if (groups.length === 0) return null;
      const group = groups[0];
      if (groups.length !== 1 || group?.containerGroupId !== ref.containerGroupId
        || !['Scheduling', 'Pending', 'Running', 'Restarting', 'Updating', 'Terminating', 'Succeeded', 'Failed', 'Expired', 'ScheduleFailed'].includes(group.status ?? '')) throw new EciProviderError('transient', 'InvalidResponse');
      const tags = new Map(group.tags?.map(tag => [tag.key, tag.value]));
      const manager = tags.get('managed-by');
      const allocation = tags.get('huahuo-gpu-allocation');
      if (group.vpcId && group.vpcId !== ref.vpcId) throw new EciProviderError('fatal', 'InstanceVpcMismatch');
      if ((manager !== undefined && manager !== 'huahuo-server') || (allocation !== undefined && allocation !== ref.allocationHash)) throw new EciProviderError('fatal', 'AllocationOwnershipMismatch');
      if (!group.vpcId || manager === undefined || allocation === undefined) {
        // Newly accepted instances can precede complete network/tag metadata.
        // Waiting is safe; granting ownership or deleting without it is not.
        const initializing = group.status === 'Scheduling' || group.status === 'Pending';
        throw new EciProviderError(initializing ? 'transient' : 'fatal', initializing ? 'InstanceMetadataPending' : 'InstanceMetadataMissing');
      }
      const eventReasons = [...new Set((group.events ?? []).map(event => safeIdentifier(event.reason)).filter((reason): reason is string => !!reason))];
      return {
        ...ref, status: group.status!, spotStrategy: group.spotStrategy ?? 'Unknown', instanceType: group.instanceType, privateIp: group.intranetIp,
        containersReady: !!group.containers?.length && group.containers.every(container => container.ready === true),
        reclaiming: eventReasons.includes('SpotToBeReleased'), eventReasons,
      };
    } catch (error) { throw classifyEciError(error); }
  }

  async release(ref: GpuInstanceRef, clientToken: string): Promise<void> {
    validateRef(ref);
    this.assertRegion(ref.regionId);
    // RAM may return an empty list instead of a permission error. Never infer deletion from it.
    if (!await this.describe(ref)) throw new EciProviderError('fatal', 'InstanceNotVisible');
    const client = await this.sdk();
    try {
      await client.deleteContainerGroupWithOptions(new DeleteContainerGroupRequest({
        regionId: ref.regionId, containerGroupId: ref.containerGroupId, clientToken, force: false,
      }), this.runtime());
    } catch (error) {
      const failure = classifyEciError(error);
      if (failure.kind !== 'not_found') throw failure;
    }
  }
}
