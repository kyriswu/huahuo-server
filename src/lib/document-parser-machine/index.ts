import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import type { EnabledDocumentParserMachineConfig } from '../../config/document-parser-machine.js';
import { AliyunEcsPower, EcsPowerError, assertEconomicalStopEligible, isEcsCapacityRejection, type EcsPowerPort } from '../../integrations/ecs-power.js';
import { AliyunEciGpuProvider } from '../../integrations/gpu-spot/aliyun-eci.js';
import { DocumentParserEciFallback, type ParserEciProvider } from './eci-fallback.js';
import { ParserMachineRedis, ParserMachineError, type MachinePhase } from './redis.js';
import { ParserMachineIdleMonitor, type MonitorEvents } from './monitor.js';
import {currentTraceId} from '../trace.js';

export { ParserMachineError, ParserMachineRedis } from './redis.js';
export type { MachineState, MachinePhase } from './redis.js';
export interface ParserRequest {
  /** A manual cloud boot completes at Running; document execution still requires service readiness. */
  readiness?:'instance';
  /** Durable callers yield instead of holding a Worker slot while queueing/booting. */
  step?:boolean;
  /** Cancels queue/startup waiting only. Submitted durable work uses its remote cancellation protocol. */
  admissionSignal?:AbortSignal;
  /** Internal recovery only: take over the existing slot and QUERY a persisted remote job; never resubmit. */
  resume?: boolean;
  /** Only after durable task state proves that no remote submission intent exists. */
  recoverAdmission?: boolean;
  /** Durable task/request identity; all redeliveries must use the same value. */
  requestId: string;
  /** SHA256 of document revision/content identity AND all parsing options. */
  fingerprint: string;
  signal?: AbortSignal;
}
export interface ParserContext { baseUrl: string; headers: Readonly<Record<string, string>>; signal: AbortSignal }
export interface MachineObservation {
  state:'online'|'offline'|'starting'|'stopping'|'unknown';source:'ecs'|'eci'|'http';
  serviceReady:boolean|null;serviceStatus:'ready'|'unreachable'|'not_checked'|'not_running';canStart:boolean;instanceStatus?:string;reason?:string;
}
/** Use settled only after proving the remote parser has finished or never received the request. */
export class ParserExecutionError extends Error {
  constructor(readonly code: string, readonly outcome: 'settled' | 'unknown' = 'unknown') {
    super(/^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? code : 'DOCUMENT_PARSER_EXECUTION_FAILED');
    this.name = 'ParserExecutionError';
  }
}
export class ParserExecutionDeferred extends Error {
  constructor(readonly phase:'admitting'|'external',readonly delayMs=60000){super('DOCUMENT_PARSER_DEFERRED');this.name='ParserExecutionDeferred';}
}
function identity(input: ParserRequest): string {
  if (!input.requestId.trim() || input.requestId.length > 256 || !/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new ParserMachineError('DOCUMENT_PARSER_REQUEST_INVALID');
  return createHash('sha256').update(input.requestId).digest('hex');
}
async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  try { await sleep(ms, undefined, { signal }); }
  catch { throw new ParserMachineError('DOCUMENT_PARSER_CANCELLED'); }
}
const assertNotAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw new ParserMachineError('DOCUMENT_PARSER_CANCELLED');
};
type HealthCheck = (context: ParserContext) => Promise<boolean>;
export type IdleAction = 'always_on' | 'unmanaged' | 'control_disabled' | 'busy' | 'transition_pending' | 'start_observed' | 'stop_submitted' | 'stop_confirmed' | 'already_stopped';

