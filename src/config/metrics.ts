import type { Env, Role } from './config.js';

export interface MetricsConfig { enabled: boolean; host: string; port: number; service: string; }

export function loadMetricsConfig(role: Role, env: Env): MetricsConfig {
  const enabled = env.METRICS_ENABLED ?? 'true';
  if (!['true', 'false'].includes(enabled)) throw new Error('INVALID_CONFIG:METRICS_ENABLED');
  const ports: Record<Role, number> = { 'api-server': 9464, admin: 9465, worker: 9466, scheduler: 9467, migrate: 9468 };
  const port = Number(env.METRICS_PORT ?? ports[role]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_CONFIG:METRICS_PORT');
  const host = env.METRICS_HOST?.trim() ?? '127.0.0.1';
  if (!host || /[\s/]/.test(host)) throw new Error('INVALID_CONFIG:METRICS_HOST');
  const service = env.METRICS_SERVICE?.trim() ?? 'huahuo-server';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(service)) throw new Error('INVALID_CONFIG:METRICS_SERVICE');
  return { enabled: role !== 'migrate' && enabled === 'true', host, port, service };
}
