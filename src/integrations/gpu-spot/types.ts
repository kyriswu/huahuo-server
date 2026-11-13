export type SpotPolicy =
  | { strategy: 'SpotAsPriceGo' }
  | { strategy: 'SpotWithPriceLimit'; priceLimit: number };

/** Trusted server configuration, never an App/LLM supplied cloud request. */
export interface GpuSpotSpec {
  regionId: string;
  vpcId: string;
  securityGroupId: string;
  vSwitchIds: string[];
  /** Highest priority first; ECI performs ordered multi-spec fallback within one instance. */
  instanceTypes: string[];
  image: string;
  gpuCount: number;
  activeDeadlineSeconds: number;
  spot?: SpotPolicy;
  spotDuration?: 0 | 1;
  gpuDriverVersion?: string;
  resourceGroupId?: string;
  command?: string[];
  args?: string[];
  environment?: Record<string, string>;
}

export interface PreparedGpuSpotSpec extends GpuSpotSpec {
  spot: SpotPolicy;
  spotDuration: 0 | 1;
  command: string[];
  args: string[];
  environment: Record<string, string>;
}

export interface GpuInstanceRef {
  regionId: string;
  vpcId: string;
  containerGroupId: string;
  allocationHash: string;
}

export interface GpuInstanceSnapshot extends GpuInstanceRef {
  status: string;
  spotStrategy: string;
  instanceType?: string;
  privateIp?: string;
  containersReady: boolean;
  reclaiming: boolean;
  eventReasons: string[];
}

export interface GpuNetworkSnapshot {
  regionId: string;
  vpcId: string;
  securityGroupId: string;
  vSwitches: { vSwitchId: string; zoneId: string; availableIpAddressCount?: number }[];
}

export interface GpuSpotProvider {
  create(spec: PreparedGpuSpotSpec, clientToken: string, allocationHash: string): Promise<{ containerGroupId: string; requestId?: string }>;
  describe(ref: GpuInstanceRef): Promise<GpuInstanceSnapshot | null>;
  release(ref: GpuInstanceRef, clientToken: string): Promise<void>;
}

export interface GpuAllocationCheckpoint {
  allocationId: string;
  requestHash: string;
  generation: number;
  phase: 'prepared' | 'unknown' | 'retryable' | 'capacity_unavailable' | 'submitted';
  containerGroupId?: string;
  requestId?: string;
}

/** The owner must hold its Task lease/lock and durably save before returning. */
export interface GpuAllocationSession {
  allocationId: string;
  checkpoint?: GpuAllocationCheckpoint;
  persist(checkpoint: GpuAllocationCheckpoint): Promise<void>;
}

export interface GpuSpotRetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export interface GpuWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export class GpuInstanceStateError extends Error {
  constructor(public readonly code: string, public readonly snapshot: GpuInstanceSnapshot) {
    super(code);
    this.name = 'GpuInstanceStateError';
  }
}

export type EciErrorKind = 'capacity' | 'throttled' | 'transient' | 'fatal' | 'not_found';

/** Intentionally excludes upstream messages, request bodies, credentials and causes. */
export class EciProviderError extends Error {
  constructor(
    public readonly kind: EciErrorKind,
    public readonly providerCode: string,
    public readonly requestId?: string,
  ) {
    super(`ECI_${kind.toUpperCase()}`);
    this.name = 'EciProviderError';
  }
}

export class GpuAllocationError extends Error {
  constructor(
    public readonly code: 'GPU_CAPACITY_UNAVAILABLE' | 'GPU_RETRY_EXHAUSTED' | 'GPU_SUBMISSION_UNKNOWN' | 'GPU_ALLOCATION_CANCELLED' | 'GPU_CHECKPOINT_SAVE_FAILED',
    public readonly checkpoint: GpuAllocationCheckpoint,
  ) {
    super(code);
    this.name = 'GpuAllocationError';
  }
}
