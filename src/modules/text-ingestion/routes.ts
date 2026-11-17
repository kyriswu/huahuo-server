import { readTrustedScope } from '../identity/trusted-scope.js';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { success, ErrorSchema } from '../../contracts/envelope.js';
import { idempotencyKey } from '../identity/routes.js';
import { DomainError } from '../identity/store.js';
import { Envelope, Id, Strict } from '../identity/schemas.js';
import { assertCreateTextIngestionInput, assertUpdateTextIngestionInput } from './policy.js';
import { CreateTextIngestionSchema, UpdateTextIngestionSchema, TextIngestionJobSchema } from './schemas.js';
import type { TextIngestionService } from './service.js';
import type { StorageService } from '../storage/service.js';
import type { TextIngestionJob } from './types.js';
import { textImageViews } from './image-view.js';
import { EDITABLE_MARKDOWN_BODY_LIMIT, EDITABLE_MARKDOWN_MAX_CHARS } from '../../lib/kb-image-markdown.js';

export function registerTextIngestionRoutes(app: FastifyInstance, service: TextIngestionService, storage: StorageService): void {
  const path = '/api/v1/text-ingestions';
  const params = Type.Object({ id: Id }, Strict), empty = Type.Object({}, Strict);
  const errors = { 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 412: ErrorSchema, 413: ErrorSchema, 428: ErrorSchema, 503: ErrorSchema };
  const guard = async (req: FastifyRequest, reply: FastifyReply) => { reply.header('Cache-Control', 'no-store'); req.authScope = readTrustedScope(req.headers, req.id); };
  const scope = (req: FastifyRequest) => { if (!req.authScope) throw new DomainError(401, 'UNAUTHORIZED'); return req.authScope; };
  const view = async (req: FastifyRequest, job: TextIngestionJob) => (await textImageViews(storage, scope(req), [job]))[0]!;
  app.post(path, { bodyLimit: EDITABLE_MARKDOWN_BODY_LIMIT, preValidation: async (req, reply) => { await guard(req, reply); assertCreateTextIngestionInput(req.body, EDITABLE_MARKDOWN_MAX_CHARS); },
    schema: { body: CreateTextIngestionSchema, querystring: empty, response: { 200: Envelope(TextIngestionJobSchema), ...errors } },
  }, async req => success(await view(req, await service.create(scope(req), req.body, idempotencyKey(req, 'required')!)), req.id));
  app.get(path, { preHandler: guard, schema: { querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), before: Type.Optional(Id) }, Strict),
    response: { 200: Envelope(Type.Object({ items: Type.Array(TextIngestionJobSchema), nextCursor: Type.Union([Id, Type.Null()]) }, Strict)), ...errors } },
  }, async req => { const result = await service.list(scope(req), req.query as { limit?: number; before?: string }); return success({ ...result, items: await textImageViews(storage, scope(req), result.items) }, req.id); });
  app.get<{ Params: { id: string } }>(`${path}/:id`, { preHandler: guard, schema: { params, querystring: empty, response: { 200: Envelope(TextIngestionJobSchema), ...errors } } },
    async (req, reply) => { const result = await service.get(scope(req), req.params.id); reply.header('ETag', result.etag); return success(await view(req, result.data), req.id); });
  app.patch<{ Params: { id: string } }>(`${path}/:id`, { bodyLimit: EDITABLE_MARKDOWN_BODY_LIMIT, preValidation: async (req, reply) => { await guard(req, reply); assertUpdateTextIngestionInput(req.body, EDITABLE_MARKDOWN_MAX_CHARS); },
    schema: { params, body: UpdateTextIngestionSchema, querystring: empty, response: { 200: Envelope(TextIngestionJobSchema), ...errors } },
  }, async req => {
    const ifMatch = req.headers['if-match'];
    if (typeof ifMatch !== 'string' || !ifMatch) throw new DomainError(428, 'IF_MATCH_REQUIRED');
    return success(await view(req, await service.update(scope(req), req.params.id, req.body, idempotencyKey(req, 'required')!, ifMatch)), req.id);
  });
  app.post<{ Params: { id: string } }>(`${path}/:id/retry`, { preHandler: guard, schema: { params, body: empty, querystring: empty, response: { 200: Envelope(TextIngestionJobSchema), ...errors } } },
    async req => success(await view(req, await service.retry(scope(req), req.params.id, idempotencyKey(req, 'required')!)), req.id));
}
