import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildBase } from '../../src/apps/base.js';
import { config, dependencies, env } from '../helpers.js';
import { loadConfig } from '../../src/config/config.js';
import { ApplicationMetrics, listenMetrics, closeMetrics } from '../../src/plugins/metrics.js';

function evidence(name: string, body: string) {
  const directory = process.env.METRICS_VERIFICATION_DIR;
  if (directory) { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, name), body); }
}
function samples(body: string, name: string) {
  return body.split('\n').filter(line => line.startsWith(name + '{'));
}
describe('Prometheus HTTP instrumentation over real loopback HTTP', () => {
  it('counts final 200/201/302/400/401/404/500 once and groups different IDs by route template', async () => {
    const app = await buildBase({ config: config(), dependencies: dependencies() });
    app.get('/tasks/:taskId', async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { ok: true }; });
    app.post('/validate', { schema: { body: Type.Object({ count: Type.Integer() }) } }, async (_req, reply) => reply.code(201).send({ ok: true }));
    app.get('/redirect', async (_req, reply) => reply.redirect('/tasks/second'));
    app.get('/forbidden', { onRequest: async (_req, reply) => { await reply.code(401).send(); } }, async () => ({ ok: true }));
    app.get('/broken', async () => { throw new Error('private input must remain in logs'); });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const listener = await listenMetrics(app.metrics, '127.0.0.1', 0);
    const metricsUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/metrics`;
    try {
      const before = await (await fetch(metricsUrl)).text(); evidence('http-before.prom', before);
      for (const id of ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']) {
        const response = await fetch(`${base}/tasks/${id}?request_id=${id}`); expect(response.status).toBe(200); await response.text();
      }
      for (const [body, status] of [[{ count: 2 }, 201], [{ count: 'bad' }, 400]] as const) {
        const response = await fetch(base + '/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        expect(response.status).toBe(status); await response.text();
      }
      const malformed = await fetch(base + '/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
      expect(malformed.status).toBe(400); await malformed.text();
      const redirect = await fetch(base + '/redirect', { redirect: 'manual' }); expect(redirect.status).toBe(302); await redirect.text();
      for (const [path, status] of [['/forbidden', 401], ['/missing/first?secret=query', 404], ['/missing/second', 404], ['/broken', 500]] as const) {
        const response = await fetch(base + path); expect(response.status).toBe(status); await response.text();
      }
      for (const path of ['/health/live', '/health/ready', '/health/ready?bad=value', '/metrics', '/metrics?query=ignored']) await (await fetch(base + path)).text();
      const response = await fetch(metricsUrl);
      expect(response.headers.get('content-type')).toBe(app.metrics.registry.contentType);
      const after = await response.text(); evidence('http-after.prom', after);
      const counters = samples(after, 'http_requests_total');
      expect(counters).toHaveLength(7);
      expect(counters.find(line => line.includes('route="/tasks/:taskId"'))).toMatch(/status="200".*\} 2$/);
      expect(counters.find(line => line.includes('route="unmatched"'))).toMatch(/status="404".*\} 2$/);
      expect(counters.find(line => line.includes('route="/validate"') && line.includes('status="400"'))).toMatch(/\} 2$/);
      expect(counters.reduce((sum, line) => sum + Number(line.split(' ').at(-1)), 0)).toBe(10);
      expect(after).not.toMatch(/11111111|22222222|secret|request_id|query=|private input/);
      expect(after).not.toMatch(/route="\/(health|metrics)/);
      const counts = samples(after, 'http_request_duration_seconds_count');
      expect(counts.reduce((sum, line) => sum + Number(line.split(' ').at(-1)), 0)).toBe(10);
      expect(counts.find(line => line.includes('route="/tasks/:taskId"'))).toMatch(/\} 2$/);
      const seconds = Number(samples(after, 'http_request_duration_seconds_sum').find(line => line.includes('route="/tasks/:taskId"'))!.split(' ').at(-1));
      expect(seconds).toBeGreaterThanOrEqual(0.035); expect(seconds).toBeLessThan(10);
      expect(samples(after, 'http_request_duration_seconds_bucket').filter(line => line.includes('le="+Inf"')).reduce((sum, line) => sum + Number(line.split(' ').at(-1)), 0)).toBe(10);
      evidence('http-verification.json', JSON.stringify({ appEnv: 'test', completedResponses: 10, histogramCount: 10, success2xx3xx: 4, routeIds: 2, rawIdSeries: 0, statuses: [200, 201, 302, 400, 401, 404, 500], durationSeconds: seconds }, null, 2));
    } finally { await closeMetrics(listener); await app.close(); }
  });

  it.each(['development', 'test', 'production'])('derives labels from APP_ENV=%s without a separate environment setting', async appEnv => {
    const cfg = { ...config(), appEnv };
    const metrics = new ApplicationMetrics(cfg);
    const text = await metrics.registry.metrics();
    expect(text).toContain(`env="${appEnv === 'production' ? 'prod' : appEnv}"`);
    expect(text).toContain('service="huahuo-server"');
  });

  it.each(['api-server', 'admin', 'worker', 'scheduler'] as const)('%s exposes the same registry on its isolated scrape listener', async role => {
    const app = await buildBase({ config: config(role), dependencies: dependencies() });
    const application = await app.listen({ host: '127.0.0.1', port: 0 });
    const listener = await listenMetrics(app.metrics, '127.0.0.1', 0);
    const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    try {
      await (await fetch(application + '/does-not-exist')).text();
      const response = await fetch(base + '/metrics'); const body = await response.text();
      expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe(app.metrics.registry.contentType);
      expect(body).toContain(`role="${role}"`); expect(body).toContain('env="test"');
      expect(body).toContain('route="unmatched"');
      expect((await fetch(base + '/admin')).status).toBe(404);
      expect((await fetch(base + '/health/ready')).status).toBe(404);
      expect((await fetch(base + '/metrics', { method: 'POST' })).status).toBe(404);
      evidence(`${role}.prom`, body);
      expect((await app.inject('/metrics')).statusCode).toBe(404);
    } finally { await closeMetrics(listener); await app.close(); }
  });

  it('keeps app registries isolated and permits disabling collection', async () => {
    const first = await buildBase({ config: config(), dependencies: dependencies() });
    const second = await buildBase({ config: loadConfig('api-server', { ...env, METRICS_ENABLED: 'false' }), dependencies: dependencies() });
    try {
      const one = await first.listen({ host: '127.0.0.1', port: 0 });
      const two = await second.listen({ host: '127.0.0.1', port: 0 });
      await (await fetch(one + '/missing')).text(); await (await fetch(two + '/missing')).text();
      expect((await first.metrics.registry.metrics())).toContain('http_requests_total{');
      expect((await second.metrics.registry.metrics())).not.toContain('http_requests_total{');
      expect((await second.inject('/metrics')).statusCode).toBe(404);
    } finally { await first.close(); await second.close(); }
  });

  it('validates metrics configuration and gives each host process a separate default port', () => {
    for (const [role, port] of [['api-server', 9464], ['admin', 9465], ['worker', 9466], ['scheduler', 9467]] as const)
      expect(config(role).metrics).toMatchObject({ enabled: true, host: '127.0.0.1', port });
    for (const patch of [{ METRICS_PORT: '0' }, { METRICS_PORT: 'NaN' }, { METRICS_PORT: '65536' }, { METRICS_ENABLED: 'yes' }, { METRICS_HOST: '' }, { METRICS_SERVICE: 'bad secret' }])
      expect(() => loadConfig('worker', { ...env, ...patch })).toThrow('INVALID_CONFIG:METRICS_');
    expect(loadConfig('migrate', { DATABASE_URL: env.DATABASE_URL }).metrics.enabled).toBe(false);
  });
});
