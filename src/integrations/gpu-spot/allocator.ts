import { setTimeout as delay } from 'node:timers/promises';
import { allocationHash, createToken, digest, integer, prepareGpuSpotSpec, validateRef } from './spec.js';
import { EciProviderError, GpuAllocationError, GpuInstanceStateError } from './types.js';
import type { GpuAllocationCheckpoint, GpuAllocationSession, GpuInstanceRef, GpuInstanceSnapshot, GpuSpotProvider, GpuSpotRetryPolicy, GpuSpotSpec, GpuWaitOptions } from './types.js';

export const defaultGpuSpotRetry: GpuSpotRetryPolicy = { maxAttempts: 6, initialDelayMs: 2000, maxDelayMs: 60000 };

export class GpuSpotAllocator {
  private readonly retry: GpuSpotRetryPolicy;

  constructor(private readonly provider: GpuSpotProvider, retry: Partial<GpuSpotRetryPolicy> = {}) {
    this.retry = { ...defaultGpuSpotRetry, ...retry };
    integer(this.retry.maxAttempts, 'maxAttempts', 1, 100);
    integer(this.retry.initialDelayMs, 'initialDelayMs', 1, 60000);
    integer(this.retry.maxDelayMs, 'maxDelayMs', this.retry.initialDelayMs, 300000);
  }

  /** Returns a submitted identity. Running/health/job success are separate observations. */
  async submit(input: GpuSpotSpec, session: GpuAllocationSession, signal?: AbortSignal): Promise<GpuInstanceRef> {
    return this.submitAttempts(input, session, this.retry.maxAttempts, signal);
  }

