import { integer, invalid, prepareGpuSpotSpec } from './spec.js';
import type { EciConnection } from './aliyun-eci.js';
import type { GpuSpotRetryPolicy, PreparedGpuSpotSpec, SpotPolicy } from './types.js';
import { defaultGpuSpotRetry } from './allocator.js';

export type GpuSpotConfig = { provider: 'disabled' } | {
  provider: 'aliyun-eci';
  connection: EciConnection;
  spec: PreparedGpuSpotSpec;
  retry: GpuSpotRetryPolicy;
};

/** Separate opt-in configuration; importing the module never provisions resources. */
export function loadGpuSpotConfig(env: Record<string, string | undefined> = process.env): GpuSpotConfig {
  const provider = env.GPU_SPOT_PROVIDER ?? 'disabled';
  if (provider === 'disabled') return { provider };
  if (provider !== 'aliyun-eci') invalid('GPU_SPOT_PROVIDER');
  const required = (key: string): string => env[key]?.trim() || invalid(key);
  const number = (key: string, fallback: number, min: number, max: number): number => integer(Number(env[key] ?? fallback), key, min, max);
  const accessKeyId = required('ALIYUN_RAM_ACCESS_KEY_ID');
  const accessKeySecret = required('ALIYUN_RAM_ACCESS_KEY_SECRET');
  const securityToken = env.ALIYUN_RAM_SECURITY_TOKEN?.trim() || undefined;
  const regionId = required('GPU_SPOT_REGION_ID');
  const strategy = env.GPU_SPOT_STRATEGY ?? 'SpotAsPriceGo';
  let spot: SpotPolicy = { strategy: 'SpotAsPriceGo' };
  if (strategy === 'SpotAsPriceGo') {
    if (env.GPU_SPOT_PRICE_LIMIT?.trim()) invalid('GPU_SPOT_PRICE_LIMIT');
    spot = { strategy };
  } else if (strategy === 'SpotWithPriceLimit') {
    spot = { strategy, priceLimit: Number(required('GPU_SPOT_PRICE_LIMIT')) };
  } else invalid('GPU_SPOT_STRATEGY');
  const spotDuration = number('GPU_SPOT_DURATION_HOURS', 1, 0, 1) as 0 | 1;
  const initialDelayMs = number('GPU_SPOT_INITIAL_DELAY_MS', defaultGpuSpotRetry.initialDelayMs, 1, 60000);
  return {
    provider: 'aliyun-eci',
    connection: {
      regionId,
      credentials: async () => ({ accessKeyId, accessKeySecret, ...(securityToken ? { securityToken } : {}) }),
      connectTimeoutMs: number('GPU_SPOT_CONNECT_TIMEOUT_MS', 5000, 100, 60000),
      readTimeoutMs: number('GPU_SPOT_READ_TIMEOUT_MS', 15000, 100, 120000),
    },
    spec: prepareGpuSpotSpec({
      regionId, vpcId: required('GPU_SPOT_VPC_ID'), securityGroupId: required('GPU_SPOT_SECURITY_GROUP_ID'),
      vSwitchIds: required('GPU_SPOT_VSWITCH_IDS').split(',').map(value => value.trim()),
      instanceTypes: required('GPU_SPOT_INSTANCE_TYPES').split(',').map(value => value.trim()),
      image: required('GPU_SPOT_IMAGE'), gpuCount: number('GPU_SPOT_GPU_COUNT', 1, 1, 16),
      activeDeadlineSeconds: number('GPU_SPOT_ACTIVE_DEADLINE_SECONDS', 3600, 60, 604800),
      spot, spotDuration,
      ...(env.GPU_SPOT_DRIVER_VERSION?.trim() ? { gpuDriverVersion: env.GPU_SPOT_DRIVER_VERSION.trim() } : {}),
      ...(env.GPU_SPOT_RESOURCE_GROUP_ID?.trim() ? { resourceGroupId: env.GPU_SPOT_RESOURCE_GROUP_ID.trim() } : {}),
    }),
    retry: {
      maxAttempts: number('GPU_SPOT_MAX_ATTEMPTS', defaultGpuSpotRetry.maxAttempts, 1, 100),
      initialDelayMs,
      maxDelayMs: number('GPU_SPOT_MAX_DELAY_MS', defaultGpuSpotRetry.maxDelayMs, initialDelayMs, 300000),
    },
  };
}
