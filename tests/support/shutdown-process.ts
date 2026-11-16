import { buildBase } from '../../src/apps/base.js';
import { serve } from '../../src/entrypoints/runtime.js';
import { config, dependencies } from '../helpers.js';
import { streamState } from '../../src/lib/state-stream.js';

// Real loopback HTTP/process signals with fake dependency health; no DB/cloud access.
const cfg = config();
cfg.host = '127.0.0.1'; cfg.port = 0; cfg.metrics.enabled = false;
const fixtureBudget = Number(process.env.FIXTURE_SHUTDOWN_MS ?? 15000);
const deps = dependencies();
deps.close = () => new Promise<void>(resolve => { if (process.send) process.send({ event: 'dependencies-closed' }, () => resolve()); else resolve(); });
const app = await buildBase({ config: cfg, dependencies: deps });
if (process.env.FIXTURE_LEAK === 'true') setInterval(() => undefined, 100);
app.get('/slow', async () => {
  process.send?.({ event: 'request-started' });
  await new Promise(resolve => setTimeout(resolve, Number(process.env.FIXTURE_WORK_MS ?? 11000)));
  return { done: true };
});
app.get('/business', async () => ({ ok: true }));
app.get('/state-stream', async (_request, reply) => {
  let terminal = false;
  await streamState(reply, () => ({ terminal }), changed => {
    const timer = setTimeout(() => { terminal = true; changed(); }, Number(process.env.FIXTURE_WORK_MS ?? 11000));
    process.send?.({ event: 'stream-started' });
    return () => clearTimeout(timer);
  }, state => state.terminal);
});
await serve(app, cfg, { initialTimeoutMs: fixtureBudget, readTimeoutMs: async () => fixtureBudget });
process.send?.({ event: 'ready', address: app.listeningOrigin });
