import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/config.js';
import { listenMetrics, closeMetrics } from '../plugins/metrics.js';
import type { Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import { DEFAULT_DRAIN_TIMEOUT_MS, MAX_DRAIN_TIMEOUT_MS } from '../modules/runtime-settings/registry.js';

interface ShutdownApplication {
  lifecycle: { drain(): Promise<void> };
  close(): Promise<unknown>;
  log: { info(message: string): unknown; error(fields: { reason: string }, message: string): unknown };
  drainTimeoutSnapshotMs(): number;
  readDrainTimeoutMs(): Promise<number>;
}
// Injection is for deterministic tests; deployment configuration comes only from DB.
export interface ShutdownOptions {
  now?: () => number;
  exit?: (code: number) => void;
  readTimeoutMs?: () => Promise<number>;
  initialTimeoutMs?: number;
  onClosed?: () => void;
}
export function createShutdownController(app: ShutdownApplication, options: ShutdownOptions = {}) {
  const now = options.now ?? (() => performance.now()), exit = options.exit ?? (code => process.exit(code));
  let started = 0, closing = false, finished = false, budget: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const minimum = options.initialTimeoutMs !== undefined || options.readTimeoutMs ? 1 : DEFAULT_DRAIN_TIMEOUT_MS;
  const valid = (value: number) => Number.isSafeInteger(value) && value >= minimum && value <= MAX_DRAIN_TIMEOUT_MS;
  const arm = (timeoutMs: number) => {
    if (finished) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      finished = true;
      app.log.error({ reason: 'DRAIN_DEADLINE_EXCEEDED' }, 'Drain deadline exceeded');
      options.onClosed?.(); exit(124);
    }, Math.max(0, timeoutMs - (now() - started)));
  };
  const drain = () => {
    if (budget || finished) return budget ?? Promise.resolve();
    started = now();
    const cached = options.initialTimeoutMs ?? app.drainTimeoutSnapshotMs();
    const fallback = valid(cached) ? cached : DEFAULT_DRAIN_TIMEOUT_MS;
    arm(fallback);
    app.log.info('Drain requested; instance is no longer ready');
    budget = Promise.resolve().then(options.readTimeoutMs ?? (() => app.readDrainTimeoutMs()))
      .then(value => arm(valid(value) ? value : fallback), () => arm(fallback));
    try { void app.lifecycle.drain().catch(() => { app.log.error({ reason: 'DRAIN_FAILED' }, 'Drain failed; instance remains unready'); }); }
    catch { app.log.error({ reason: 'DRAIN_FAILED' }, 'Drain failed; instance remains unready'); }
    return budget;
  };
  const stop = async () => {
    if (closing || finished) return;
    closing = true;
    await drain();
    if (finished) return;
    app.log.info('Shutdown requested');
    try {
      await app.close();
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      options.onClosed?.(); exit(0);
    } catch {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      app.log.error({ reason: 'SHUTDOWN_FAILED' }, 'Shutdown failed');
      options.onClosed?.(); exit(1);
    }
  };
  return { drain, stop, dispose() { finished = true; if (timer) clearTimeout(timer); } };
}

export async function serve(app: FastifyInstance, config: AppConfig, shutdownOptions: ShutdownOptions = {}) {
  let metricsServer: Server | undefined;
  app.addHook('onClose', async () => { if (metricsServer) await closeMetrics(metricsServer); });
  const controller = createShutdownController(app, { ...shutdownOptions, onClosed: () => { detachSignals(); shutdownOptions.onClosed?.(); } });
  const drain = () => { void controller.drain(); }, stop = () => { void controller.stop(); };
  const detachSignals = () => { process.off('SIGUSR2', drain); process.off('SIGTERM', stop); process.off('SIGINT', stop); };
  process.on('SIGUSR2', drain);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    await app.listen({ host: config.host, port: config.port });
    if (config.metrics.enabled) metricsServer = await listenMetrics(app.metrics, config.metrics.host, config.metrics.port);
  } catch (error) { controller.dispose(); try { await app.close(); } finally { detachSignals(); } throw error; }
  app.log.info({ event: 'service.started', role: config.role, version: config.telemetry.version }, 'Role started');
}
