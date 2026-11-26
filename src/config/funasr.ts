import { loadFunAsrComputeConfig, readCallbackOrigin, type FunAsrComputeConfig } from '../integrations/funasr-compute/config.js';
import type { AppConfig, Env, Role } from './config.js';

export type FunAsrWorkflowConfig =
  | { role: 'api-server'; callbackSecret: string; taskCredits: number }
  | { role: 'worker'; compute: Exclude<FunAsrComputeConfig, { provider: 'disabled' }>; callbackOrigin: string;
      apiToken: string; callbackWaitMs: number; taskTimeoutMs: number; computeWaitMs: number;
      uploadTimeoutMs: number; idleMs: number };

export const funAsrCallbackBodyLimit = 16 * 1024 * 1024;

export function loadFunAsrWorkflowConfig(role: Role, env: Env, billingMode: AppConfig['billingMode']): FunAsrWorkflowConfig | undefined {
  if (role !== 'api-server' && role !== 'worker') return;
  const providerKey = 'FUNASR_COMPUTE_PROVIDER';
  const provider = env[providerKey]?.trim() || 'disabled';
  if (provider === 'disabled') return;
  const invalid = (key: string): never => { throw new Error('INVALID_CONFIG:' + key); };
  if (provider !== 'fixed' && provider !== 'acs') return invalid(providerKey);
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key]?.trim();
    const value = raw ? Number(raw) : fallback;
    return (!raw || /^\d+$/u.test(raw)) && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid(key);
  };
  if (role === 'api-server') {
    const key = 'FUNASR_CALLBACK_SECRET';
    const callbackSecret = env[key];
    if (!callbackSecret || callbackSecret.length < 32 || /[\r\n]/u.test(callbackSecret)) return invalid(key);
    const taskCredits = integer('FUNASR_TASK_CREDITS', 0, 0, 1_000_000);
    if (taskCredits && billingMode === 'disabled') return invalid('FUNASR_TASK_CREDITS');
    return { role, callbackSecret, taskCredits };
  }
  const originKey = 'FUNASR_COMPUTE_CALLBACK_ORIGIN';
  const callbackOrigin = readCallbackOrigin(env[originKey]?.trim() ?? '', originKey);
  const tokenKey = 'FUNASR_API_TOKEN';
  const apiToken = env[tokenKey];
  if (!apiToken || !/^[\x21-\x7e]+$/u.test(apiToken)) return invalid(tokenKey);
  const compute = loadFunAsrComputeConfig(env);
  if (compute.provider === 'disabled') return invalid(providerKey);
  const uploadTimeoutMs = integer('FUNASR_UPLOAD_TIMEOUT_MS', 120_000, 1000, 900_000);
  const callbackWaitMs = integer('FUNASR_CALLBACK_WAIT_MS', 120_000, 1000, 3_600_000);
  return { role, compute, callbackOrigin, apiToken, uploadTimeoutMs, callbackWaitMs,
    taskTimeoutMs: integer('FUNASR_TASK_TIMEOUT_MS', 1_800_000, uploadTimeoutMs + callbackWaitMs + 1000, 43_200_000),
    computeWaitMs: compute.provider === 'acs'
      ? Math.ceil(compute.options.candidates.length / compute.options.batchSize) * (compute.options.startupTimeoutSeconds + 60) * 1000
      : 120_000,
    idleMs: integer('FUNASR_IDLE_MS', 10_000, 1000, 600_000),
  };
}
