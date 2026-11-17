import { createServer, get, type Server } from 'node:http';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemorySpanExporter, type SpanExporter } from '@opentelemetry/sdk-trace';
import { ExportResultCode } from '@opentelemetry/core';
import { buildBase } from '../../src/apps/base.js';
import { loadConfig } from '../../src/config/config.js';
import { ServiceHttpClient, ServiceHttpError, readJsonResponse } from '../../src/integrations/http-client.js';
import { withTraceId } from '../../src/lib/trace.js';
import { createApplicationTelemetry, withTelemetryRuntime, withTraceContext, captureTraceContext, normalizeTraceContext,
  currentTelemetryFields, tracedOperation, currentSpan } from '../../src/observability/telemetry.js';
import { ApplicationMetrics, withApplicationMetrics, currentApplicationMetrics } from '../../src/plugins/metrics.js';
import { config, dependencies, env } from '../helpers.js';

const traceId = '1234567890abcdef1234567890abcdef', parentId = '1234567890abcdef';
const remote = { traceparent: `00-${traceId}-${parentId}-01`, tracestate: 'vendor=value' };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('LOOPBACK_REQUIRED');
  return `http://127.0.0.1:${address.port}`;
}

describe('manual OTel SDK context and bounded export, no business dependencies', () => {
  it('validates standard configuration and remains export-off unless explicitly configured', () => {
    expect(config().telemetry).toMatchObject({ version: '0.3.0' });
    expect(config().telemetry.tracesEndpoint).toBeUndefined();
    expect(loadConfig('worker', { ...env, OTEL_SERVICE_VERSION: 'reviewed-sha.123' }).telemetry.version).toBe('reviewed-sha.123');
    for (const endpoint of ['ftp://collector.test', 'https://user:secret@collector.test/v1/traces', 'https://collector.test/v1/traces?token=secret'])
      expect(() => loadConfig('worker', { ...env, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint })).toThrow('INVALID_CONFIG:OTEL_EXPORTER_OTLP_TRACES_ENDPOINT');
    expect(() => loadConfig('worker', { ...env, OTEL_SERVICE_VERSION: 'secret/url' })).toThrow('INVALID_CONFIG:OTEL_SERVICE_VERSION');
  });

  it('uses official W3C parent/child spans, isolates concurrent work and preserves opaque correlation', async () => {
    const exporter = new InMemorySpanExporter(), runtime = createApplicationTelemetry(config(), { exporter });
    cleanups.push(() => runtime.shutdown());
    await withTelemetryRuntime(runtime, () => withTraceContext(remote, () => withTraceId('opaque-correlation', async () => {
      expect(currentTelemetryFields()).toEqual({ trace_id: traceId, span_id: parentId });
      await tracedOperation('task.process', { 'task.kind': 'text.ingest' }, async () => {
        const root = captureTraceContext(); expect(root.traceparent).not.toBe(remote.traceparent);
        await Promise.all(['embedding', 'rerank'].map(operation => tracedOperation('provider.call', { operation }, async () => {
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(currentTelemetryFields().trace_id).toBe(traceId);
        })));
      });
    })));
    await runtime.provider.forceFlush({ timeoutMillis: 1000 });
    const spans = exporter.getFinishedSpans(), task = spans.find(span => span.name === 'task.process')!;
    expect(task.parentSpanContext?.spanId).toBe(parentId);
    expect(spans.filter(span => span.name === 'provider.call').map(span => span.parentSpanContext?.spanId)).toEqual([task.spanContext().spanId, task.spanContext().spanId]);
    expect(new Set(spans.map(span => span.spanContext().spanId)).size).toBe(3);
    expect(currentTelemetryFields()).toEqual({});
    expect(captureTraceContext()).toEqual({});
  });

  it('normalizes only bounded W3C context and discards malformed, zero and duplicate context', () => {
    expect(normalizeTraceContext({ ...remote, baggage: 'token=secret' })).toEqual(remote);
    for (const carrier of [null, {}, { traceparent: remote.traceparent.replace(traceId, '0'.repeat(32)) },
      { traceparent: remote.traceparent.replace(parentId + '-01', '0'.repeat(16) + '-01') }, { traceparent: ['one', 'two'] },
      { traceparent: 'invalid-token', tracestate: 'vendor=value' }, { traceparent: 'x'.repeat(513) }])
      expect(normalizeTraceContext(carrier)).toEqual({});
    expect(normalizeTraceContext({ traceparent: remote.traceparent, tracestate: 'a'.repeat(513) })).toEqual({ traceparent: remote.traceparent });
    expect(normalizeTraceContext(Object.defineProperty({}, 'traceparent', { get() { throw new Error('private-getter'); } }))).toEqual({});
  });

  it('exports an allowlisted span schema without URL, body, exception, state or credential fields', async () => {
    const exporter = new InMemorySpanExporter(), cfg = config(), runtime = createApplicationTelemetry(cfg, { exporter });
    cleanups.push(() => runtime.shutdown());
    const secret = 'private-token-in-url';
    await expect(withTelemetryRuntime(runtime, () => withTraceContext({ ...remote, tracestate: 'vendor=private-state' }, () =>
      tracedOperation('provider.call', { dependency: 'embedding', 'url.full': `https://private.test/?token=${secret}`, body: secret }, async () => {
        currentSpan()?.recordException(new Error(secret));
        currentSpan()?.setAttribute('credential', secret);
        currentSpan()?.addEvent('private-event', { body: secret });
        currentSpan()?.setStatus({ code: 2, message: secret });
        throw new Error(secret);
      })))).rejects.toThrow(secret);
    await runtime.provider.forceFlush({ timeoutMillis: 1000 });
    const spans = exporter.getFinishedSpans(); expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes).toMatchObject({ dependency: 'embedding', outcome: 'failure' });
    expect(spans[0]!.events).toEqual([]);
    expect(spans[0]!.resource.attributes).toMatchObject({ 'service.name': cfg.metrics.service, 'service.version': cfg.telemetry.version,
      'service.instance.id': cfg.instanceId, 'deployment.environment.name': 'test', 'huahuo.role': cfg.role });
    expect(JSON.stringify(spans)).not.toMatch(/private-token|private-state|private-event|https:\/\/private|credential|url.full/);
  });

  it('exports an explicit OTLP endpoint through a bounded batch over real loopback only', async () => {
    const batches: string[] = [];
    const url = await listen(createServer((request, response) => {
      const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => { batches.push(Buffer.concat(chunks).toString()); response.setHeader('Content-Type', 'application/json'); response.end('{}'); });
    }));
    const cfg = loadConfig('api-server', { ...env, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: url + '/v1/traces' });
    const runtime = createApplicationTelemetry(cfg); cleanups.push(() => runtime.shutdown());
    await withTelemetryRuntime(runtime, () => tracedOperation('loopback.test', { operation: 'test' }, async () => true));
    await runtime.provider.forceFlush({ timeoutMillis: 2500 });
    expect(batches).toHaveLength(1); expect(batches[0]).toContain('loopback.test');
    expect(batches[0]).not.toMatch(/DATABASE_URL|huahuo_test_unit|fixture-access|response_body|token/);
  });

  it('bounds shutdown and keeps exporter failures from changing business outcomes', async () => {
    const exporter: SpanExporter = { export: (_spans, done) => done({ code: ExportResultCode.FAILED, error: new Error('private-export-failure') }),
      shutdown: () => new Promise<void>(() => undefined) };
    const runtime = createApplicationTelemetry(config(), { exporter });
    expect(await withTelemetryRuntime(runtime, () => tracedOperation('business.operation', {}, async () => 'committed'))).toBe('committed');
    const before = Date.now(); await runtime.shutdown(); expect(Date.now() - before).toBeLessThan(3500);
    await runtime.shutdown();
  });

  it('records real inbound/client parentage, consistent resource fields and bounded client metrics without leaking URLs', async () => {
    const cfg = { ...config(), logLevel: 'info' }, exporter = new InMemorySpanExporter();
    const runtime = createApplicationTelemetry(cfg, { exporter }), lines: string[] = [];
    const stream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
    const app = await buildBase({ config: cfg, dependencies: dependencies(), telemetry: runtime, loggerStream: stream });
    cleanups.push(() => app.close());
    let downstream: TraceCarrierLike | undefined;
    app.get('/api/v1/observed/:id', async () => {
      return new ServiceHttpClient({ dependency: 'embedding', operation: 'embed', fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers); downstream = { traceparent: headers.get('traceparent'), correlation: headers.get('x-trace-id'), authorization: headers.get('authorization') };
        return new Response('{"ok":true}');
      } }).request('https://provider.test/private-id?token=private-credential', { headers: { authorization: 'Bearer fixture-only' } }, { timeoutMs: 1000 }, response => readJsonResponse(response, 100));
    });
    const response = await app.inject({ url: '/api/v1/observed/private-id?token=secret-query', headers: { ...remote, 'x-trace-id': 'opaque-correlation' } });
    expect(response.statusCode).toBe(200); expect(response.headers['x-trace-id']).toBe('opaque-correlation');
    expect(downstream).toMatchObject({ correlation: 'opaque-correlation', authorization: 'Bearer fixture-only' });
    await runtime.provider.forceFlush({ timeoutMillis: 1000 });
    const spans = exporter.getFinishedSpans(), server = spans.find(span => span.name === 'http.server')!, client = spans.find(span => span.name === 'http.client')!;
    expect(server.parentSpanContext?.spanId).toBe(parentId); expect(client.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
    expect(downstream!.traceparent).toContain(client.spanContext().spanId);
    const logs = lines.join(''); expect(logs).not.toMatch(/private-id|secret-query|private-credential|fixture-only/);
    const entries = logs.trim().split('\n').map(row => JSON.parse(row) as Record<string, unknown>);
    const outbound = entries.find(row => row.event === 'http.client.completed')!;
    expect(outbound).toMatchObject({ env: 'test', service: cfg.metrics.service, role: cfg.role, version: cfg.telemetry.version,
      service_instance_id: cfg.instanceId, traceId: 'opaque-correlation', trace_id: traceId, span_id: client.spanContext().spanId,
      dependency: 'embedding', operation: 'embed', statusCode: 200, outcome: 'success', durationMs: expect.any(Number) });
    expect(outbound).not.toHaveProperty('status');
    const metrics = await app.metrics.registry.metrics();
    expect(metrics).toMatch(/http_client_requests_total\{[^\n]*dependency="embedding"[^\n]*operation="embed"[^\n]*outcome="success"[^\n]*\} 1/);
    expect(metrics).toContain(`service_instance_id="${cfg.instanceId}"`);
    expect(metrics.split('\n').filter(row => row.startsWith('http_client_')).every(row => !row.includes('service_instance_id'))).toBe(true);
  });

  it('keeps observer scopes isolated while an undefined nested observer preserves its parent', async () => {
    const first = new ApplicationMetrics(config()), second = new ApplicationMetrics(config());
    await Promise.all([first, second].map(metrics => withApplicationMetrics(metrics, async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      withApplicationMetrics(undefined, () => expect(currentApplicationMetrics()).toBe(metrics));
    })));
    expect(currentApplicationMetrics()).toBeUndefined();
  });

  it('distinguishes HTTP, protocol, business, network, timeout and caller cancellation without changing errors', async () => {
    const cfg = config(), metrics = new ApplicationMetrics(cfg), runtime = createApplicationTelemetry(cfg);
    cleanups.push(() => runtime.shutdown());
    await withTelemetryRuntime(runtime, () => withApplicationMetrics(metrics, async () => {
      const request = (fetchImpl: typeof fetch) => new ServiceHttpClient({ dependency: 'embedding', operation: 'embed', fetchImpl });
      const target = 'https://fixture.test/secret-resource?token=private-url-value';
      expect(await request(async () => new Response('{}', { status: 503 })).request(target, {}, { timeoutMs: 1000 }, async response => response.status)).toBe(503);
      const protocol = new ServiceHttpError('HTTP_RESPONSE_INVALID');
      await expect(request(async () => new Response('{}')).request(target, {}, { timeoutMs: 1000 }, async () => { throw protocol; })).rejects.toBe(protocol);
      const business = Object.assign(new Error('private-business-text'), { code: 'PROVIDER_REJECTED' });
      await expect(request(async () => new Response('{}')).request(target, {}, { timeoutMs: 1000 }, async () => { throw business; })).rejects.toBe(business);
      const hostile = Object.defineProperty(new Error('private-original-error'), 'code', { get() { throw new Error('diagnostic-getter'); } });
      await expect(request(async () => new Response('{}')).request(target, {}, { timeoutMs: 1000 }, async () => { throw hostile; })).rejects.toBe(hostile);
      const network = new TypeError('private-network-url');
      await expect(request(async () => { throw network; }).request(target, {}, { timeoutMs: 1000 }, async () => null)).rejects.toBe(network);
      const controller = new AbortController(); controller.abort();
      await expect(request(async () => { throw new Error('FETCH_MUST_NOT_RUN'); }).request(target, { signal: controller.signal }, { timeoutMs: 1000 }, async () => null)).rejects.toMatchObject({ name: 'AbortError' });
      const slow = await listen(createServer((_request, response) => { response.writeHead(200); response.flushHeaders(); response.write('{'); }));
      await expect(new ServiceHttpClient({ dependency: 'document_parser', operation: 'job_result' }).request(slow, {}, { timeoutMs: 30 }, response => readJsonResponse(response, 100))).rejects.toMatchObject({ name: expect.stringMatching(/AbortError|TimeoutError/) });
    }));
    const body = await metrics.registry.metrics();
    for (const outcome of ['http_error', 'response_error', 'business_error', 'network_error', 'cancelled', 'timeout'])
      expect(body).toContain(`outcome="${outcome}"`);
    expect(body).toContain('status="none"');
    expect(body).not.toMatch(/secret-resource|private-url|private-business|private-network|fixture.test/);
    expect(body.split('\n').filter(row => row.startsWith('http_client_requests_total{')).reduce((sum, row) => sum + Number(row.split(' ').at(-1)), 0)).toBe(7);
  });

  it('counts a real incomplete HTTP response once without treating its 200 headers as completion', async () => {
    const app = await buildBase({ config: config(), dependencies: dependencies() });
    cleanups.push(() => app.close());
    app.get('/api/v1/incomplete/:id', async (_request, reply) => {
      reply.hijack(); reply.raw.writeHead(200); reply.raw.write('first chunk');
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      const outgoing = get(address + '/api/v1/incomplete/private-id', response => {
        response.once('data', () => { response.destroy(); outgoing.destroy(); resolve(); });
        response.on('error', () => undefined);
      });
      outgoing.on('error', error => { if ((error as { code?: string }).code !== 'ECONNRESET') reject(error); });
    });
    let body = '';
    for (let attempt = 0; attempt < 50; attempt++) {
      body = await app.metrics.registry.metrics();
      if (body.includes('http_aborted_requests_total{')) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(body).toMatch(/http_aborted_requests_total\{[^\n]*route="\/api\/v1\/incomplete\/:id"[^\n]*\} 1/);
    expect(body.split('\n').filter(row => row.startsWith('http_requests_total{'))).toEqual([]);
    expect(app.lifecycle.activeRequests).toBe(0);
    expect(body).not.toContain('private-id');
  });
});
interface TraceCarrierLike { traceparent: string | null; correlation: string | null; authorization: string | null; }
