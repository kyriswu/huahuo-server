import { isIP } from 'node:net';
import type { KubernetesConnection } from './kubernetes.js';
import { defaultAcsGpuHostResources, type AcsFunAsrOptions } from './types.js';

type Environment = Readonly<Record<string, string | undefined>>;

export type FunAsrComputeConfig =
  | { provider: 'disabled' }
  | { provider: 'fixed'; baseUrl: string }
  | { provider: 'acs'; connection: KubernetesConnection; options: AcsFunAsrOptions };

const DEFAULT_IMAGE =
  'huahuoai-docker-hub-registry-vpc.cn-beijing.cr.aliyuncs.com/huahuo/huahuo-funasr@sha256:cbdfcf5ec862a4857d9852a22ba7fa805292170a060cbefde6c4a837443f9d2c';
const DEFAULT_CANDIDATES = [
  { model: 'A10', zone: 'cn-beijing-i', driver: '580.95.05-open' },
  { model: 'G49E', zone: 'cn-beijing-l', driver: '580.95.05-open' },
  { model: 'L20', zone: 'cn-beijing-l', driver: '580.95.05-open' },
  { model: 'L20N', zone: 'cn-beijing-i', driver: '580.95.05-open' },
  { model: 'G59', zone: 'cn-beijing-l', driver: '580.95.05-open' },
  { model: 'L20NE', zone: 'cn-beijing-l', driver: '580.126.09-open' },
  { model: 'G28Ti', zone: 'cn-beijing-h', driver: '580.95.05-open' },
  { model: 'G28Ti', zone: 'cn-beijing-i', driver: '580.95.05-open' },
] as const;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const LABEL_VALUE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/u;

function invalid(key: string): never {
  throw new Error(`INVALID_CONFIG:${key}`);
}

function readOrigin(raw: string, key: string, httpsOnly = false): string {
  if (!/^https?:\/\//u.test(raw) || /[\\\s?#]/u.test(raw)) invalid(key);
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.pathname !== '/' || (httpsOnly && url.protocol !== 'https:')) invalid(key);
    return url.origin;
  } catch { return invalid(key); }
}

function secretName(value: string, key: string): string {
  if (value.length > 253 || !value.split('.').every(label => DNS_LABEL.test(label))) invalid(key);
  return value;
}

function isPrivateCidr(cidr: string): boolean {
  const match = /^([^/]+)\/(\d{1,3})$/u.exec(cidr);
  if (!match?.[1]) return false;
  const ip = match[1];
  const prefix = Number(match[2]);
  const version = isIP(ip);
  if (version === 6) return /^f[cd]/iu.test(ip) && prefix >= 7 && prefix <= 128;
  if (version !== 4 || prefix > 32) return false;
  if (ip.startsWith('10.')) return prefix >= 8;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./u.test(ip)) return prefix >= 12;
  return ip.startsWith('192.168.') && prefix >= 16;
}

function readCandidateResources(raw: unknown, key: string) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) invalid(key);
  const { cpu, memoryGiB, ...extra } = raw as Record<string, unknown>;
  if (Object.keys(extra).length > 0 ||
    typeof cpu !== 'number' || !Number.isSafeInteger(cpu) || cpu < 1 ||
    typeof memoryGiB !== 'number' || !Number.isSafeInteger(memoryGiB) || memoryGiB < 1) invalid(key);
  return { cpu, memoryGiB };
}

function readCandidates(raw: string | undefined): AcsFunAsrOptions['candidates'] {
  if (raw === undefined) return DEFAULT_CANDIDATES.map(candidate => ({ ...candidate }));
  const key = 'FUNASR_COMPUTE_CANDIDATES_JSON';
  let items: unknown;
  try { items = JSON.parse(raw) as unknown; }
  catch { return invalid(key); }
  if (!Array.isArray(items) || items.length < 1 || items.length > 8) invalid(key);
  const seen = new Set<string>();
  return (items as unknown[]).map(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) invalid(key);
    const { model, zone, driver, resources: hostResources, ...extra } = item as Record<string, unknown>;
    if (Object.keys(extra).length > 0 ||
      typeof model !== 'string' || !LABEL_VALUE.test(model) ||
      typeof zone !== 'string' || !DNS_LABEL.test(zone) ||
      typeof driver !== 'string' || !LABEL_VALUE.test(driver)) invalid(key);
    const resources = hostResources === undefined ? undefined : readCandidateResources(hostResources, key);
    const { cpu, memoryGiB } = resources ?? defaultAcsGpuHostResources;
    const identity = `${model}:${zone}:${cpu}:${memoryGiB}`;
    if (seen.has(identity)) invalid(key);
    seen.add(identity);
    return resources ? { model, zone, driver, resources } : { model, zone, driver };
  });
}

