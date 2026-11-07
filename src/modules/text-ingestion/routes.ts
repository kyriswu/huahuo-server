import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { success, ErrorSchema } from '../../contracts/envelope.js';
import type { IdentityService } from '../identity/service.js';
import { idempotencyKey } from '../identity/routes.js';
import { DomainError } from '../identity/store.js';
import { Envelope, Id, Strict } from '../identity/schemas.js';
import { assertCreateTextIngestionInput, assertUpdateTextIngestionInput } from './policy.js';
import { CreateTextIngestionSchema, UpdateTextIngestionSchema, TextIngestionJobSchema } from './schemas.js';
import type { TextIngestionService } from './service.js';

export function registerTextIngestionRoutes(app: FastifyInstance, identity: IdentityService, service: TextIngestionService): void {
  const path = '/api/v1/text-ingestions';
  const params = Type.Object({ id: Id }, Strict), empty = Type.Object({}, Strict);
  const errors = { 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 412: ErrorSchema, 413: ErrorSchema, 428: ErrorSchema, 503: ErrorSchema };
  const guard = async (req: FastifyRequest) => { req.authScope = await identity.authenticate(req.headers.authorization, req.id); };
  const scope = (req: FastifyRequest) => { if (!req.authScope) throw new DomainError(401, 'UNAUTHORIZED'); return req.authScope; };
  app.post(path, { preValidation: async req => { await guard(req); assertCreateTextIngestionInput(req.body); },
    schema: { body: CreateTextIngestionSchema, querystring: empty, response: { 200: Envelope(TextIngestionJobSchema), ...errors } },
  }, async req => success(await service.create(scope(req), req.body, idempotencyKey(req, 'required')!), req.id));
  app.get(path, { preHandler: guard, schema: { querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), before: Type.Optional(Id) }, Strict),
    response: { 200: Envelope(Type.Object({ items: Type.Array(TextIngestionJobSchema), nextCursor: Type.Union([Id, Type.Null()]) }, Strict)), ...errors } },
  }, async req => success(await service.list(scope(req), req.query as { limit?: number; before?: string }), req.id));
  app.get<{ Params: { id: string } }>(`${path}/:id`, { preHandler: guard, schema: { params, querystring: empty, response: { 200: Envelope(TextIngestionJobSchema), ...errors } } },
    async (req, reply) => { const result = await service.get(scope(req), req.params.id); reply.header('ETag', result.etag); return success(result.data, req.id); });
  app.patch<{ Params: { id: string } }>(`${path}/:id`, { preValidation: async req => { await guard(req); assertUpdateTextIngestionInput(req.body); },
    schema: { params, body: UpdateTextIngestionSchema, querystring: empty, response: { 200: Envelope(TextIngestionJobSchema), ...errors } },
  }, async req => {
    const ifMatch = req.headers['if-match'];
    if (typeof ifMatch !== 'string' || !ifMatch) throw new DomainError(428, 'IF_MATCH_REQUIRED');
    return success(await service.update(scope(req), req.params.id, req.body, idempotencyKey(req, 'required')!, ifMatch), req.id);
  });
  app.post<{ Params: { id: string } }>(`${path}/:id/retry`, { preHandler: guard, schema: { params, body: empty, querystring: empty, response: { 200: Envelope(TextIngestionJobSchema), ...errors } } },
    async req => success(await service.retry(scope(req), req.params.id, idempotencyKey(req, 'required')!), req.id));
}
