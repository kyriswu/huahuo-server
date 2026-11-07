import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { DocumentSectionSchema, SectionIdSchema, TocFields, TocStatusSchema } from '../../contracts/document-sections.js';
import { ErrorSchema, success } from '../../contracts/envelope.js';
import { DomainError } from '../identity/store.js';
import type { IdentityService } from '../identity/service.js';
import { idempotencyKey } from '../identity/routes.js';
import { Envelope, Id, Strict, Text } from '../identity/schemas.js';
import { DocumentIngestionService, type DocumentIngestionInput } from './service.js';

const errors = { 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 413: ErrorSchema, 503: ErrorSchema };
const ingestionPath = '/api/v1/workspaces/:workspaceId/notes/:noteId/document-ingestion';
const workspaceNoteFields = { workspaceId: Id, noteId: Id };
const workspaceNote = Type.Object(workspaceNoteFields, Strict);
const jobParams = { ...workspaceNoteFields, jobId: Id };
const emptyQuery = Type.Object({}, Strict);
const body = Type.Object({
  content: Type.Optional(Type.String({ maxLength: 500_000 })),
  contentBase64: Type.Optional(Type.String({ maxLength: 700_000 })),
  fileName: Type.Optional(Text(255)),
  mimeType: Type.Optional(Text(128)),
  pipelineVersion: Type.Optional(Text(64)),
  maxTokens: Type.Optional(Type.Integer({ minimum: 16, maximum: 4096 })),
  overlapTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: 4095 })),
}, Strict);
const job = Type.Object({
  idempotencyKey: Type.String(),
  documentId: Id,
  documentVersion: Type.String(),
  contentHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  pipelineVersion: Type.String(),
  parserVersion: Type.String(),
  chunkerVersion: Type.String(),
  status: Type.Union([Type.Literal('processing'), Type.Literal('ready'), Type.Literal('failed')]),
  chunkCount: Type.Integer({ minimum: 0 }),
  reused: Type.Boolean(),
  jobId: Type.Union([Id, Type.Null()]),
}, Strict);
const listedJobFields = {
  idempotencyKey: Type.String(),
  workspaceId: Id,
  documentId: Id,
  documentVersion: Type.String(),
  contentHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  pipelineVersion: Type.String(),
  parserVersion: Type.String(),
  chunkerVersion: Type.String(),
  sourceType: Type.Literal('note'),
  status: Type.Union([Type.Literal('processing'), Type.Literal('ready'), Type.Literal('failed')]),
  chunkCount: Type.Integer({ minimum: 0 }),
  jobId: Type.Union([Id, Type.Null()]),
  tocStatus: TocStatusSchema,
  createdAt: Type.String(),
  updatedAt: Type.String(),
};
const listedJob = Type.Object(listedJobFields, Strict);
const jobDetail = Type.Object({ ...listedJobFields, ...TocFields }, Strict);

function scope(req: FastifyRequest) {
  if (!req.authScope) throw new DomainError(401, 'UNAUTHORIZED');
  return req.authScope;
}

export function registerIngestionRoutes(app: FastifyInstance, identity: IdentityService, ingestion: DocumentIngestionService): void {
  const guard = async (req: FastifyRequest) => {
    idempotencyKey(req, req.method === 'GET' ? 'forbidden' : 'required');
    req.authScope = await identity.authenticate(req.headers.authorization, req.id);
  };
  app.post(ingestionPath, {
    preHandler: guard,
    schema: { params: workspaceNote, body, querystring: Type.Object({}, Strict), response: { 200: Envelope(job), ...errors } },
  }, async (req) => {
    const p = req.params as { workspaceId: string; noteId: string };
    return success(await ingestion.ingestNote(scope(req), p.workspaceId, p.noteId, req.body as DocumentIngestionInput, idempotencyKey(req, 'required')!), req.id);
  });
  app.get(ingestionPath, {
    preHandler: guard,
    schema: { params: workspaceNote, querystring: Type.Object({}, Strict), response: { 200: Envelope(Type.Object({ items: Type.Array(listedJob) }, Strict)), ...errors } },
  }, async (req) => {
    const p = req.params as { workspaceId: string; noteId: string };
    return success(await ingestion.listNoteJobs(scope(req), p.workspaceId, p.noteId), req.id);
  });
  app.get<{ Params: { workspaceId: string; noteId: string; jobId: string } }>(`${ingestionPath}/:jobId`, {
    preHandler: guard,
    schema: { params: Type.Object(jobParams, Strict), querystring: emptyQuery, response: { 200: Envelope(jobDetail), ...errors } },
  }, async req => {
    const { workspaceId, noteId, jobId } = req.params;
    return success(await ingestion.noteJob(scope(req), workspaceId, noteId, jobId), req.id);
  });
  app.get<{ Params: { workspaceId: string; noteId: string; jobId: string; sectionId: string } }>(`${ingestionPath}/:jobId/sections/:sectionId`, {
    preHandler: guard,
    schema: { params: Type.Object({ ...jobParams, sectionId: SectionIdSchema }, Strict), querystring: emptyQuery, response: { 200: Envelope(DocumentSectionSchema), ...errors } },
  }, async req => {
    const { workspaceId, noteId, jobId, sectionId } = req.params;
    return success(await ingestion.noteSection(scope(req), workspaceId, noteId, jobId, sectionId), req.id);
  });
}
