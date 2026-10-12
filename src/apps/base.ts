import Fastify, { LogController, type FastifyError } from 'fastify';
import swagger from '@fastify/swagger';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AppConfig } from '../config/config.js';
import { createDependencies, isReady, type Dependencies } from '../plugins/dependencies.js';
import { success, failure, requestTrace, ErrorSchema, HealthSchema } from '../contracts/envelope.js';
import { DomainError } from '../modules/identity/store.js';
export interface BuildOptions { config: AppConfig; dependencies?: Dependencies; backgroundHealthy?:()=>boolean; }
export async function buildBase({ config, dependencies, backgroundHealthy }: BuildOptions) {
  const deps = dependencies ?? createDependencies(config);
  const app = Fastify({ logger: {
    level: config.logLevel, base: { service: config.role, instanceId: config.instanceId },
    redact: { paths: ['req.headers.authorization','req.headers.cookie','res.headers.set-cookie','password','token','secret'], censor: '[REDACTED]' },
    serializers: { req: req => ({ method: req.method, route: req.routeOptions?.url }), err: () => ({ type: 'Error', message: 'Internal failure', stack: '' }) },
  }, genReqId: req => requestTrace(req.headers), logController: new LogController({ requestIdLogLabel: 'traceId' }),
  requestTimeout: 15000, connectionTimeout: 10000, bodyLimit: 1048576,
  ajv: { customOptions: { removeAdditional: false } }, forceCloseConnections: 'idle' }).withTypeProvider<TypeBoxTypeProvider>();
  let stopping = false;
  // App buildCommonHeaders sends JSON Content-Type even for body-less POSTs.
  // Route schemas still reject an absent body wherever fields are required.
  const jsonParser = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '') done(null, undefined);
    else jsonParser(req, typeof body === 'string' ? body : body.toString(), done);
  });
  await app.register(swagger, { openapi: { info: { title: `Huahuo ${config.role}`, version: '0.1.0' } } });
  app.addHook('onRequest', async (req, reply) => { reply.header('X-Trace-Id', req.id).header('Cache-Control', 'no-store'); });
  app.addHook('preClose', async () => { stopping = true; });
  app.addHook('onClose', async () => { await deps.close(); });
  app.setErrorHandler<FastifyError>((error, req, reply) => {
    if (error instanceof DomainError) {
      if (error.statusCode === 429) reply.header('Retry-After', '60');
      return reply.code(error.statusCode).send(failure(error.code, 'Request could not be completed', req.id, error.statusCode === 503));
    }
    const status = error.validation ? 400 : error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) req.log.error({ errorCode: 'INTERNAL_ERROR' }, 'Request failed');
    const code = status === 400 ? 'BAD_REQUEST' : status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_REJECTED';
    reply.code(status).send(failure(code, status === 500 ? 'Service temporarily unavailable' : 'Invalid request', req.id, status === 500));
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send(failure('NOT_FOUND', 'Resource not found', req.id)));
  const querystring = Type.Object({}, { additionalProperties: false });
  const response = { 200: HealthSchema, 400: ErrorSchema, 503: ErrorSchema };
  app.get('/health/live', { schema: { querystring, response } }, async (req, reply) => {
    if (stopping) return reply.code(503).send(failure('STOPPING', 'Service stopping', req.id, true));
    return success({ service: config.role, status: 'live' as const, stage: 'P06' as const, mode: 'asset-knowledge' as const }, req.id);
  });
  app.get('/health/ready', { schema: { querystring, response } }, async (req, reply) => {
    let ready = false;
    try { ready = !stopping && (backgroundHealthy?.()??true) && isReady(await deps.check()); } catch { /* fail closed */ }
    if (!ready) return reply.code(503).send(failure('DEPENDENCY_NOT_READY', 'Service dependencies are not ready', req.id, true));
    return success({ service: config.role, status: 'ready' as const, stage: 'P06' as const, mode: 'asset-knowledge' as const }, req.id);
  });
  return app;
}
