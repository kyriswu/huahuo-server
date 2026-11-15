import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/config.js';
import { listenMetrics, closeMetrics } from '../plugins/metrics.js';
import type { Server } from 'node:http';
export async function serve(app: FastifyInstance, config: AppConfig) {
  let metricsServer: Server | undefined;
  app.addHook('onClose', async () => { if (metricsServer) await closeMetrics(metricsServer); });
  let closing = false;
  const drain = () => {
    app.log.info('Drain requested; instance is no longer ready');
    void app.lifecycle.drain().catch(() => { app.log.error('Drain failed; instance remains unready'); });
  };
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    app.log.info('Shutdown requested');
    const timer = setTimeout(() => { app.log.error('Shutdown deadline exceeded'); process.exit(1); }, config.shutdownTimeoutMs);
    // Keep the process alive until cleanup completes or the explicit deadline fires.
    // A leaked handle must not defeat the deadline after all close hooks return.
    try { await app.close(); detachSignals();timer.unref(); process.exitCode = 0; }
    catch { app.log.error('Shutdown failed; waiting for bounded process exit');process.exitCode = 1; }
  };
  process.on('SIGUSR2', drain);
  const stop = () => { void shutdown(); };
  const detachSignals = () => { process.off('SIGUSR2', drain);process.off('SIGTERM', stop);process.off('SIGINT', stop); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await app.listen({ host: config.host, port: config.port });
    if (config.metrics.enabled) metricsServer = await listenMetrics(app.metrics, config.metrics.host, config.metrics.port);
  } catch (error) { try { await app.close(); } finally { detachSignals(); }throw error; }
  app.log.info({ stage: 'P03', role: config.role }, 'Role started');
}
