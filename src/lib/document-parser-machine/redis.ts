import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { EnabledDocumentParserMachineConfig } from '../../config/document-parser-machine.js';
import type { GpuAllocationCheckpoint } from '../../integrations/gpu-spot/types.js';

export interface ParserEciTarget {
  allocationId: string;
  checkpoint?: GpuAllocationCheckpoint;
  privateIp?: string;
  retryAfterMs?: number;
  rejected?: true;
  deleteAccepted?: true;
}

export type MachinePhase = 'ready' | 'starting' | 'stopping' | 'unknown-start' | 'unknown-stop' | 'blocked';
export interface MachineState {
  phase: MachinePhase; queued: number; active: number; uncertain: number;
  economicallyStopped: boolean;
  lastActivityMs: number; redisTimeMs: number; reason?: string;
  eciTarget?: ParserEciTarget;
}
export class ParserMachineError extends Error {
  constructor(readonly code: string, readonly requestState?: string) { super(code); this.name = 'ParserMachineError'; }
}

// One script serializes admission, semaphore, deduplication and shutdown intent.
// Active work is NEVER removed merely because its owner stopped heartbeating.
const script = `
local meta, jobs, waiting, active, lock, receipt = unpack(KEYS)
local op, signature, id, owner, fingerprint = ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5]
local lease, idle, capacity, maxPending, receiptTtl = tonumber(ARGV[6]), tonumber(ARGV[7]), tonumber(ARGV[8]), tonumber(ARGV[9]), tonumber(ARGV[10])
local token, value = ARGV[11], ARGV[12]
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local function result(code, data) return cjson.encode({code=code, data=data}) end
local function notify() redis.call('PUBLISH', string.sub(meta, 1, -6) .. 'events', 'changed') end
local exists = redis.call('EXISTS', meta) == 1
if not exists then
  if redis.call('HLEN', jobs) > 0 or redis.call('ZCARD', waiting) > 0 or redis.call('ZCARD', active) > 0 then return result('STATE_MISSING') end
  if op ~= 'register' then return result('UNMANAGED') end
  redis.call('HSET', meta, 'signature', signature, 'phase', 'ready', 'lastActivity', now, 'sequence', 0)
elseif op == 'configure' then
  if redis.call('HLEN', jobs) > 0 or redis.call('ZCARD', waiting) > 0 or redis.call('ZCARD', active) > 0
    or redis.call('EXISTS', lock) == 1 or redis.call('HEXISTS', meta, 'eciTarget') == 1
    or redis.call('HGET', meta, 'phase') ~= 'ready' then return result('BUSY') end
  redis.call('HSET', meta, 'signature', signature, 'lastActivity', now)
  notify()
  return result('OK')
elseif redis.call('HGET', meta, 'signature') ~= signature then return result('CONFIG_MISMATCH') end
local phase = redis.call('HGET', meta, 'phase')
if redis.call('HLEN', jobs) ~= redis.call('ZCARD', waiting) + redis.call('ZCARD', active) then return result('STATE_INCONSISTENT') end
local function jobFor(key)
  local raw = redis.call('HGET', jobs, key)
  if raw then return cjson.decode(raw) end
end
-- Only a queued request is safe to reclaim after its owner dies: no parser call occurred.
for _, key in ipairs(redis.call('ZRANGE', waiting, 0, -1)) do
  local job = jobFor(key)
  if not job or job.stage ~= 'queued' then return result('STATE_INCONSISTENT') end
  if job.expires <= now then redis.call('ZREM', waiting, key); redis.call('HDEL', jobs, key) end
end
local uncertain = 0
for _, key in ipairs(redis.call('ZRANGE', active, 0, -1)) do
  local job = jobFor(key)
  if not job or (job.stage ~= 'active' and job.stage ~= 'unknown') then return result('STATE_INCONSISTENT') end
  if job.expires <= now and job.stage == 'active' then
    job.stage = 'unknown'; redis.call('HSET', jobs, key, cjson.encode(job)); notify()
  end
  if job.stage == 'unknown' then uncertain = uncertain + 1 end
end
local function touch() redis.call('HSET', meta, 'lastActivity', now); notify() end
local function idleEnough()
  return redis.call('ZCARD', waiting) == 0 and redis.call('ZCARD', active) == 0
    and now - tonumber(redis.call('HGET', meta, 'lastActivity')) >= idle
end
local function ownedActive()
  local job = jobFor(id)
  return job and job.owner == owner and job.stage == 'active' and job.expires > now
end
if op == 'status' then
  return result('OK', {phase=phase, queued=redis.call('ZCARD', waiting), active=redis.call('ZCARD', active), uncertain=uncertain,
    economicallyStopped=redis.call('HGET', meta, 'economicallyStopped') == '1',
    eciTarget=redis.call('HGET', meta, 'eciTarget') and cjson.decode(redis.call('HGET', meta, 'eciTarget')) or nil,
    lastActivityMs=tonumber(redis.call('HGET', meta, 'lastActivity')), redisTimeMs=now, reason=redis.call('HGET', meta, 'reason') or nil})
elseif op == 'register' then
  touch()
  local previous = redis.call('GET', receipt)
  local job = jobFor(id)
  if previous then
    local completed = cjson.decode(previous)
    if completed.fingerprint ~= fingerprint then return result('CONFLICT') end
    if completed.stage ~= 'cancelled' then job = completed end
  end
  if job then
    if job.fingerprint ~= fingerprint then return result('CONFLICT') end
    return result('DUPLICATE', job.stage)
  end
  if uncertain > 0 or phase == 'blocked' then return result('UNCERTAIN') end
  if redis.call('ZCARD', waiting) >= maxPending then return result('QUEUE_FULL') end
  job = {owner=owner, fingerprint=fingerprint, stage='queued', expires=now+lease}
  redis.call('HSET', jobs, id, cjson.encode(job))
  redis.call('HSET', meta, 'economicallyStopped', '0')
  redis.call('ZADD', waiting, redis.call('HINCRBY', meta, 'sequence', 1), id)
  return result('OK')
elseif op == 'claim' then
  local job = jobFor(id)
  if not job or job.owner ~= owner or job.stage ~= 'queued' then return result('LEASE_LOST') end
  if uncertain > 0 or phase == 'blocked' then return result('UNCERTAIN') end
  if (phase ~= 'ready' and phase ~= 'starting' and phase ~= 'unknown-start') or redis.call('ZCARD', active) >= capacity
    or redis.call('ZRANGE', waiting, 0, 0)[1] ~= id then return result('WAIT') end
  job.stage = 'active'; job.expires = now+lease
  redis.call('HSET', jobs, id, cjson.encode(job)); redis.call('ZREM', waiting, id); redis.call('ZADD', active, job.expires, id)
  return result('OK')
elseif op == 'resume' then
  local job = jobFor(id)
  if not job or job.fingerprint ~= fingerprint then return result('LEASE_LOST') end
  if job.stage == 'active' then return result('WAIT') end
  if job.stage ~= 'unknown' or phase == 'blocked' then return result('NOT_UNCERTAIN') end
  job.owner = owner; job.stage = 'active'; job.expires = now+lease
  redis.call('HSET', jobs, id, cjson.encode(job)); redis.call('ZADD', active, job.expires, id); notify()
  return result('OK')
elseif op == 'renew' then
  local job = jobFor(id)
  if not job or job.owner ~= owner or job.stage == 'unknown' then return result('LEASE_LOST') end
  job.expires = now+lease; redis.call('HSET', jobs, id, cjson.encode(job))
  if job.stage == 'active' then redis.call('ZADD', active, job.expires, id) end
  return result('OK')
elseif op == 'finish' or op == 'resolve' then
  local job = jobFor(id)
  if not job or job.fingerprint ~= fingerprint then return result('LEASE_LOST') end
  if op == 'resolve' then
    if job.stage ~= 'unknown' and job.stage ~= 'active' then return result('NOT_UNCERTAIN') end
  elseif job.owner ~= owner then return result('LEASE_LOST') end
  if value == 'unknown' then
    if job.stage == 'queued' then return result('STATE_INCONSISTENT') end
    job.stage = 'unknown'; redis.call('HSET', jobs, id, cjson.encode(job)); touch(); return result('OK')
  end
  redis.call('SET', receipt, cjson.encode({fingerprint=fingerprint, stage=value}), 'PX', receiptTtl)
  redis.call('HDEL', jobs, id); redis.call('ZREM', waiting, id); redis.call('ZREM', active, id); touch()
  return result('OK')
elseif op == 'lock' then
  if value == 'request' and not ownedActive() then return result('LEASE_LOST') end
  if value == 'idle' and phase == 'ready' and not idleEnough() then return result('NOT_IDLE') end
  if phase == 'blocked' then return result('BLOCKED') end
  if not redis.call('SET', lock, token, 'NX', 'PX', 30000) then return result('LOCKED') end
  return result('OK', phase)
elseif op == 'unlock' then
  if redis.call('GET', lock) == token then redis.call('DEL', lock) end
  return result('OK')
elseif op == 'eci-target' or op == 'begin-eci-stop' then
  if redis.call('GET', lock) ~= token then return result('LOCK_LOST') end
  if op == 'eci-target' then
    if value == '' then redis.call('HDEL', meta, 'eciTarget')
    else redis.call('HSET', meta, 'eciTarget', value, 'economicallyStopped', '0') end
  else
    if not idleEnough() then return result('NOT_IDLE') end
    if redis.call('HEXISTS', meta, 'eciTarget') ~= 1 then return result('STATE_INCONSISTENT') end
    redis.call('HSET', meta, 'phase', 'stopping', 'economicallyStopped', '0')
  end
  notify(); return result('OK')
elseif op == 'phase' or op == 'confirm-stopped' then
  if redis.call('GET', lock) ~= token then return result('LOCK_LOST') end
  if op == 'confirm-stopped' then
    if redis.call('HEXISTS', meta, 'eciTarget') == 1 then return result('STATE_INCONSISTENT') end
    redis.call('HSET', meta, 'phase', 'ready', 'economicallyStopped', '1'); notify(); return result('OK')
  end
  if value == 'starting' and (phase ~= 'ready' or not ownedActive()) then return result('WAIT') end
  if value == 'stopping' and (phase ~= 'ready' or not idleEnough()) then return result('NOT_IDLE') end
  redis.call('HSET', meta, 'phase', value)
  if value == 'starting' or value == 'stopping' then redis.call('HSET', meta, 'economicallyStopped', '0') end
  if value == 'blocked' then redis.call('HSET', meta, 'reason', 'ECS_STOP_NOT_CONFIRMED') end
  notify()
  return result('OK')
end
return result('OP_INVALID')
`;