/** Loading configuration checks runtime inputs but does not access the network or credential files. */
export function loadFunAsrComputeConfig(env: Environment = process.env): FunAsrComputeConfig {
  const optional = (key: string) => env[key]?.trim() || undefined;
  const required = (key: string) => optional(key) ?? invalid(key);
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = optional(key);
    const value = raw === undefined ? fallback : Number(raw);
    if ((raw !== undefined && !/^\d+$/u.test(raw)) || !Number.isSafeInteger(value) || value < min || value > max) invalid(key);
    return value;
  };
  const provider = optional('FUNASR_COMPUTE_PROVIDER') ?? 'disabled';
  if (provider === 'disabled') return { provider };
  if (provider === 'fixed') {
    const key = 'FUNASR_COMPUTE_FIXED_BASE_URL';
    return { provider, baseUrl: readOrigin(required(key), key) };
  }
  if (provider !== 'acs') return invalid('FUNASR_COMPUTE_PROVIDER');

  const tokenFile = optional('FUNASR_COMPUTE_KUBE_TOKEN_FILE');
  const clientCertificateFile = optional('FUNASR_COMPUTE_KUBE_CLIENT_CERTIFICATE_FILE');
  const clientKeyFile = optional('FUNASR_COMPUTE_KUBE_CLIENT_KEY_FILE');
  if (tokenFile && (clientCertificateFile || clientKeyFile)) invalid('FUNASR_COMPUTE_KUBE_TOKEN_FILE');
  if (Boolean(clientCertificateFile) !== Boolean(clientKeyFile)) {
    invalid(clientCertificateFile ? 'FUNASR_COMPUTE_KUBE_CLIENT_KEY_FILE' : 'FUNASR_COMPUTE_KUBE_CLIENT_CERTIFICATE_FILE');
  }
  if (!tokenFile && !clientCertificateFile) invalid('FUNASR_COMPUTE_KUBE_TOKEN_FILE');

  const apiUrlKey = 'FUNASR_COMPUTE_KUBE_API_URL';
  const namespaceKey = 'FUNASR_COMPUTE_NAMESPACE';
  const namespace = required(namespaceKey);
  if (!DNS_LABEL.test(namespace)) invalid(namespaceKey);
  const imageKey = 'FUNASR_COMPUTE_IMAGE';
  const image = optional(imageKey) ?? DEFAULT_IMAGE;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u.test(image)) invalid(imageKey);
  const apiSecretKey = 'FUNASR_COMPUTE_API_SECRET_NAME';
  const imagePullSecretKey = 'FUNASR_COMPUTE_IMAGE_PULL_SECRET_NAME';
  const cidrKey = 'FUNASR_COMPUTE_POD_CIDRS';
  const podCidrs = required(cidrKey).split(',').map(cidr => cidr.trim());
  if (!podCidrs.every(isPrivateCidr)) invalid(cidrKey);

  const startupTimeoutSeconds = integer('FUNASR_COMPUTE_STARTUP_TIMEOUT_SECONDS', 600, 1, 3600);
  const lifetimeSeconds = integer('FUNASR_COMPUTE_LIFETIME_SECONDS', 3600, startupTimeoutSeconds + 1, 86400);
  return {
    provider,
    connection: {
      apiUrl: readOrigin(required(apiUrlKey), apiUrlKey, true),
      caFile: required('FUNASR_COMPUTE_KUBE_CA_FILE'),
      ...(tokenFile ? { tokenFile } : { clientCertificateFile, clientKeyFile }),
      requestTimeoutMs: integer('FUNASR_COMPUTE_KUBE_REQUEST_TIMEOUT_MS', 10000, 1, 60000),
    },
    options: {
      namespace,
      image,
      apiSecretName: secretName(required(apiSecretKey), apiSecretKey),
      imagePullSecretName: secretName(required(imagePullSecretKey), imagePullSecretKey),
      podCidrs,
      candidates: readCandidates(optional('FUNASR_COMPUTE_CANDIDATES_JSON')),
      startupTimeoutSeconds,
      lifetimeSeconds,
    },
  };
}