export class DocumentParserMachine {
  private readonly healthy: HealthCheck;
  private readonly eci?: DocumentParserEciFallback;
  constructor(readonly state: ParserMachineRedis, private readonly cloud: EcsPowerPort | undefined, private readonly config: EnabledDocumentParserMachineConfig, healthCheck?: HealthCheck, eciProvider?: ParserEciProvider) {
    if (config.mode === 'ecs' && !cloud) throw new ParserMachineError('DOCUMENT_PARSER_ECS_REQUIRED');
    if (config.mode === 'ecs' && config.eciFallback) this.eci = new DocumentParserEciFallback(state, config.eciFallback,
      eciProvider ?? new AliyunEciGpuProvider({ regionId: config.regionId, credentials: config.credentials,
        connectTimeoutMs: 1000, readTimeoutMs: 6000, workloadRamCredentials: true }));
    this.healthy = healthCheck ?? (async ({ baseUrl, signal, headers }) => {
      if (!config.healthPath) return true;
      try {
        const response = await fetch(new URL(config.healthPath, baseUrl), {
          method: 'GET', headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
        });
        await response.body?.cancel();
        return response.status === 200;
      } catch { return false; }
    });
  }
  private async confirmStopped(token: string): Promise<void> {
    await this.state.confirmStopped(token);
  }
  private async rejectedOperation(token: string, operation: 'start' | 'stop', error: unknown): Promise<never> {
    await this.state.phase(token, error instanceof EcsPowerError && error.outcome === 'rejected' ? 'ready' : `unknown-${operation}`);
    throw error instanceof EcsPowerError ? error : new EcsPowerError('ECS_API_FAILED', 'unknown');
  }
  private async online(id: string, owner: string,allowFallback=true): Promise<boolean> {
    if (this.config.mode === 'always-on') return true;
    const cloud = this.cloud!;
    const token = randomUUID(), phase = await this.state.lock(token, 'request', id, owner);
    if (!phase) return false;
    try {
      if ((await this.state.status())?.eciTarget){
        if(!allowFallback)throw new ParserMachineError('PROCESSING_NODE_PRIMARY_INSTANCE_BUSY');
        // Keep reconciling existing allocations, but never create when power control is disabled.
        return await this.eci!.online(token, phase, this.config.powerControlEnabled!==false);
      }
      const instance = await cloud.describe();
      if (phase === 'stopping' || phase === 'unknown-stop') {
        if (instance.status === 'Stopped') {
          if (instance.stoppedMode !== 'StopCharging') {
            await this.state.phase(token, 'blocked'); throw new EcsPowerError('ECS_STOP_NOT_ECONOMICAL');
          }
          await this.confirmStopped(token);
        }
        return false;
      }
      if (instance.status === 'Running') {
        if (phase === 'starting' || phase === 'unknown-start') await this.state.phase(token, 'ready');
        return true;
      }
      if (instance.status === 'Stopped' && phase === 'ready') {
        if(this.config.powerControlEnabled===false)throw new ParserMachineError('PROCESSING_NODE_CLOUD_CONTROL_DISABLED');
        assertEconomicalStopEligible(instance);
        // Persist intent BEFORE the RPC. A new owner reconciles it instead of resubmitting.
        if (await this.state.phase(token, 'starting', id, owner)) {
          try { await cloud.start(); }
          catch (error) {
            if (allowFallback&&this.eci && isEcsCapacityRejection(error)) {
              // A definitive rejected start cannot have allocated ECS compute. Never race two clouds.
              try { await this.eci.select(token, instance); }
              catch (selectionError) {
                if (selectionError instanceof ParserMachineError && selectionError.code === 'DOCUMENT_PARSER_ECS_FALLBACK_INELIGIBLE') await this.state.phase(token, 'ready');
                throw selectionError;
              }
              return false;
            }
            return await this.rejectedOperation(token, 'start', error);
          }
        }
      }
      return false;
    } finally { await this.state.unlock(token); }
  }
  private async ready(id: string, owner: string, signal: AbortSignal,powerOnly=false): Promise<void> {
    const until = Date.now() + this.config.startupTimeoutMs;
    while (Date.now() < until) {
      assertNotAborted(signal);
      if (await this.online(id, owner,!powerOnly)) {
        if (powerOnly||await this.healthy(await this.context(signal))) return;
      }
      await pause(this.config.pollMs, signal);
    }
    throw new ParserMachineError('DOCUMENT_PARSER_STARTUP_TIMEOUT');
  }
  private async context(signal: AbortSignal): Promise<ParserContext> {
    const headers: Record<string, string> = this.config.apiToken ? { Authorization: `Bearer ${this.config.apiToken}` } : {};
    const traceId=currentTraceId();if(traceId)headers['X-Trace-Id']=traceId;
    return { baseUrl: await this.eci?.baseUrl() ?? this.config.baseUrl, signal, headers: Object.freeze(headers) };
  }

