import { buildBase } from '../../src/apps/base.js';
import { serve } from '../../src/entrypoints/runtime.js';
import { config, dependencies } from '../helpers.js';

// Real loopback HTTP/process signals with fake dependency health; no DB/cloud access.
const cfg = config();
cfg.host = '127.0.0.1'; cfg.port = 0; cfg.metrics.enabled = false;
cfg.shutdownTimeoutMs = Number(process.env.FIXTURE_SHUTDOWN_MS ?? 15000);
const deps = dependencies();
deps.close = async () => { process.send?.({ event: 'dependencies-closed' }); };
const app = await buildBase({ config: cfg, dependencies: deps });
if (process.env.FIXTURE_LEAK === 'true') setInterval(() => undefined, 100);
app.get('/slow', async () => {
  process.send?.({ event: 'request-started' });
  await new Promise(resolve => setTimeout(resolve, Number(process.env.FIXTURE_WORK_MS ?? 11000)));
  return { done: true };
});
app.get('/business', async () => ({ ok: true }));
await serve(app, cfg);
process.send?.({ event: 'ready', address: app.listeningOrigin });
