import { AcsFunAsrCompute } from './acs.js';
import type { FunAsrComputeConfig } from './config.js';
import { FixedFunAsrCompute } from './fixed.js';
import { createKubernetesTransport } from './kubernetes.js';
import type { FunAsrCompute } from './types.js';

export { loadFunAsrComputeConfig } from './config.js';
export type { FunAsrComputeConfig } from './config.js';
export { FunAsrComputeError } from './types.js';
export type { FunAsrCompute, FunAsrComputeRelease, FunAsrComputeStatus } from './types.js';

export function createFunAsrCompute(config: FunAsrComputeConfig): FunAsrCompute | null {
  if (config.provider === 'fixed') return new FixedFunAsrCompute(config.baseUrl);
  if (config.provider === 'acs') return new AcsFunAsrCompute(config.options, createKubernetesTransport(config.connection));
  return null;
}