  /** Read-only cloud/health observation. Never acquires a power lock or starts/stops a machine. */
  async observe(probeService=true):Promise<MachineObservation>{
    let source:MachineObservation['source']=this.config.mode==='ecs'?'ecs':'http';
    const result=(state:MachineObservation['state'],serviceStatus:MachineObservation['serviceStatus'],canStart=false,instanceStatus?:string,reason?:string):MachineObservation=>({state,source,serviceStatus,serviceReady:serviceStatus==='not_checked'?null:serviceStatus==='ready',canStart,instanceStatus,reason});
    try{
      const signal=AbortSignal.timeout(12000),coordination=await this.state.status();
      const service=async()=>probeService?(await this.healthy(await this.context(signal))?'ready':'unreachable') as 'ready'|'unreachable':'not_checked' as const;
      if(coordination?.eciTarget){
        source='eci';const snapshot=await this.eci!.observe(coordination.eciTarget);
        if(['Pending','Scheduling','Creating','Restarting'].includes(snapshot.status))return result('starting','not_running',false,snapshot.status);
        if(snapshot.status==='Terminating')return result('stopping','not_running',false,snapshot.status);
        if(snapshot.status!=='Running')return result('offline','not_running',false,snapshot.status);
        return result('online',!probeService?'not_checked':snapshot.ready?await service():'unreachable',false,snapshot.status);
      }
      if(this.config.mode==='ecs'){
        const instance=await this.cloud!.describe();
        if(instance.status==='Stopped'){
          try{assertEconomicalStopEligible(instance);}catch{return result('offline','not_running',false,instance.status,'ECS_ECONOMICAL_STOP_UNSUPPORTED');}
          const canStart=this.config.powerControlEnabled!==false&&(!coordination||coordination.phase==='ready'&&!coordination.active&&!coordination.queued&&!coordination.uncertain);
          return result('offline','not_running',canStart,instance.status);
        }
        if(instance.status==='Starting'||instance.status==='Pending')return result('starting','not_running',false,instance.status);
        if(instance.status==='Stopping')return result('stopping','not_running',false,instance.status);
        return result('online',await service(),false,instance.status);
      }
      const readiness=await service();
      return result(readiness==='not_checked'?'unknown':readiness==='ready'?'online':'offline',readiness);
    }catch(error){
      const code=(error as {code?:unknown}).code??(error instanceof Error?error.message:undefined);
      return result('unknown','not_checked',false,undefined,typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(code)?code:'PROCESSING_NODE_STATUS_UNAVAILABLE');
    }
  }

