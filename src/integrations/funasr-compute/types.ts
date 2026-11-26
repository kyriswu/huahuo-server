export type FunAsrComputeStatus =
  | { state: 'missing' | 'starting' | 'failed' | 'releasing' }
  | { state: 'ready'; baseUrl: string };
export type FunAsrComputeRelease = 'released' | 'releasing';

export interface FunAsrCompute {
  /** Use one persisted allocation ID per activation attempt. */
  start(allocationId: string, signal?: AbortSignal): Promise<void>;
  /** Make a bounded observation. Poll again while starting or releasing. */
  status(allocationId: string, signal?: AbortSignal): Promise<FunAsrComputeStatus>;
  /** Request release. Repeat with the same ID while cleanup is in progress. */
  release(allocationId: string, signal?: AbortSignal): Promise<FunAsrComputeRelease>;
}

export interface AcsGpuCandidate {
  model: string;
  zone: string;
  driver: string;
  resources?: { cpu: number; memoryGiB: number };
}

export const defaultAcsGpuHostResources = { cpu: 4, memoryGiB: 15 } as const;

export interface AcsFunAsrOptions {
  namespace: string;
  image: string;
  apiSecretName: string;
  imagePullSecretName: string;
  podCidrs: readonly string[];
  candidates: readonly AcsGpuCandidate[];
  startupTimeoutSeconds: number;
  lifetimeSeconds: number;
}

export class FunAsrComputeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'FunAsrComputeError';
  }
}

export function validateAllocationId(id: string): void {
  if (typeof id !== 'string' || id.length > 256 || !id.trim()) {
    throw new FunAsrComputeError('FUNASR_COMPUTE_ALLOCATION_ID_INVALID');
  }
}
