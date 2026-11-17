import Fastify, { LogController, type FastifyError, type FastifyLoggerOptions } from 'fastify';
import swagger from '@fastify/swagger';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AppConfig } from '../config/config.js';
import { createDependencies, isReady, type Dependencies } from '../plugins/dependencies.js';
import { success, failure, requestTrace, ErrorSchema, HealthSchema } from '../contracts/envelope.js';
import { DomainError } from '../modules/identity/store.js';
import {closeStateStreams} from '../lib/state-stream.js';
import { registerMetrics, withApplicationMetrics, httpOutcome, httpTraffic, type ApplicationMetrics } from '../plugins/metrics.js';
import { registerLifecycle } from '../plugins/lifecycle.js';
import { RuntimeSettings } from '../modules/runtime-settings/service.js';
import { DEFAULT_DRAIN_TIMEOUT_MS } from '../modules/runtime-settings/registry.js';
import { createErrorSerializer } from '../lib/error-log.js';
import {withTraceId} from '../lib/trace.js';
import { SpanKind } from '@opentelemetry/api';
import { createApplicationTelemetry, currentTelemetryFields, withTelemetryRuntime, withTraceContext, type ApplicationTelemetry } from '../observability/telemetry.js';
import { telemetryIdentity } from '../observability/identity.js';
declare module 'fastify' { interface FastifyInstance {
  drainTimeoutSnapshotMs(): number;
  readDrainTimeoutMs(): Promise<number>;
} }
export interface BuildOptions { config: AppConfig; dependencies?: Dependencies; backgroundHealthy?:()=>boolean; backgroundActive?:()=>number; metrics?:ApplicationMetrics; telemetry?:ApplicationTelemetry; loggerStream?:FastifyLoggerOptions['stream']; }
export async function buildBase({ config, dependencies, backgroundHealthy, backgroundActive, metrics, telemetry: suppliedTelemetry, loggerStream }: BuildOptions) {
  const deps = dependencies ?? createDependencies(config);
  const telemetry = suppliedTelemetry ?? createApplicationTelemetry(config);
  const identity = telemetryIdentity(config);
  const app = Fastify({ logger: {
    level: config.logLevel, base: identity,
    mixin: currentTelemetryFields,
    ...(loggerStream ? { stream: loggerStream } : {}),
    redact: { paths: ['req.headers.authorization','req.headers.cookie','res.headers.set-cookie','password','token','secret'], censor: '[REDACTED]' },
    serializers: { req: req => ({ method: req.method, route: req.routeOptions?.url }), err: createErrorSerializer(config) },
  }, genReqId: req => requestTrace(req.headers,req.url), logController: new LogController({ requestIdLogLabel: 'traceId', disableRequestLogging: true }),
  // Request timeout bounds receiving the request, not the handler's total work.
  requestTimeout: config.httpRequestTimeoutMs,
  connectionTimeout: config.httpConnectionTimeoutMs,
  // Business ports are reachable only through trusted ingress/internal callers;
  // standalone processes default to no trust. The configured proxy chain must
  // have no untrusted bypass.
  trustProxy: (_address: string, hop: number) => hop < config.httpTrustProxyHops,
  // Finish API requests already reaching the retiring upstream; dependencies
  // remain available until onClose and the existing drain deadline still applies.
  ...(config.role === 'api-server' ? { return503OnClosing: false } : {}),
  bodyLimit: 1048576,
  ajv: { customOptions: { removeAdditional: false } }, forceCloseConnections: 'idle' }).withTypeProvider<TypeBoxTypeProvider>();
  registerMetrics(app, config, metrics);
  telemetry.setLogger(app.log);
  const lifecycle = registerLifecycle(app, backgroundActive);
  const runtimeSettings = deps.pool ? new RuntimeSettings(deps.pool, config) : undefined;
  app.decorate('drainTimeoutSnapshotMs', () => runtimeSettings?.drainTimeoutSnapshotMs() ?? DEFAULT_DRAIN_TIMEOUT_MS);
  app.decorate('readDrainTimeoutMs', async () => runtimeSettings ? runtimeSettings.readDrainTimeoutMs() : DEFAULT_DRAIN_TIMEOUT_MS);
  // App buildCommonHeaders sends JSON Content-Type even for body-less POSTs.
  // Route schemas still reject an absent body wherever fields are required.
  const jsonParser = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '') done(null, undefined);
    else jsonParser(req, typeof body === 'string' ? body : body.toString(), done);
  });
  await app.register(swagger, { openapi: { info: { title: `Huahuo ${config.role}`, version: '0.1.0' } } });
  app.addHook('onRequest', (req, reply, done) => {
    reply.header('X-Trace-Id', req.id).header('Cache-Control', 'no-store');
    withTelemetryRuntime(telemetry, () => withTraceContext(req.headers, () => {
      const route = req.routeOptions.url ?? 'unmatched';
      const operation = telemetry.start('http.server', { 'http.request.method': req.method, 'http.route': route, traffic: httpTraffic(route) }, SpanKind.SERVER);
      const started = process.hrtime.bigint();
      let finished = false;
      const end = () => {
        if (finished) return; finished = true;
        const outcome = reply.raw.writableFinished ? httpOutcome(reply.raw.statusCode) : 'aborted';
        operation.run(() => {
          req.log.info({ event: 'http.server.completed', method: req.method, route, statusCode: reply.raw.writableFinished ? reply.raw.statusCode : undefined,
            outcome, traffic: httpTraffic(route), durationMs: Number(process.hrtime.bigint() - started) / 1e6 }, 'Request completed');
          operation.end({ outcome, 'http.response.status_code': reply.raw.writableFinished ? reply.raw.statusCode : undefined }, outcome === 'server_error' || outcome === 'aborted');
        });
      };
      reply.raw.once('finish', end); reply.raw.once('close', end);
      operation.run(() => withApplicationMetrics(app.metrics, () => withTraceId(req.id, () => {
        req.log = req.log.child(currentTelemetryFields());
        req.log.info({ event: 'http.server.started', method: req.method, route, traffic: httpTraffic(route) }, 'Request started');
        done();
      })));
    }));
  });
  app.addHook('preClose', async () => {
    // Retiring API streams keep their subscriptions and dependencies until their
    // response finishes, bounded by the process's existing DB drain deadline.
    // Admin trials are intentionally ephemeral and close immediately.
    if (config.role !== 'api-server') closeStateStreams(app);
    await lifecycle.close();
  });
  app.addHook('onClose', async () => { await deps.close(); });
  app.addHook('onClose', async () => { await telemetry.shutdown(); });
  app.setErrorHandler<FastifyError>((error, req, reply) => {
    if (error instanceof DomainError) {
      if (error.statusCode >= 500) req.log.error({ err: error, errorCode: error.code, method: req.method, route: req.routeOptions.url ?? 'unmatched', statusCode: error.statusCode }, 'Request failed');
      if (error.statusCode === 429) reply.header('Retry-After', '60');
      return reply.code(error.statusCode).send(failure(error.code, 'Request could not be completed', req.id, error.statusCode === 503));
    }
    const status = error.validation ? 400 : error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) req.log.error({ err: error, errorCode: 'INTERNAL_ERROR', method: req.method, route: req.routeOptions.url ?? 'unmatched', statusCode: status }, 'Request failed');
    const code = status === 400 ? 'BAD_REQUEST' : status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_REJECTED';
    reply.code(status).send(failure(code, status === 500 ? 'Service temporarily unavailable' : 'Invalid request', req.id, status === 500));
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send(failure('NOT_FOUND', 'Resource not found', req.id)));
  const querystring = Type.Object({}, { additionalProperties: false });
  const response = { 200: HealthSchema, 400: ErrorSchema, 503: ErrorSchema };
  app.get('/health/live', { schema: { querystring, response } }, async req => {
    return success({ service: config.role, status: 'live' as const, stage: 'P06' as const, mode: 'asset-knowledge' as const }, req.id);
  });
  app.get('/health/ready', { schema: { querystring, response } }, async (req, reply) => {
    let ready: boolean;
    try {
      ready = lifecycle.phase === 'serving' && (backgroundHealthy?.()??true) && isReady(await deps.check());
      if (ready) await runtimeSettings?.load();
      // A signal can start draining while dependency/configuration probes await I/O.
      ready &&= lifecycle.phase === 'serving';
    } catch { ready = false; }
    if (!ready) return reply.code(503).send(failure('DEPENDENCY_NOT_READY', 'Service dependencies are not ready', req.id, true));
    return success({ service: config.role, status: 'ready' as const, stage: 'P06' as const, mode: 'asset-knowledge' as const }, req.id);
  });
  return app;
}