  /** Wrap the complete remote parse, including uploads/result collection, with this method. */
  async withDocumentParser<T>(input: ParserRequest, execute: (context: ParserContext) => Promise<T>): Promise<T> {
    const id = identity(input), owner = randomUUID(), controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal;
    const admissionSignal=input.admissionSignal?AbortSignal.any([signal,input.admissionSignal]):signal;
    assertNotAborted(admissionSignal);
    let admissionResumed=false;
    if(input.recoverAdmission){
      const deadline=Date.now()+this.config.startupTimeoutMs;
      while(true){
        const result=await this.state.recoverAdmission(id,owner,input.fingerprint);
        if(result!=='wait'){admissionResumed=result==='resumed';break;}
        if(input.step)throw new ParserExecutionDeferred('admitting',3000);
        if(Date.now()>=deadline)throw new ParserMachineError('DOCUMENT_PARSER_RESUME_TIMEOUT');
        await pause(this.config.pollMs,admissionSignal);
      }
    }else if(input.resume){
      const deadline=Date.now()+this.config.startupTimeoutMs;
      while(!await this.state.resume(id,owner,input.fingerprint)){
        if(input.step)throw new ParserExecutionDeferred('external',60000);
        if(Date.now()>=deadline)throw new ParserMachineError('DOCUMENT_PARSER_RESUME_TIMEOUT');
        await pause(this.config.pollMs,admissionSignal);
      }
    }else await this.state.register(id, owner, input.fingerprint);
    let closed = false, timer: NodeJS.Timeout | undefined, heartbeat: Promise<void> | undefined;
    const pulse = () => {
      heartbeat = this.state.renew(id, owner).catch(() => { controller.abort(); }).finally(() => {
        if (!closed && !signal.aborted) { timer = setTimeout(pulse, Math.floor(this.config.leaseMs / 3)); timer.unref(); }
      });
    };
    timer = setTimeout(pulse, Math.floor(this.config.leaseMs / 3)); timer.unref();
    let submitted = Boolean(input.resume), outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown'|'admitting'|'external' = input.resume?'unknown':'cancelled', value: T | undefined, failure: unknown;
    try {
      const queueDeadline = Date.now() + this.config.queueTimeoutMs;
      while (!input.resume&&!admissionResumed&&!await this.state.claim(id, owner)) {
        if(input.step)throw new ParserExecutionDeferred('admitting',3000);
        assertNotAborted(admissionSignal);
        if (Date.now() >= queueDeadline) throw new ParserMachineError('DOCUMENT_PARSER_QUEUE_TIMEOUT');
        // Also reconcile a stop already underway, so a caller can work without a local timer.
        await this.tick();
        await pause(this.config.pollMs, admissionSignal);
      }
      if(input.step&&input.resume){/* A persisted job is queried on its original service; never restart it to resume. */}
      else if(input.step){
        if(!await this.online(id,owner,input.readiness!=='instance')||(input.readiness!=='instance'&&!await this.healthy(await this.context(admissionSignal))))throw new ParserExecutionDeferred('admitting',3000);
      }else await this.ready(id, owner, admissionSignal,input.readiness==='instance');
      assertNotAborted(admissionSignal);
      await this.state.renew(id, owner);
      assertNotAborted(admissionSignal);
      const context = await this.context(signal);
      assertNotAborted(admissionSignal);
      submitted = true;
      value = await execute(context);
      outcome = 'succeeded';
    } catch (error) {
      if(error instanceof ParserExecutionDeferred){outcome=error.phase;failure=error;}
      else{
      outcome = !submitted ? 'cancelled' : error instanceof ParserExecutionError && error.outcome === 'settled' ? 'failed' : 'unknown';
      failure = !submitted && (error instanceof ParserMachineError || error instanceof EcsPowerError) ? error
        : new ParserMachineError(outcome === 'unknown' ? 'DOCUMENT_PARSER_EXECUTION_UNKNOWN' : 'DOCUMENT_PARSER_EXECUTION_FAILED');
      }
    } finally {
      closed = true; if (timer) clearTimeout(timer); await heartbeat;
      try { await this.state.finish(id, owner, input.fingerprint, outcome); }
      catch { failure = new ParserMachineError('DOCUMENT_PARSER_COORDINATION_UNKNOWN'); }
    }
    if (failure) throw failure;
    return value as T;
  }

  /** Redis TIME, not host clocks, decides idleness; the monitor wakes on events/timers. */
  async tick(): Promise<IdleAction> {
    if (this.config.mode === 'always-on') return 'always_on';
    if(this.config.powerControlEnabled===false)return 'control_disabled';
    const cloud = this.cloud!;
    const token = randomUUID(), phase: MachinePhase | undefined = await this.state.lock(token, 'idle');
    if (!phase) return (await this.state.status()) ? 'busy' : 'unmanaged';
    try {
      if(phase==='ready'&&this.config.canStop&&!await this.config.canStop())return 'busy';
      if ((await this.state.status())?.eciTarget) {
        if (phase === 'stopping' || phase === 'unknown-stop' || await this.state.beginEciStop(token)) {
          if (!await this.eci!.cleanup(token)) return 'transition_pending';
          // ECI is gone; confirm the preferred ECS still has no billable compute before sleeping.
          const primary = await cloud.describe();
          if (primary.status === 'Stopped' && primary.stoppedMode === 'StopCharging') {
            await this.confirmStopped(token); return 'stop_confirmed';
          }
          return 'transition_pending';
        }
        if (phase === 'starting' || phase === 'unknown-start') {
          return await this.eci!.online(token, phase, false) ? 'start_observed' : 'transition_pending';
        }
        return 'busy';
      }
      const instance = await cloud.describe();
      if (phase === 'stopping' || phase === 'unknown-stop') {
        if (instance.status !== 'Stopped') return 'transition_pending';
        if (instance.stoppedMode !== 'StopCharging') {
          await this.state.phase(token, 'blocked'); throw new EcsPowerError('ECS_STOP_NOT_ECONOMICAL');
        }
        await this.confirmStopped(token);
        return 'stop_confirmed';
      }
      if (phase === 'starting' || phase === 'unknown-start') {
        if (instance.status !== 'Running') return 'transition_pending';
        await this.state.phase(token, 'ready'); return 'start_observed';
      }
      if (instance.status === 'Stopped') {
        if (instance.stoppedMode !== 'StopCharging') {
          await this.state.phase(token, 'blocked'); throw new EcsPowerError('ECS_STOP_NOT_ECONOMICAL');
        }
        await this.confirmStopped(token); return 'already_stopped';
      }
      if (instance.status !== 'Running') return 'transition_pending';
      assertEconomicalStopEligible(instance);
      // Recheck admission atomically after DescribeInstances: arrivals during the RPC win.
      if (!await this.state.phase(token, 'stopping')) return 'busy';
      try { await cloud.stopEconomically(); }
      catch (error) { return await this.rejectedOperation(token, 'stop', error); }
      return 'stop_submitted';
    } finally { await this.state.unlock(token); }
  }