interface Reply { code: string; data?: unknown }
export class ParserMachineRedis {
  readonly keyPrefix: string;
  readonly eventsChannel: string;
  private readonly signature: string;
  constructor(private readonly redis: Pick<Redis, 'eval'>, private readonly config: EnabledDocumentParserMachineConfig, prefix: string) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(prefix)) throw new ParserMachineError('DOCUMENT_PARSER_PREFIX_INVALID');
    this.keyPrefix = `${prefix}:document-parser:{single}`;
    this.eventsChannel = `${this.keyPrefix}:events`;
    this.signature = createHash('sha256').update(JSON.stringify({
      target: config.mode === 'ecs' ? { mode: config.mode, region: config.regionId, instance: config.instanceId, ip: config.privateIp } : { mode: config.mode },
      baseUrl: config.baseUrl, healthPath: config.healthPath,
      capacity: config.concurrency, idle: config.idleMs, lease: config.leaseMs, maxPending: config.maxPending,
      ...(config.mode === 'ecs' && config.eciFallback ? { eciFallback: config.eciFallback } : {}),
    })).digest('hex');
  }
  private async run(op: string, input: Partial<{ id: string; owner: string; fingerprint: string; token: string; value: string }> = {}): Promise<Reply> {
    const id = input.id ?? '_';
    let raw: unknown;
    try {
      raw = await this.redis.eval(script, 6, ...['state', 'jobs', 'waiting', 'active', 'control', `receipt:${id}`].map(k => `${this.keyPrefix}:${k}`),
        op, this.signature, id, input.owner ?? '', input.fingerprint ?? '', this.config.leaseMs, this.config.idleMs,
        this.config.concurrency, this.config.maxPending, this.config.receiptTtlMs, input.token ?? '', input.value ?? '');
    } catch { throw new ParserMachineError('DOCUMENT_PARSER_REDIS_UNAVAILABLE'); }
    if (typeof raw !== 'string') throw new ParserMachineError('DOCUMENT_PARSER_REDIS_RESPONSE_INVALID');
    let reply: Reply;
    try { reply = JSON.parse(raw) as Reply; } catch { throw new ParserMachineError('DOCUMENT_PARSER_REDIS_RESPONSE_INVALID'); }
    if (['STATE_MISSING', 'STATE_INCONSISTENT', 'CONFIG_MISMATCH', 'OP_INVALID'].includes(reply.code)) throw new ParserMachineError(`DOCUMENT_PARSER_${reply.code}`);
    return reply;
  }
  async register(id: string, owner: string, fingerprint: string) {
    const r = await this.run('register', { id, owner, fingerprint });
    if (r.code !== 'OK') throw new ParserMachineError(`DOCUMENT_PARSER_${r.code}`, typeof r.data === 'string' ? r.data : undefined);
  }
  async claim(id: string, owner: string): Promise<boolean> {
    const r = await this.run('claim', { id, owner });
    if (r.code === 'WAIT') return false;
    if (r.code !== 'OK') throw new ParserMachineError(`DOCUMENT_PARSER_${r.code}`);
    return true;
  }
  async renew(id: string, owner: string): Promise<void> {
    const r = await this.run('renew', { id, owner });
    if (r.code !== 'OK') throw new ParserMachineError(`DOCUMENT_PARSER_${r.code}`);
  }
  async resume(id:string,owner:string,fingerprint:string):Promise<boolean>{
    const r=await this.run('resume',{id,owner,fingerprint});
    if(r.code==='WAIT')return false;
    if(r.code!=='OK')throw new ParserMachineError(`DOCUMENT_PARSER_${r.code}`);
    return true;
  }
  async finish(id: string, owner: string, fingerprint: string, value: 'succeeded' | 'failed' | 'cancelled' | 'unknown'): Promise<void> {
    const r = await this.run('finish', { id, owner, fingerprint, value });
    if (r.code !== 'OK') throw new ParserMachineError(`DOCUMENT_PARSER_${r.code}`);
  }
  async resolve(id: string, fingerprint: string): Promise<void> {
    const r = await this.run('resolve', { id, fingerprint, value: 'settled' });
    if (r.code !== 'OK') throw new ParserMachineError(`DOCUMENT_PARSER_${r.code}`);
  }
  async status(): Promise<MachineState | undefined> {
    const r = await this.run('status');
    if (r.code === 'UNMANAGED') return undefined;
    const state = r.data as MachineState;
    if (state?.eciTarget) {
      const target = state.eciTarget;
      if (this.config.mode !== 'ecs' || !this.config.eciFallback || !/^[a-f0-9-]{36}$/.test(target.allocationId)
        || (target.checkpoint && target.checkpoint.allocationId !== target.allocationId)) throw new ParserMachineError('DOCUMENT_PARSER_STATE_INCONSISTENT');
    }
    return state;
  }
  async setEciTarget(token: string, target: ParserEciTarget | undefined): Promise<void> {
    const r = await this.run('eci-target', { token, value: target ? JSON.stringify(target) : '' });
    if (r.code !== 'OK') throw new ParserMachineError(`DOCUMENT_PARSER_${r.code}`);
  }
  /** Cleanup of a failed/cancelled startup uses the same idle/admission fence as a running service. */
  async beginEciStop(token: string): Promise<boolean> {
    const r = await this.run('begin-eci-stop', { token });
    if (r.code === 'NOT_IDLE') return false;
    if (r.code !== 'OK') throw new ParserMachineError(`DOCUMENT_PARSER_${r.code}`);
    return true;
  }
  /** Explicit rollout step after draining callers; never clears active/unknown work or receipts. */
  async configureWhenIdle(): Promise<void> {
    const r = await this.run('configure');
    if (r.code !== 'OK' && r.code !== 'UNMANAGED') throw new ParserMachineError(`DOCUMENT_PARSER_${r.code}`);
  }
  async lock(token: string, mode: 'idle' | 'request', id?: string, owner?: string): Promise<MachinePhase | undefined> {
    const r = await this.run('lock', { token, value: mode, id, owner });
    if (['UNMANAGED', 'NOT_IDLE', 'LOCKED'].includes(r.code)) return undefined;
    if (r.code !== 'OK') throw new ParserMachineError(`DOCUMENT_PARSER_${r.code}`);
    return r.data as MachinePhase;
  }
  async phase(token: string, value: MachinePhase, id?: string, owner?: string): Promise<boolean> {
    const r = await this.run('phase', { token, value, id, owner });
    if (['WAIT', 'NOT_IDLE'].includes(r.code)) return false;
    if (r.code !== 'OK') throw new ParserMachineError(`DOCUMENT_PARSER_${r.code}`);
    return true;
  }
  async confirmStopped(token: string): Promise<void> {
    const r = await this.run('confirm-stopped', { token });
    if (r.code !== 'OK') throw new ParserMachineError(`DOCUMENT_PARSER_${r.code}`);
  }
  async unlock(token: string): Promise<void> { await this.run('unlock', { token }); }
}
