import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DocumentSectionSchema, SectionIdSchema, TocFields } from '../../contracts/document-sections.js';
import { ErrorSchema, success } from '../../contracts/envelope.js';
import { DomainError } from '../identity/store.js';
import type { IdentityService } from '../identity/service.js';
import { idempotencyKey } from '../identity/routes.js';
import { AgentServiceKeyAuthenticator } from '../internal-auth/api-key.js';
import { Envelope, Id, Strict, Text } from '../identity/schemas.js';
import type { RagIngestionRepository } from './repository.js';
import type { RagQueryService } from './query-service.js';
import type { StoragePort } from '../storage/port.js';
const errors={400:ErrorSchema,401:ErrorSchema,404:ErrorSchema,409:ErrorSchema,413:ErrorSchema,429:ErrorSchema,503:ErrorSchema};
const body=Type.Object({ossUrl:Type.String({maxLength:4096}),fileName:Text(255),mimeType:Text(128),idempotencyKey:Type.Optional(Text(128))},Strict);
const result=Type.Object({jobId:Id,documentVersionId:Id,status:Type.String(),reused:Type.Boolean()},Strict);
const queryBody=Type.Object({query:Text(2000),sourceType:Type.Optional(Type.Union([Type.Literal('file'),Type.Literal('note'),Type.Literal('text')])),mode:Type.Optional(Type.Union([Type.Literal('dense'),Type.Literal('keyword'),Type.Literal('hybrid')])),topK:Type.Optional(Type.Integer({minimum:1,maximum:50})),documentKey:Type.Optional(Text(128)),documentId:Type.Optional(Text(128))},Strict);
const queryResult=Type.Object({mode:Type.Union([Type.Literal('dense'),Type.Literal('keyword'),Type.Literal('hybrid')]),query:Type.String(),results:Type.Array(Type.Any())},Strict);
const detail=Type.Object({jobId:Id,documentVersionId:Id,status:Type.String(),currentStage:Type.String(),taskState:Type.Union([Type.String(),Type.Null()]),mode:Type.Union([Type.Literal('structured_document'),Type.Literal('plain_text')]),fileName:Type.String(),mimeType:Type.String(),sourceSha256:Type.Union([Type.String(),Type.Null()]),sourceSizeBytes:Type.Union([Type.Integer(),Type.Null()]),parserProvider:Type.Union([Type.String(),Type.Null()]),parserVersion:Type.Union([Type.String(),Type.Null()]),canonicalMarkdownUri:Type.Union([Type.String(),Type.Null()]),rawMarkdownUri:Type.Union([Type.String(),Type.Null()]),embeddingStatus:Type.String(),indexStatus:Type.String(),embeddingModel:Type.String(),embeddingDimension:Type.Integer(),milvusCollection:Type.String(),parentId:Type.Optional(Type.String()),sourceType:Type.Optional(Type.String()),...TocFields,tocError:Type.Optional(Type.Union([Type.String(),Type.Null()])),deletedAt:Type.Optional(Type.Union([Type.String(),Type.Null()])),cleanupStatus:Type.Optional(Type.String()),processingComplete:Type.Optional(Type.Boolean()),childCount:Type.Integer(),error:Type.Union([Type.Object({code:Type.String(),message:Type.Union([Type.String(),Type.Null()]),retryable:Type.Boolean()}),Type.Null()]),createdAt:Type.String(),updatedAt:Type.String()},Strict);
const scope=(req:FastifyRequest)=>{if(!req.authScope)throw new DomainError(401,'UNAUTHORIZED');return req.authScope;};
export function registerRagRoutes(
  app: FastifyInstance, identity: IdentityService, repository: RagIngestionRepository,
  storage: Pick<StoragePort, 'read'>, queryService?: RagQueryService,
) {
  const guard = async (req: FastifyRequest) => {
    req.authScope = await identity.authenticate(req.headers.authorization, req.id);
  };
  const readGuard = async (req: FastifyRequest) => {
    idempotencyKey(req, 'forbidden');
    await guard(req);
  };
  const ingestionPath = '/api/v1/rag/ingestions';
  const emptyQuery = Type.Object({}, Strict);
  for (const action of ['delete', 'retry-toc'] as const) {
    app.post<{ Params: { jobId: string } }>(`${ingestionPath}/:jobId/${action}`, {
      preHandler: guard,
      schema: { params: Type.Object({ jobId: Id }, Strict), body: Type.Object({}, Strict), response: { 200: Envelope(Type.Object({ jobId: Id, documentVersionId: Id, status: Type.String() }, Strict)), ...errors } },
    }, async req => success(await repository.action(scope(req), req.params.jobId, action), req.id));
  }
  app.post<{ Body: { ossUrl: string; fileName: string; mimeType: string; idempotencyKey?: string } }>(ingestionPath, {
    preHandler: guard,
    schema: { body, querystring: emptyQuery, response: { 200: Envelope(result), ...errors } },
  }, async req => {
    const key = idempotencyKey(req, 'optional') ?? req.body.idempotencyKey;
    return success(await repository.create(scope(req), { ...req.body, idempotencyKey: key }), req.id);
  });
  app.get<{ Params: { jobId: string } }>(`${ingestionPath}/:jobId`, {
    preHandler: readGuard,
    schema: { params: Type.Object({ jobId: Id }, Strict), querystring: emptyQuery, response: { 200: Envelope(detail), ...errors } },
  }, async req => success(await repository.detail(scope(req), req.params.jobId), req.id));
  app.get<{ Params: { jobId: string; sectionId: string } }>(`${ingestionPath}/:jobId/sections/:sectionId`, {
    preHandler: readGuard,
    schema: { params: Type.Object({ jobId: Id, sectionId: SectionIdSchema }, Strict), querystring: emptyQuery, response: { 200: Envelope(DocumentSectionSchema), ...errors } },
  }, async req => success(await repository.section(scope(req), req.params.jobId, req.params.sectionId, storage), req.id));

  if (queryService) {
    const agentAuth = new AgentServiceKeyAuthenticator(identity.config);
    const queryHandler = async (req: FastifyRequest) => success(await queryService.query(scope(req), req.body as { query: string; sourceType?: 'file' | 'note' | 'text'; mode?: 'dense' | 'keyword' | 'hybrid'; topK?: number; documentKey?: string; documentId?: string }), req.id);
    const querySchema = { body: queryBody, querystring: emptyQuery, response: { 200: Envelope(queryResult), ...errors } };
    const queryRoute = { preHandler: async (req: FastifyRequest) => { idempotencyKey(req, 'optional'); await guard(req); }, schema: querySchema };
    const internalQueryRoute = {
      preHandler: async (req: FastifyRequest) => {
        idempotencyKey(req, 'optional');
        agentAuth.verify(typeof req.headers['x-huahuo-service-key'] === 'string' ? req.headers['x-huahuo-service-key'] : undefined);
        await guard(req);
      },
      schema: querySchema,
    };
    app.post('/api/v1/rag/query', queryRoute, queryHandler);
    app.post('/api/v1/huahuo_rag/query', queryRoute, queryHandler);
    app.post('/internal/v1/rag/query', internalQueryRoute, queryHandler);
  }
}
