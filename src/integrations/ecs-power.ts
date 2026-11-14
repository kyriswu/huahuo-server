import { createRequire } from 'node:module';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { RetryOptions, RuntimeOptions } from '@darabonba/typescript';

export type EcsStatus = 'Pending' | 'Running' | 'Starting' | 'Stopping' | 'Stopped';
export interface EcsInstance {
  instanceId: string; regionId: string; instanceType: string; status: EcsStatus;
  stoppedMode?: 'StopCharging' | 'KeepCharging';
  chargeType: string; networkType: string; vpcId: string; privateIps: string[];
  spotStrategy?: string;
  localStorageAmount: number; localStorageCapacity: number; operationLocked: boolean;
}
export interface EcsPowerPort {
  describe(): Promise<EcsInstance>;
  start(): Promise<void>;
  stopEconomically(): Promise<void>;
}
export class EcsPowerError extends Error {
  constructor(readonly code: string, readonly outcome: 'rejected' | 'unknown' = 'rejected', readonly providerCode?: string, readonly requestId?: string) {
    super(code); this.name = 'EcsPowerError';
  }
}
export interface EcsPowerConnection {
  regionId: string; instanceId: string; privateIp: string;
  credentials: () => Promise<{ accessKeyId: string; accessKeySecret: string; securityToken?: string }>;
}
type Action = 'DescribeInstances' | 'StartInstance' | 'StopInstance';
export type EcsRpc = (action: Action, body: Record<string, string | boolean>) => Promise<unknown>;
const { default: OpenApiClient } = createRequire(import.meta.url)('@alicloud/openapi-core') as typeof import('@alicloud/openapi-core');
const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
const safe = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
function providerError(error: unknown): EcsPowerError {
  if (error instanceof EcsPowerError) return error;
  const e = record(error), status = e.statusCode;
  return new EcsPowerError('ECS_API_FAILED', typeof status === 'number' && status >= 400 && status < 500 ? 'rejected' : 'unknown', safe(e.code), safe(e.requestId));
}

export class AliyunEcsPower implements EcsPowerPort {
  constructor(private readonly connection: EcsPowerConnection, private readonly rpcOverride?: EcsRpc) {
    if (!/^[a-z]{2,8}(?:-[a-z0-9]+)+$/.test(connection.regionId) || !/^i-[a-z0-9]{8,40}$/.test(connection.instanceId)) throw new EcsPowerError('ECS_TARGET_INVALID');
  }
  private async call(action: Action, args: Record<string, string | boolean>): Promise<Record<string, unknown>> {
    try {
      const body = { RegionId: this.connection.regionId, ...args };
      if (this.rpcOverride) return record(await this.rpcOverride(action, body));
      const credentials = await this.connection.credentials();
      if (!credentials.accessKeyId?.trim() || !credentials.accessKeySecret?.trim()) throw new EcsPowerError('ECS_CREDENTIALS_UNAVAILABLE');
      const client = new OpenApiClient(new $OpenApiUtil.Config({
        ...credentials, type: credentials.securityToken ? 'sts' : 'access_key', regionId: this.connection.regionId,
        endpoint: `ecs.${this.connection.regionId}.aliyuncs.com`, protocol: 'HTTPS',
        retryOptions: new RetryOptions({ retryable: false }),
      }));
      const result = await client.callApi(new $OpenApiUtil.Params({
        action, version: '2014-05-26', protocol: 'HTTPS', pathname: '/', method: 'POST',
        authType: 'AK', style: 'RPC', reqBodyType: 'formData', bodyType: 'json',
      }), new $OpenApiUtil.OpenApiRequest({ body }), new RuntimeOptions({
        connectTimeout: 2000, readTimeout: 8000, autoretry: false, maxAttempts: 1, ignoreSSL: false,
      }));
      return record(result.body);
    } catch (error) { throw providerError(error); }
  }
  async describe(): Promise<EcsInstance> {
    const body = await this.call('DescribeInstances', { InstanceIds: JSON.stringify([this.connection.instanceId]) });
    const instances = record(body.Instances).Instance;
    if (!Array.isArray(instances) || instances.length !== 1) throw new EcsPowerError('ECS_TARGET_NOT_VISIBLE');
    const item = record(instances[0]), vpc = record(item.VpcAttributes);
    const ips = record(vpc.PrivateIpAddress).IpAddress;
    if (item.InstanceId !== this.connection.instanceId || item.RegionId !== this.connection.regionId || !Array.isArray(ips) || !ips.includes(this.connection.privateIp) || typeof vpc.VpcId !== 'string' || !vpc.VpcId) throw new EcsPowerError('ECS_TARGET_MISMATCH');
    if (!['Pending', 'Running', 'Starting', 'Stopping', 'Stopped'].includes(String(item.Status)) || typeof item.InstanceType !== 'string'
      || typeof item.InstanceChargeType !== 'string' || typeof item.InstanceNetworkType !== 'string') throw new EcsPowerError('ECS_RESPONSE_INVALID');
    const storage = (key: string) => {
      const value = item[key] ?? 0;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new EcsPowerError('ECS_RESPONSE_INVALID');
      return value;
    };
    return {
      instanceId: this.connection.instanceId, regionId: this.connection.regionId, instanceType: item.InstanceType,
      status: item.Status as EcsStatus, chargeType: item.InstanceChargeType, networkType: item.InstanceNetworkType,
      spotStrategy: typeof item.SpotStrategy === 'string' ? item.SpotStrategy : undefined,
      vpcId: vpc.VpcId, privateIps: ips.filter((ip): ip is string => typeof ip === 'string'),
      stoppedMode: item.StoppedMode === 'StopCharging' || item.StoppedMode === 'KeepCharging' ? item.StoppedMode : undefined,
      localStorageAmount: storage('LocalStorageAmount'), localStorageCapacity: storage('LocalStorageCapacity'),
      operationLocked: Array.isArray(record(item.OperationLocks).LockReason) && (record(item.OperationLocks).LockReason as unknown[]).length > 0,
    };
  }
  async start(): Promise<void> {
    await this.call('StartInstance', { InstanceId: this.connection.instanceId, InitLocalDisk: false });
  }
  async stopEconomically(): Promise<void> {
    await this.call('StopInstance', { InstanceId: this.connection.instanceId, StoppedMode: 'StopCharging', ForceStop: false });
  }
}

/** StartInstance's explicit stock rejection only; transport, quota and billing failures are excluded. */
export function isEcsCapacityRejection(error: unknown): error is EcsPowerError {
  return error instanceof EcsPowerError && error.outcome === 'rejected' && error.providerCode === 'OperationDenied.NoStock';
}

/** Checks known exclusions; the final StoppedMode read remains mandatory. */
export function assertEconomicalStopEligible(instance: EcsInstance): void {
  if (instance.chargeType !== 'PostPaid' || instance.networkType !== 'vpc' || instance.localStorageAmount > 0 || instance.localStorageCapacity > 0
    || /^ecs\.re\d+p(?:-|\.)/.test(instance.instanceType) || instance.operationLocked) throw new EcsPowerError('ECS_ECONOMICAL_STOP_UNSUPPORTED');
}
