import { checkFunAsrReady } from './health.js';
import { validateAllocationId, type FunAsrCompute, type FunAsrComputeRelease, type FunAsrComputeStatus } from './types.js';

/** Fixed capacity is externally managed. Starting and releasing never change it. */
export class FixedFunAsrCompute implements FunAsrCompute {
  constructor(private readonly baseUrl: string) {}

  async start(allocationId: string, signal?: AbortSignal): Promise<void> {
    validateAllocationId(allocationId);
    signal?.throwIfAborted();
  }

  async status(allocationId: string, signal?: AbortSignal): Promise<FunAsrComputeStatus> {
    validateAllocationId(allocationId);
    return await checkFunAsrReady(this.baseUrl, signal)
      ? { state: 'ready', baseUrl: this.baseUrl }
      : { state: 'starting' };
  }

  async release(allocationId: string, signal?: AbortSignal): Promise<FunAsrComputeRelease> {
    validateAllocationId(allocationId);
    signal?.throwIfAborted();
    return 'released';
  }
}
