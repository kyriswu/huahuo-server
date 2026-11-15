import { isIP } from 'node:net';
import type { DocumentParserEciConfig } from './document-parser-eci.js';

interface ParserConfigBase {
  /** Durable machine occupancy guard supplied by the node registry. */
  canStop?:()=>Promise<boolean>;
  coordinationId?: string;
  enabled: true;
  baseUrl: string;
  apiToken?: string;
  healthPath: string;
  concurrency: number;
  maxPending: number;
  idleMs: number;
  startupTimeoutMs: number;
  queueTimeoutMs: number;
  leaseMs: number;
  pollMs: number;
  receiptTtlMs: number;
}
export interface EcsDocumentParserConfig extends ParserConfigBase {
  mode: 'ecs';
  regionId: string;
  instanceId: string;
  privateIp: string;
  eciFallback?: DocumentParserEciConfig;
  credentials: () => Promise<{ accessKeyId: string; accessKeySecret: string; securityToken?: string }>;
}
export interface AlwaysOnDocumentParserConfig extends ParserConfigBase { mode: 'always-on' }
export type EnabledDocumentParserMachineConfig = EcsDocumentParserConfig | AlwaysOnDocumentParserConfig;
export interface ParserMachineOptions {
  mode: 'ecs' | 'always-on';
  baseUrl?: string;
  healthPath?: string;
  apiToken?: string;
  regionId?: string;
  instanceId?: string;
  privateIp?: string;
  credentials?: EcsDocumentParserConfig['credentials'];
  eciFallback?: DocumentParserEciConfig;
  concurrency?: number;
  maxPending?: number;
  idleMs?: number;
  startupTimeoutMs?: number;
  queueTimeoutMs?: number;
  leaseMs?: number;
  receiptTtlMs?: number;
  coordinationId?: string;
}

/** Pure validation of typed DB configuration. Credentials are supplied by the owning process. */
export function createDocumentParserConfig(input: ParserMachineOptions): EnabledDocumentParserMachineConfig {
  const fail = (key: string): never => { throw new Error(`INVALID_CONFIG:PROCESSING_NODE_${key}`); };
  const integer = (key: keyof ParserMachineOptions, fallback: number, min: number, max: number) => {
    const value = input[key] ?? fallback;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail(key.toUpperCase());
  };
  const mode = input.mode;
  if (!['ecs', 'always-on'].includes(mode)) fail('MODE');
  if (mode !== 'ecs' && input.eciFallback) fail('ECI_FALLBACK');
  const privateIp = input.privateIp;
  if (mode === 'ecs' && (!privateIp || isIP(privateIp) !== 4 || !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(privateIp))) fail('PRIVATE_IP');
  const baseUrl = input.baseUrl?.trim() || (privateIp ? `http://${privateIp}:8000` : fail('BASE_URL'));
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) fail('BASE_URL');
    if (mode === 'ecs' && (url.hostname !== privateIp || url.pathname !== '/')) fail('BASE_URL');
    if (mode === 'always-on' && url.protocol === 'http:' && !(isIP(url.hostname) === 4 && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.)/.test(url.hostname))) fail('BASE_URL');
  } catch { fail('BASE_URL'); }
  const healthPath = input.healthPath?.trim() ?? (mode === 'ecs' ? '/health' : '');
  if ((healthPath || mode === 'ecs') && (!/^\/[a-zA-Z0-9/_-]{0,127}$/.test(healthPath) || healthPath.startsWith('//'))) fail('HEALTH_PATH');
  const apiToken = input.apiToken?.trim();
  if (apiToken && (apiToken.length > 4096 || /[\r\n]/.test(apiToken))) fail('API_TOKEN');
  const leaseMs = integer('leaseMs', 30_000, 6000, 120_000);
  const common: ParserConfigBase = {
    enabled: true, baseUrl: baseUrl.replace(/\/$/, ''), healthPath, ...(apiToken ? { apiToken } : {}),
    ...(input.coordinationId ? {coordinationId:input.coordinationId} : {}),
    concurrency: integer('concurrency', 1, 1, 16), maxPending: integer('maxPending', 128, 1, 1024),
    idleMs: integer('idleMs', 60000, 1000, 3600000),
    startupTimeoutMs: integer('startupTimeoutMs', 600000, 10000, 3600000),
    queueTimeoutMs: integer('queueTimeoutMs', 3600000, 10000, 86400000),
    leaseMs, pollMs: Math.min(1000, Math.floor(leaseMs / 6)),
    receiptTtlMs: integer('receiptTtlMs', 86400000, 60000, 604800000),
  };
  if (mode === 'always-on') return {...common, mode};
  const {regionId, instanceId, credentials, eciFallback} = input;
  if (!regionId || !/^[a-z]{2,8}(?:-[a-z0-9]+)+$/.test(regionId)) fail('REGION');
  if (!instanceId || !/^i-[a-z0-9]{8,40}$/.test(instanceId)) fail('INSTANCE');
  if (typeof credentials !== 'function') fail('CREDENTIALS');
  if (eciFallback && eciFallback.spec.regionId !== regionId) fail('ECI_REGION');
  return {...common, mode, regionId:regionId!, instanceId:instanceId!, privateIp:privateIp!, credentials:credentials!, ...(eciFallback ? {eciFallback} : {})};
}
