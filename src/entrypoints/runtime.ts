import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/config.js';
export async function serve(app: FastifyInstance, config: AppConfig) {
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    app.log.info('Shutdown requested');
    const timer = setTimeout(() => { app.log.error('Shutdown deadline exceeded'); process.exit(1); }, 10000);
    timer.unref();
    try { await app.close(); clearTimeout(timer); process.exitCode = 0; }
    catch { clearTimeout(timer); process.exitCode = 1; }
  };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ stage: 'P03', role: config.role }, 'Role started');
}
