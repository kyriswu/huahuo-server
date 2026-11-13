import { AliyunEciGpuProvider } from './aliyun-eci.js';
import { GpuSpotAllocator } from './allocator.js';
import type { GpuSpotConfig } from './config.js';

export * from './types.js';
export { loadGpuSpotConfig } from './config.js';
export type { GpuSpotConfig } from './config.js';
export { GpuSpotAllocator, defaultGpuSpotRetry } from './allocator.js';
export { AliyunEciGpuProvider } from './aliyun-eci.js';
export type { EciConnection, EciCredentials } from './aliyun-eci.js';
export { prepareGpuSpotSpec } from './spec.js';

export function createGpuSpotModule(config: GpuSpotConfig) {
  if (config.provider === 'disabled') return undefined;
  return { spec: config.spec, allocator: new GpuSpotAllocator(new AliyunEciGpuProvider(config.connection), config.retry) };
}
