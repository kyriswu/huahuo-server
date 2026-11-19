import { readTrustedScope } from '../identity/trusted-scope.js';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DocumentSectionSchema, SectionIdSchema, TocFields } from '../../contracts/document-sections.js';
import { ErrorSchema, success } from '../../contracts/envelope.js';
import { DomainError } from '../identity/store.js';
import { idempotencyKey } from '../identity/routes.js';
import { Envelope, Id, Strict, Text } from '../identity/schemas.js';
import type { RagIngestionRepository } from './repository.js';
import type { RagQueryService } from './query-service.js';
import type { StoragePort } from '../storage/port.js';
import { createRagQueryRoute } from './query-routes.js';
const errors={400:ErrorSchema,401:ErrorSchema,404:ErrorSchema,409:ErrorSchema,413:ErrorSchema,429:ErrorSchema,503:ErrorSchema};
const body=Type.Object({ossUrl:Type.String({maxLength:4096}),fileName:Text(255),mimeType:Type.String({minLength:1,maxLength:128,description:'TXT, Markdown, CSV, PDF or Office. All files require external document extraction.'}),idempotencyKey:Type.Optional(Text(128)),sourceResourceId:Type.Optional(Id),parseRunId:Type.Optional(Id)},Strict);
const result=Type.Object({jobId:Id,documentVersionId:Id,status:Type.String(),reused:Type.Boolean()},Strict);
const objectLink=Type.Object({url:Type.String(),expiresAt:Type.String(),mimeType:Type.String(),sizeBytes:Type.Optional(Type.Integer({minimum:0})),contentEncoding:Type.Optional(Type.Literal('gzip'))},Strict);
const detail=Type.Object({jobId:Id,documentVersionId:Id,status:Type.String(),currentStage:Type.String(),taskState:Type.Union([Type.String(),Type.Null()]),mode:Type.Union([Type.Literal('structured_document'),Type.Literal('plain_text')]),fileName:Type.String(),mimeType:Type.String(),sourceSha256:Type.Union([Type.String(),Type.Null()]),sourceSizeBytes:Type.Union([Type.Integer(),Type.Null()]),parserProvider:Type.Union([Type.String(),Type.Null()]),parserVersion:Type.Union([Type.String(),Type.Null()]),canonicalMarkdownUri:Type.Union([Type.String(),Type.Null()]),rawMarkdownUri:Type.Union([Type.String(),Type.Null()]),parentId:Type.Optional(Type.String()),sourceType:Type.Optional(Type.String()),...TocFields,tocError:Type.Optional(Type.Union([Type.String(),Type.Null()])),deletedAt:Type.Optional(Type.Union([Type.String(),Type.Null()])),cleanupStatus:Type.Optional(Type.String()),processingComplete:Type.Optional(Type.Boolean()),error:Type.Union([Type.Object({code:Type.String(),message:Type.Union([Type.String(),Type.Null()]),retryable:Type.Boolean()}),Type.Null()]),createdAt:Type.String(),updatedAt:Type.String()},Strict);
const scope=(req:FastifyRequest)=>{if(!req.authScope)throw new DomainError(401,'UNAUTHORIZED');return req.authScope;};
export function registerRagRoutes(
  app: FastifyInstance, repository: RagIngestionRepository,
  storage: Pick<StoragePort, 'read'|'signUrl'>, queryService?: RagQueryService,
) {
  const guard = async (req: FastifyRequest) => {
    req.authScope = readTrustedScope(req.headers, req.id);
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
    preHandler:readGuard,schema:{params:Type.Object({jobId:Id},Strict),querystring:emptyQuery,response:{200:Envelope(objectLink),...errors}},
  },async(req,reply)=>{reply.header('Cache-Control','no-store');return success(await repository.extraction(scope(req),req.params.jobId,storage),req.id);});
  app.get<{Params:{jobId:string;resourceId:string}}>(`${ingestionPath}/:jobId/assets/:resourceId`,{
    preHandler:readGuard,schema:{params:Type.Object({jobId:Id,resourceId:Id},Strict),querystring:emptyQuery,response:{200:Envelope(objectLink),...errors}},
  },async(req,reply)=>{reply.header('Cache-Control','no-store');return success(await repository.asset(scope(req),req.params.jobId,req.params.resourceId,storage),req.id);});
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
    const { route, handler } = createRagQueryRoute(queryService, guard);
    app.post('/api/v1/rag/query', route, handler);
    app.post('/api/v1/kb/content-assets/query', route, async req => { req.body={...(req.body as object),sourceType:'content_asset'};return handler(req); });
    app.post('/api/v1/kb/documents/query', route, async req => { req.body={...(req.body as object),sourceType:'file'};return handler(req); });
  }
}
