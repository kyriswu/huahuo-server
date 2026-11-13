import { createHash } from 'node:crypto';
import type { GpuSpotSpec, PreparedGpuSpotSpec } from './types.js';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const invalid = (field: string): never => { throw new Error(`INVALID_GPU_SPOT_CONFIG:${field}`); };

export function integer(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(field);
  return value;
}

function string(value: string, field: string, pattern: RegExp): string {
  if (typeof value !== 'string' || value.includes('\0') || !pattern.test(value)) invalid(field);
  return value;
}

function list(values: string[], field: string, max: number, pattern: RegExp): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > max || new Set(values).size !== values.length) invalid(field);
  return values.map(value => string(value, field, pattern));
}

/** Produces a fresh whitelist object; unknown SDK fields cannot enable EIP/fallback. */
export function prepareGpuSpotSpec(spec: GpuSpotSpec): PreparedGpuSpotSpec {
  const regionId = string(spec.regionId, 'regionId', /^[a-z]{2,8}(?:-[a-z0-9]+)+$/);
  const vpcId = string(spec.vpcId, 'vpcId', /^vpc-[a-zA-Z0-9]+$/);
  const securityGroupId = string(spec.securityGroupId, 'securityGroupId', /^sg-[a-zA-Z0-9]+$/);
  const vSwitchIds = list(spec.vSwitchIds, 'vSwitchIds', 10, /^vsw-[a-zA-Z0-9]+$/);
  // GPU families only. Availability, card count and driver compatibility remain cloud-validated.
  const instanceTypes = list(spec.instanceTypes, 'instanceTypes', 5, /^ecs\.(?:s|v)?gn[0-9][a-z0-9-]*\.[a-z0-9]+$/);
  const image = string(spec.image, 'image', /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,1023}$/);
  const gpuCount = integer(spec.gpuCount, 'gpuCount', 1, 16);
  const activeDeadlineSeconds = integer(spec.activeDeadlineSeconds, 'activeDeadlineSeconds', 60, 604800);
  const spot = spec.spot ?? { strategy: 'SpotAsPriceGo' as const };
  if (!['SpotAsPriceGo', 'SpotWithPriceLimit'].includes(spot.strategy)) invalid('spot.strategy');
  let policy: PreparedGpuSpotSpec['spot'] = { strategy: 'SpotAsPriceGo' };
  if (spot.strategy === 'SpotWithPriceLimit') {
    const price = spot.priceLimit;
    if (!Number.isFinite(price) || price <= 0 || Math.abs(price * 1000 - Math.round(price * 1000)) > 1e-7) invalid('spot.priceLimit');
    policy = { strategy: spot.strategy, priceLimit: price };
  } else if ('priceLimit' in spot) invalid('spot.priceLimit');
  const spotDuration = spec.spotDuration ?? 1;
  if (spotDuration !== 0 && spotDuration !== 1) invalid('spotDuration');
  const commands = (values: string[] | undefined, field: string, max: number) => {
    if (values !== undefined && (!Array.isArray(values) || values.length > max)) invalid(field);
    return (values ?? []).map(value => string(value, field, /^[\s\S]{1,256}$/));
  };
  const environment: Record<string, string> = {};
  const entries = Object.entries(spec.environment ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (entries.length > 100) invalid('environment');
  for (const [key, value] of entries) {
    string(key, 'environment.key', /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/);
    string(value, 'environment.value', /^[\s\S]{0,256}$/);
    Object.defineProperty(environment, key, { value, enumerable: true });
  }
  return {
    regionId, vpcId, securityGroupId, vSwitchIds, instanceTypes, image, gpuCount, activeDeadlineSeconds,
    spot: policy, spotDuration, command: commands(spec.command, 'command', 20), args: commands(spec.args, 'args', 10), environment,
    ...(spec.gpuDriverVersion === undefined ? {} : { gpuDriverVersion: string(spec.gpuDriverVersion, 'gpuDriverVersion', /^(?:tesla|grid)=\d{3}$/) }),
    ...(spec.resourceGroupId === undefined ? {} : { resourceGroupId: string(spec.resourceGroupId, 'resourceGroupId', /^rg-[a-zA-Z0-9]+$/) }),
  };
}

export function allocationHash(allocationId: string): string {
  if (typeof allocationId !== 'string' || allocationId.trim().length === 0 || allocationId.length > 256) invalid('allocationId');
  return digest(`huahuo-gpu-spot:${allocationId}`);
}

export function createToken(allocationId: string, generation: number): string {
  return digest(`huahuo-gpu-create:${allocationHash(allocationId)}:${generation}`);
}

export function validateRef(ref: { regionId: string; vpcId: string; containerGroupId: string; allocationHash: string }): void {
  string(ref.regionId, 'regionId', /^[a-z]{2,8}(?:-[a-z0-9]+)+$/);
  string(ref.vpcId, 'vpcId', /^vpc-[a-zA-Z0-9]+$/);
  string(ref.containerGroupId, 'containerGroupId', /^eci-[a-zA-Z0-9]+$/);
  string(ref.allocationHash, 'allocationHash', /^[a-f0-9]{64}$/);
}
