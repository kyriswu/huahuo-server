import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { DocumentParserEciConfig } from '../../config/document-parser-eci.js';
import { singleA10InstanceTypes } from '../../config/document-parser-eci.js';
import type { EcsInstance } from '../../integrations/ecs-power.js';
import { GpuSpotAllocator } from '../../integrations/gpu-spot/allocator.js';
import { allocationHash, digest, validateRef } from '../../integrations/gpu-spot/spec.js';
import { EciProviderError, GpuAllocationError, type GpuSpotProvider, type GpuInstanceRef } from '../../integrations/gpu-spot/types.js';
import { ParserMachineError, type ParserMachineRedis, type ParserEciTarget, type MachinePhase } from './redis.js';

export interface ParserEciProvider extends GpuSpotProvider {
  findByAllocation(spec: { regionId: string; vpcId: string }, ownerHash: string): Promise<GpuInstanceRef | null>;
}
export const privateIpv4 = (ip: string) => isIP(ip) === 4 && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip);
const pending = (error: unknown) => error instanceof EciProviderError && ['transient', 'throttled'].includes(error.kind);

/** Uses the machine's Redis control lock, semaphore and unknown-work fence throughout. */
export class DocumentParserEciFallback {
  private readonly allocator: GpuSpotAllocator;
  constructor(private readonly state: ParserMachineRedis, private readonly config: DocumentParserEciConfig, private readonly provider: ParserEciProvider) {
    // One bounded cloud attempt per control lock; known stock rejections retry on later polls.
    this.allocator = new GpuSpotAllocator(provider, { maxAttempts: 1 });
  }
  async select(token: string, instance: EcsInstance): Promise<void> {
    if (instance.status !== 'Stopped' || instance.stoppedMode !== 'StopCharging'
      || instance.chargeType !== 'PostPaid' || instance.spotStrategy !== 'NoSpot' || instance.networkType !== 'vpc'
      || instance.vpcId !== this.config.spec.vpcId || instance.regionId !== this.config.spec.regionId
      || !singleA10InstanceTypes.includes(instance.instanceType as typeof singleA10InstanceTypes[number])) {
      throw new ParserMachineError('DOCUMENT_PARSER_ECS_FALLBACK_INELIGIBLE');
    }
    await this.state.setEciTarget(token, { allocationId: randomUUID() });
  }
  private reference(target: ParserEciTarget): GpuInstanceRef {
    const checkpoint = target.checkpoint;
    if (!checkpoint || checkpoint.allocationId !== target.allocationId || checkpoint.requestHash !== digest(JSON.stringify(this.config.spec))
      || !Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 0
      || !['prepared', 'unknown', 'retryable', 'capacity_unavailable', 'submitted'].includes(checkpoint.phase)) throw new ParserMachineError('DOCUMENT_PARSER_ECI_CHECKPOINT_INVALID');
    const ref = { regionId: this.config.spec.regionId, vpcId: this.config.spec.vpcId,
      allocationHash: allocationHash(target.allocationId), containerGroupId: checkpoint.containerGroupId ?? '' };
    if (checkpoint.phase === 'submitted') validateRef(ref);
    else if (checkpoint.containerGroupId !== undefined) throw new ParserMachineError('DOCUMENT_PARSER_ECI_CHECKPOINT_INVALID');
    return ref;
  }
  async observe(target:ParserEciTarget):Promise<{status:string;ready:boolean}>{
    if(!target.checkpoint||target.checkpoint.phase!=='submitted')return {status:target.rejected?'Failed':'Pending',ready:false};
    const snapshot=await this.provider.describe(this.reference(target));
    return {status:snapshot?.status??'Absent',ready:snapshot?.status==='Running'&&snapshot.containersReady===true};
  }
  private async reconcile(token: string, target: ParserEciTarget): Promise<ParserEciTarget> {
    if (!target.checkpoint) return target;
    this.reference(target);
    if (!['prepared', 'unknown'].includes(target.checkpoint.phase)) return target;
    // Never re-create after an ambiguous response or process crash, even if a tag query is empty.
    const ref = await this.provider.findByAllocation(this.config.spec, allocationHash(target.allocationId));
    if (!ref) return target;
    validateRef(ref);
    if (ref.regionId !== this.config.spec.regionId || ref.vpcId !== this.config.spec.vpcId || ref.allocationHash !== allocationHash(target.allocationId)) throw new ParserMachineError('DOCUMENT_PARSER_ECI_OWNERSHIP_MISMATCH');
    target = { ...target, checkpoint: { ...target.checkpoint, phase: 'submitted', containerGroupId: ref.containerGroupId } };
    await this.state.setEciTarget(token, target);
    return target;
  }
  async online(token: string, phase: MachinePhase, allowCreate = true): Promise<boolean> {
    const status = await this.state.status();
    let target = status?.eciTarget;
    if (!target) throw new ParserMachineError('DOCUMENT_PARSER_ECI_TARGET_MISSING');
    if (phase === 'stopping' || phase === 'unknown-stop') return false;
    if (target.rejected) throw new ParserMachineError('DOCUMENT_PARSER_ECI_CREATE_REJECTED');
    try {
      const reconciled = await this.reconcile(token, target);
      if (reconciled !== target) return false;
      const checkpoint = target.checkpoint;
      if (!checkpoint || ['capacity_unavailable', 'retryable'].includes(checkpoint.phase)) {
        if (!allowCreate || (target.retryAfterMs ?? 0) > status!.redisTimeMs) return false;
        try {
          await this.allocator.submit(this.config.spec, {
            allocationId: target.allocationId, checkpoint,
            persist: async next => {
              target = { ...target!, checkpoint: next };
              await this.state.setEciTarget(token, target);
            },
          });
        } catch (error) {
          if (error instanceof GpuAllocationError) {
            if (error.code === 'GPU_CHECKPOINT_SAVE_FAILED') throw new ParserMachineError('DOCUMENT_PARSER_COORDINATION_UNKNOWN');
            target = { ...target, checkpoint: error.checkpoint, retryAfterMs: status!.redisTimeMs + this.config.retryMs };
            await this.state.setEciTarget(token, target);
            return false;
          }
          if (error instanceof EciProviderError && ['fatal', 'not_found'].includes(error.kind)) {
            await this.state.setEciTarget(token, { ...target, rejected: true });
          }
          throw error;
        }
        // Observe Running/metadata in a later bounded control-lock operation.
        return false;
      }
      if (target.checkpoint?.phase !== 'submitted') return false;
      const snapshot = await this.provider.describe(this.reference(target));
      if (!snapshot) return false;
      if (snapshot.spotStrategy !== 'NoSpot' && (snapshot.status === 'Running' || snapshot.spotStrategy !== 'Unknown')) throw new ParserMachineError('DOCUMENT_PARSER_ECI_NOT_PAY_AS_YOU_GO');
      if (['Failed', 'ScheduleFailed', 'Succeeded', 'Expired', 'Terminating'].includes(snapshot.status)) throw new ParserMachineError('DOCUMENT_PARSER_ECI_START_FAILED');
      if (snapshot.status !== 'Running' || !snapshot.containersReady) return false;
      if (!snapshot.instanceType || !this.config.spec.instanceTypes.includes(snapshot.instanceType) || !snapshot.privateIp || !privateIpv4(snapshot.privateIp)
        || (target.privateIp && target.privateIp !== snapshot.privateIp)) throw new ParserMachineError('DOCUMENT_PARSER_ECI_TARGET_MISMATCH');
      await this.state.setEciTarget(token, { ...target, privateIp: snapshot.privateIp });
      if (phase !== 'ready') await this.state.phase(token, 'ready');
      return true;
    } catch (error) {
      if (pending(error)) return false;
      if (error instanceof EciProviderError) throw new ParserMachineError('DOCUMENT_PARSER_ECI_API_REJECTED');
      throw error;
    }
  }
  /** Returns true only after an accepted deletion is observed absent, or no create was ever accepted. */
  async cleanup(token: string): Promise<boolean> {
    const target = (await this.state.status())?.eciTarget;
    if (!target) return true;
    try {
      if (!target.rejected) {
        const reconciled = await this.reconcile(token, target);
        if (reconciled !== target) return false;
      }
      if (!target.checkpoint || target.rejected || ['capacity_unavailable', 'retryable'].includes(target.checkpoint.phase)) {
        await this.state.setEciTarget(token, undefined); await this.state.phase(token, 'ready'); return true;
      }
      if (target.checkpoint.phase !== 'submitted') return false;
      const ref = this.reference(target), snapshot = await this.provider.describe(ref);
      if (!snapshot) {
        if (!target.deleteAccepted) return false;
        // Exact tag reconciliation also has to be empty; an unknown delete never authorizes replacement.
        if (await this.provider.findByAllocation(this.config.spec, ref.allocationHash)) return false;
        await this.state.setEciTarget(token, undefined); await this.state.phase(token, 'ready'); return true;
      }
      if (snapshot.status === 'Terminating') return false;
      await this.allocator.release(ref);
      await this.state.setEciTarget(token, { ...target, deleteAccepted: true });
      return false;
    } catch (error) {
      if (pending(error)) { await this.state.phase(token, 'unknown-stop'); return false; }
      if (error instanceof EciProviderError) throw new ParserMachineError('DOCUMENT_PARSER_ECI_CLEANUP_REJECTED');
      throw error;
    }
  }
  async baseUrl(): Promise<string | undefined> {
    const target = (await this.state.status())?.eciTarget;
    if (!target) return undefined;
    if (!target.privateIp || !privateIpv4(target.privateIp) || target.checkpoint?.phase !== 'submitted') throw new ParserMachineError('DOCUMENT_PARSER_ECI_NOT_READY');
    return `http://${target.privateIp}:${this.config.spec.port}`;
  }
}
