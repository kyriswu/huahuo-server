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
import { NoteQueryTiming } from './query-timing.js';
const errors={400:ErrorSchema,401:ErrorSchema,404:ErrorSchema,409:ErrorSchema,413:ErrorSchema,429:ErrorSchema,503:ErrorSchema};
const body=Type.Object({ossUrl:Type.String({maxLength:4096}),fileName:Text(255),mimeType:Type.String({minLength:1,maxLength:128,description:'UTF-8 text, or PDF/Office when document extraction is enabled.'}),idempotencyKey:Type.Optional(Text(128)),sourceResourceId:Type.Optional(Id),parseRunId:Type.Optional(Id)},Strict);
const result=Type.Object({jobId:Id,documentVersionId:Id,status:Type.String(),reused:Type.Boolean()},Strict);
const queryBody=Type.Object({query:Text(2000),sourceType:Type.Optional(Type.Union([Type.Literal('file'),Type.Literal('note'),Type.Literal('text')])),assetMode:Type.Optional(Type.Union([Type.Literal('ids'),Type.Literal('links')])),mode:Type.Optional(Type.Union([Type.Literal('dense'),Type.Literal('keyword'),Type.Literal('hybrid')])),topK:Type.Optional(Type.Integer({minimum:1,maximum:50})),documentKey:Type.Optional(Text(128)),},Strict);
const queryResult=Type.Object({mode:Type.Union([Type.Literal('dense'),Type.Literal('keyword'),Type.Literal('hybrid')]),query:Type.String(),results:Type.Array(Type.Any())},Strict);
const detail=Type.Object({jobId:Id,documentVersionId:Id,status:Type.String(),currentStage:Type.String(),taskState:Type.Union([Type.String(),Type.Null()]),mode:Type.Union([Type.Literal('structured_document'),Type.Literal('plain_text')]),fileName:Type.String(),mimeType:Type.String(),sourceSha256:Type.Union([Type.String(),Type.Null()]),sourceSizeBytes:Type.Union([Type.Integer(),Type.Null()]),parserProvider:Type.Union([Type.String(),Type.Null()]),parserVersion:Type.Union([Type.String(),Type.Null()]),canonicalMarkdownUri:Type.Union([Type.String(),Type.Null()]),rawMarkdownUri:Type.Union([Type.String(),Type.Null()]),parentId:Type.Optional(Type.String()),sourceType:Type.Optional(Type.String()),...TocFields,tocError:Type.Optional(Type.Union([Type.String(),Type.Null()])),deletedAt:Type.Optional(Type.Union([Type.String(),Type.Null()])),cleanupStatus:Type.Optional(Type.String()),processingComplete:Type.Optional(Type.Boolean()),error:Type.Union([Type.Object({code:Type.String(),message:Type.Union([Type.String(),Type.Null()]),retryable:Type.Boolean()}),Type.Null()]),createdAt:Type.String(),updatedAt:Type.String()},Strict);
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
  app.get<{Params:{jobId:string}}>(`${ingestionPath}/:jobId/extraction`,{
    preHandler:readGuard,schema:{params:Type.Object({jobId:Id},Strict),querystring:emptyQuery},
  },async(req,reply)=>{const result=await repository.extraction(scope(req),req.params.jobId,storage);return reply.type('application/json').send(result);});
  app.get<{Params:{jobId:string;resourceId:string}}>(`${ingestionPath}/:jobId/assets/:resourceId`,{
    preHandler:readGuard,schema:{params:Type.Object({jobId:Id,resourceId:Id},Strict),querystring:emptyQuery},
  },async(req,reply)=>{const asset=await repository.asset(scope(req),req.params.jobId,req.params.resourceId,storage);return reply.type(asset.mimeType).header('Content-Length',asset.sizeBytes).header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"default-src 'none'; sandbox").send(asset.stream);});
  app.post<{ Body: import('./repository.js').CreateRagInput }>(ingestionPath, {
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
    const timings = new WeakMap<FastifyRequest, NoteQueryTiming>();
    const queryHandler = async (req: FastifyRequest) => success(await queryService.query(scope(req), req.body as { query: string; sourceType?: 'file' | 'note' | 'text'; assetMode?: 'ids' | 'links'; mode?: 'dense' | 'keyword' | 'hybrid'; topK?: number; documentKey?: string;  }, timings.get(req)), req.id);
    const timingHooks = {
      onRequest: async (req: FastifyRequest) => { timings.set(req, new NoteQueryTiming()); },
      onSend: async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
        reply.header('Cache-Control', 'no-store');
        if ((req.body as { sourceType?: string } | undefined)?.sourceType === 'note') reply.header('Server-Timing', timings.get(req)?.serverTiming() ?? '');
      },
      onResponse: async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
        if ((req.body as { sourceType?: string } | undefined)?.sourceType === 'note') req.log.info({ event: 'note_rag_query', statusCode: reply.statusCode, ...timings.get(req)?.snapshot() }, 'Note RAG query completed');
      },
    };
    const queryGuard = async (req: FastifyRequest) => { await timings.get(req)!.measure('auth', () => guard(req)); };
    const querySchema = { body: queryBody, querystring: emptyQuery, response: { 200: Envelope(queryResult), ...errors } };
    const queryRoute = { ...timingHooks, preHandler: async (req: FastifyRequest) => { idempotencyKey(req, 'optional'); await queryGuard(req); }, schema: querySchema };
    const internalQueryRoute = {
      ...timingHooks,
      preHandler: async (req: FastifyRequest) => {
        idempotencyKey(req, 'optional');
        agentAuth.verify(typeof req.headers['x-huahuo-service-key'] === 'string' ? req.headers['x-huahuo-service-key'] : undefined);
        await queryGuard(req);
      },
      schema: querySchema,
    };
    app.post('/api/v1/rag/query', queryRoute, queryHandler);
    app.post('/api/v1/kb/notes/query', queryRoute, async req => { req.body={...(req.body as object),sourceType:'note'};return queryHandler(req); });
    app.post('/api/v1/kb/documents/query', queryRoute, async req => { req.body={...(req.body as object),sourceType:'file'};return queryHandler(req); });
    app.post('/internal/v1/rag/query', internalQueryRoute, queryHandler);
  }
}