  private async submitAttempts(input: GpuSpotSpec, session: GpuAllocationSession, maxAttempts: number, signal?: AbortSignal): Promise<GpuInstanceRef> {
    const spec = prepareGpuSpotSpec(input);
    const ownerHash = allocationHash(session.allocationId);
    const requestHash = digest(JSON.stringify(spec));
    let checkpoint: GpuAllocationCheckpoint = session.checkpoint
      ? { ...session.checkpoint }
      : { allocationId: session.allocationId, requestHash, generation: 0, phase: 'prepared' };
    if (checkpoint.allocationId !== session.allocationId || checkpoint.requestHash !== requestHash
      || !Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 0
      || !['prepared', 'unknown', 'retryable', 'capacity_unavailable', 'submitted'].includes(checkpoint.phase)
      || (checkpoint.phase !== 'submitted' && checkpoint.containerGroupId !== undefined)) {
      throw new Error('GPU_ALLOCATION_CHECKPOINT_MISMATCH');
    }
    const ref = (): GpuInstanceRef => {
      const value = { regionId: spec.regionId, vpcId: spec.vpcId, containerGroupId: checkpoint.containerGroupId ?? '', allocationHash: ownerHash };
      validateRef(value);
      return value;
    };
    if (checkpoint.phase === 'submitted') return ref();
    // A process may have died after saving prepared but before recording the response.
    let uncertain = !!session.checkpoint && ['prepared', 'unknown'].includes(checkpoint.phase);
    const save = async (next: GpuAllocationCheckpoint) => {
      checkpoint = next;
      try { await session.persist({ ...next }); }
      catch { throw new GpuAllocationError('GPU_CHECKPOINT_SAVE_FAILED', { ...next }); }
    };
    const cancelled = () => {
      if (signal?.aborted) throw new GpuAllocationError('GPU_ALLOCATION_CANCELLED', { ...checkpoint });
    };
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      cancelled();
      if (checkpoint.phase === 'capacity_unavailable') {
        if (checkpoint.generation >= Number.MAX_SAFE_INTEGER) throw new Error('GPU_ALLOCATION_GENERATION_EXHAUSTED');
        checkpoint = { ...checkpoint, generation: checkpoint.generation + 1, phase: 'prepared' };
      }
      await save({ ...checkpoint, phase: uncertain ? 'unknown' : 'prepared' });
      cancelled();
      let created: { containerGroupId: string; requestId?: string };
      try {
        created = await this.provider.create(spec, createToken(session.allocationId, checkpoint.generation), ownerHash);
      } catch (error) {
        if (!(error instanceof EciProviderError)) {
          await save({ ...checkpoint, phase: 'unknown' });
          throw new GpuAllocationError('GPU_SUBMISSION_UNKNOWN', { ...checkpoint });
        }
        uncertain ||= error.kind === 'transient';
        if (error.kind === 'fatal' || error.kind === 'not_found') {
          if (uncertain) {
            await save({ ...checkpoint, phase: 'unknown' });
            throw new GpuAllocationError('GPU_SUBMISSION_UNKNOWN', { ...checkpoint });
          }
          throw error;
        }
        await save({ ...checkpoint, phase: uncertain ? 'unknown' : error.kind === 'capacity' ? 'capacity_unavailable' : 'retryable', requestId: error.requestId });
        if (attempt === maxAttempts - 1) break;
        try { await delay(this.retryDelay(attempt), undefined, { signal }); }
        catch { cancelled(); throw new Error('GPU_RETRY_WAIT_FAILED'); }
        continue;
      }
      // Always save a received identity, including when cancellation arrived in flight.
      await save({ ...checkpoint, phase: 'submitted', ...created });
      return ref();
    }
    throw new GpuAllocationError(uncertain ? 'GPU_SUBMISSION_UNKNOWN' : checkpoint.phase === 'capacity_unavailable' ? 'GPU_CAPACITY_UNAVAILABLE' : 'GPU_RETRY_EXHAUSTED', { ...checkpoint });
  }

  private retryDelay(attempt: number): number {
    const ceiling = Math.min(this.retry.maxDelayMs, this.retry.initialDelayMs * 2 ** Math.min(attempt, 20));
    return Math.max(1, Math.floor(ceiling * (0.5 + Math.random() * 0.5)));
  }

  /** Also handles async ScheduleFailed/NoStock. Never replaces a running/expired job. */
  async acquire(input: GpuSpotSpec, session: GpuAllocationSession, options: GpuWaitOptions = {}): Promise<GpuInstanceSnapshot> {
    const timeoutMs = integer(options.timeoutMs ?? 600000, 'timeoutMs', 1, 3600000);
    const pollIntervalMs = integer(options.pollIntervalMs ?? 5000, 'pollIntervalMs', 1, 60000);
    const deadline = performance.now() + timeoutMs;
    let current = session.checkpoint;
    const persist = async (next: GpuAllocationCheckpoint) => {
      await session.persist(next);
      current = { ...next };
    };
    for (let attempt = 0; attempt < this.retry.maxAttempts; attempt++) {
      if (performance.now() >= deadline) throw new Error('GPU_WAIT_TIMEOUT');
      let failure: GpuAllocationError;
      try {
        const ref = await this.submitAttempts(input, { ...session, checkpoint: current, persist }, 1, options.signal);
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining <= 0) throw new Error('GPU_WAIT_TIMEOUT');
        return await this.waitForRunning(ref, { ...options, timeoutMs: remaining, pollIntervalMs });
      } catch (error) {
        if (error instanceof GpuInstanceStateError && error.snapshot.status === 'ScheduleFailed'
          && error.snapshot.eventReasons.includes('NoStock')
          && !error.snapshot.eventReasons.some(reason => ['InsufficientBalance', 'QuotaExceeded', 'DiskCapacityQuotaFull', 'StockClose'].includes(reason)) && current) {
          // ScheduleFailed has no billable compute; retain its metadata for diagnostics.
          const next: GpuAllocationCheckpoint = {
            allocationId: current.allocationId, requestHash: current.requestHash, generation: current.generation,
            phase: 'capacity_unavailable', requestId: current.requestId,
          };
          try { await persist(next); }
          catch { throw new GpuAllocationError('GPU_CHECKPOINT_SAVE_FAILED', next); }
          failure = new GpuAllocationError('GPU_CAPACITY_UNAVAILABLE', next);
        } else if (error instanceof GpuAllocationError && ['GPU_CAPACITY_UNAVAILABLE', 'GPU_RETRY_EXHAUSTED', 'GPU_SUBMISSION_UNKNOWN'].includes(error.code)) {
          failure = error;
        } else throw error;
      }
      const remaining = deadline - performance.now();
      if (attempt === this.retry.maxAttempts - 1 || remaining <= 0) throw failure;
      try { await delay(Math.min(this.retryDelay(attempt), remaining), undefined, { signal: options.signal }); }
      catch { throw new GpuAllocationError('GPU_ALLOCATION_CANCELLED', failure.checkpoint); }
    }
    throw new Error('GPU_RETRY_EXHAUSTED');
  }

  async describe(ref: GpuInstanceRef): Promise<GpuInstanceSnapshot | null> {
    validateRef(ref);
    return this.provider.describe(ref);
  }

  async waitForRunning(ref: GpuInstanceRef, options: GpuWaitOptions = {}): Promise<GpuInstanceSnapshot> {
    validateRef(ref);
    const timeoutMs = integer(options.timeoutMs ?? 600000, 'timeoutMs', 1, 3600000);
    const pollIntervalMs = integer(options.pollIntervalMs ?? 5000, 'pollIntervalMs', 1, 60000);
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (options.signal?.aborted) throw new Error('GPU_WAIT_CANCELLED');
      let snapshot: GpuInstanceSnapshot | null;
      try { snapshot = await this.provider.describe(ref); }
      catch (error) {
        if (!(error instanceof EciProviderError) || !['throttled', 'transient'].includes(error.kind)) throw error;
        snapshot = null;
      }
      if (snapshot?.reclaiming) throw new GpuInstanceStateError('GPU_INSTANCE_RECLAIMING', snapshot);
      if (snapshot && (snapshot.eventReasons.includes('SpotDegraded') || !['SpotAsPriceGo', 'SpotWithPriceLimit'].includes(snapshot.spotStrategy))) {
        throw new GpuInstanceStateError('GPU_INSTANCE_NOT_SPOT', snapshot);
      }
      if (snapshot?.status === 'Running') return snapshot;
      if (snapshot && ['Failed', 'ScheduleFailed', 'Succeeded', 'Expired', 'Terminating'].includes(snapshot.status)) {
        throw new GpuInstanceStateError(`GPU_INSTANCE_${snapshot.status.toUpperCase()}`, snapshot);
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      try { await delay(Math.min(pollIntervalMs, remaining), undefined, { signal: options.signal }); }
      catch { throw new Error('GPU_WAIT_CANCELLED'); }
    }
    // An empty describe result may mean insufficient RAM permission, not absence.
    throw new Error('GPU_WAIT_TIMEOUT');
  }

  async release(ref: GpuInstanceRef): Promise<void> {
    validateRef(ref);
    const token = digest(`huahuo-gpu-release:${ref.regionId}:${ref.containerGroupId}:${ref.allocationHash}`);
    await this.provider.release(ref, token);
  }
}
