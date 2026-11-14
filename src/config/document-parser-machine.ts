import { isIP } from 'node:net';
import { loadDocumentParserEciConfig, type DocumentParserEciConfig } from './document-parser-eci.js';

type Env = Readonly<Record<string, string | undefined>>;
interface ParserConfigBase {
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
export type DocumentParserMachineConfig = { enabled: false } | EnabledDocumentParserMachineConfig;

export function loadDocumentParserMachineConfig(env: Env = process.env): DocumentParserMachineConfig {
  const fail = (key: string): never => { throw new Error(`INVALID_CONFIG:${key}`); };
  const mode = env.DOCUMENT_PARSER_MODE ?? 'disabled';
  if (!['disabled', 'ecs', 'always-on'].includes(mode)) fail('DOCUMENT_PARSER_MODE');
  if (mode !== 'ecs' && env.DOCUMENT_PARSER_ECI_FALLBACK_ENABLED === 'true') fail('DOCUMENT_PARSER_ECI_FALLBACK_ENABLED');
  if (mode === 'disabled') return { enabled: false };
  const required = (key: string) => env[key]?.trim() || fail(key);
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(env[key] ?? fallback);
    return Number.isInteger(value) && value >= min && value <= max ? value : fail(key);
  };
  const privateIp = mode === 'ecs' ? required('DOCUMENT_PARSER_ECS_PRIVATE_IP') : undefined;
  if (privateIp !== undefined && (isIP(privateIp) !== 4 || !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(privateIp))) fail('DOCUMENT_PARSER_ECS_PRIVATE_IP');
  const baseUrl = env.DOCUMENT_PARSER_BASE_URL?.trim() || (privateIp ? `http://${privateIp}:8000` : required('DOCUMENT_PARSER_BASE_URL'));
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) fail('DOCUMENT_PARSER_BASE_URL');
    if (mode === 'ecs' && (url.hostname !== privateIp || url.pathname !== '/')) fail('DOCUMENT_PARSER_BASE_URL');
    if (mode === 'always-on' && url.protocol === 'http:' && !(isIP(url.hostname) === 4 && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.)/.test(url.hostname))) fail('DOCUMENT_PARSER_BASE_URL');
  } catch { fail('DOCUMENT_PARSER_BASE_URL'); }
  const healthPath = env.DOCUMENT_PARSER_HEALTH_PATH?.trim() ?? (mode === 'ecs' ? '/health' : '');
  if ((healthPath || mode === 'ecs') && (!/^\/[a-zA-Z0-9/_-]{0,127}$/.test(healthPath) || healthPath.startsWith('//'))) fail('DOCUMENT_PARSER_HEALTH_PATH');
  const apiToken = env.DOCUMENT_PARSER_API_TOKEN?.trim();
  if (apiToken && (apiToken.length > 4096 || /[\r\n]/.test(apiToken))) fail('DOCUMENT_PARSER_API_TOKEN');
  const leaseMs = integer('DOCUMENT_PARSER_LEASE_MS', 30_000, 6000, 120_000);
  const common: ParserConfigBase = {
    enabled: true, baseUrl: baseUrl.replace(/\/$/, ''), healthPath, ...(apiToken ? { apiToken } : {}),
    concurrency: integer('DOCUMENT_PARSER_CONCURRENCY', 1, 1, 16),
    maxPending: integer('DOCUMENT_PARSER_MAX_PENDING', 128, 1, 1024),
    idleMs: integer('DOCUMENT_PARSER_IDLE_SECONDS', 60, 1, 3600) * 1000,
    startupTimeoutMs: integer('DOCUMENT_PARSER_STARTUP_TIMEOUT_SECONDS', 600, 10, 3600) * 1000,
    queueTimeoutMs: integer('DOCUMENT_PARSER_QUEUE_TIMEOUT_SECONDS', 3600, 10, 86400) * 1000,
    leaseMs, pollMs: Math.min(1000, Math.floor(leaseMs / 6)),
    receiptTtlMs: integer('DOCUMENT_PARSER_DEDUP_TTL_SECONDS', 86400, 60, 604800) * 1000,
  };
  if (mode === 'always-on') return { ...common, mode: 'always-on' };
  const regionId = required('DOCUMENT_PARSER_ECS_REGION_ID');
  const instanceId = required('DOCUMENT_PARSER_ECS_INSTANCE_ID');
  if (!/^[a-z]{2,8}(?:-[a-z0-9]+)+$/.test(regionId)) fail('DOCUMENT_PARSER_ECS_REGION_ID');
  if (!/^i-[a-z0-9]{8,40}$/.test(instanceId)) fail('DOCUMENT_PARSER_ECS_INSTANCE_ID');
  required('ALIYUN_RAM_ACCESS_KEY_ID'); required('ALIYUN_RAM_ACCESS_KEY_SECRET');
  const eciFallback = loadDocumentParserEciConfig(env, regionId);
  return {
    ...common, mode: 'ecs', regionId, instanceId, privateIp: privateIp!,
    ...(eciFallback ? { eciFallback } : {}),
    // Resolve each time so the owning process can supply refreshable STS credentials.
    credentials: async () => ({
      accessKeyId: required('ALIYUN_RAM_ACCESS_KEY_ID'), accessKeySecret: required('ALIYUN_RAM_ACCESS_KEY_SECRET'),
      ...(env.ALIYUN_RAM_SECURITY_TOKEN?.trim() ? { securityToken: env.ALIYUN_RAM_SECURITY_TOKEN.trim() } : {}),
    }),
  };
}