  /** Internal reconciliation ONLY after an authoritative parser/task result proves completion. */
  async acknowledgeSettled(input: ParserRequest): Promise<void> { await this.state.resolve(identity(input), input.fingerprint); }
}

export function createDocumentParserMachine(config: EnabledDocumentParserMachineConfig, redisUrl: string, prefix: string) {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 0, enableOfflineQueue: false, connectTimeout: 1500, commandTimeout: 2000, lazyConnect: true });
  redis.on('error', () => undefined);
  const state = new ParserMachineRedis(redis, config, prefix);
  const machine = new DocumentParserMachine(state, config.mode === 'ecs' ? new AliyunEcsPower(config) : undefined, config);
  let monitor: ParserMachineIdleMonitor | undefined;
  let monitorStart: Promise<void> | undefined;
  let closed = false;
  let closeTask: Promise<void> | undefined;
  let statusSubscriber:Redis|undefined,statusConnecting:Promise<void>|undefined;
  const statusListeners=new Set<()=>void>();
  const statusChanged=()=>{for(const changed of statusListeners)changed();};
  const subscribeStatus=async()=>{await statusSubscriber?.subscribe(state.eventsChannel);statusChanged();};
  return {
    machine,
    async connect() { try { await redis.connect(); } catch { throw new ParserMachineError('DOCUMENT_PARSER_REDIS_UNAVAILABLE'); } },
    async watch(changed:()=>void){
      statusListeners.add(changed);
      if(!statusSubscriber){statusSubscriber=redis.duplicate({lazyConnect:true});statusSubscriber.on('error',()=>undefined);statusSubscriber.on('message',channel=>{if(channel===state.eventsChannel)statusChanged();});statusSubscriber.on('ready',()=>{void subscribeStatus().catch(()=>undefined);});statusConnecting=statusSubscriber.connect().then(()=>subscribeStatus());}
      try{await statusConnecting;}catch(error){statusListeners.delete(changed);if(!statusListeners.size){statusSubscriber?.disconnect();statusSubscriber=undefined;statusConnecting=undefined;}throw error;}
      return ()=>{statusListeners.delete(changed);if(!statusListeners.size){statusSubscriber?.disconnect();statusSubscriber=undefined;statusConnecting=undefined;}};
    },
    startIdleMonitor(events: MonitorEvents = {}): Promise<void> {
      if (closed || config.mode !== 'ecs') return Promise.resolve();
      if (monitorStart) return monitorStart;
      const subscriber = redis.duplicate({ lazyConnect: true });
      subscriber.on('error', () => undefined);
      const next = new ParserMachineIdleMonitor(machine, subscriber, state.eventsChannel, config.idleMs, events);
      monitor = next;
      monitorStart = next.start().catch(async error => {
        await next.close();
        monitor = undefined;
        monitorStart = undefined;
        throw error;
      });
      return monitorStart;
    },
    close(): Promise<void> {
      closed = true;
      return closeTask ??= (async () => {
        statusListeners.clear(); statusSubscriber?.disconnect(); statusSubscriber = undefined;
        const monitorClosed = monitor?.close();
        await Promise.all([statusConnecting?.catch(() => undefined), monitorClosed, monitorStart?.catch(() => undefined)]);
        redis.disconnect();
      })();
    },
  };
}
