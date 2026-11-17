import { readFileSync } from 'node:fs';
import type { AppConfig } from '../config/config.js';

export const packageVersion = String((JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version);
export interface TelemetryIdentity { env: string; service: string; role: string; version: string; service_instance_id: string; }
export function telemetryIdentity(config: Pick<AppConfig, 'appEnv' | 'role' | 'metrics' | 'instanceId' | 'telemetry'>): TelemetryIdentity {
  return { env: config.appEnv === 'production' ? 'prod' : config.appEnv, service: config.metrics.service,
    role: config.role, version: config.telemetry.version, service_instance_id: config.instanceId };
}
