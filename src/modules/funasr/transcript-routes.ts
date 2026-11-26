import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ContentStatusSchema } from '../../contracts/content-status.js';
import { ErrorSchema, success } from '../../contracts/envelope.js';
import { idempotencyKey } from '../identity/routes.js';
import { Envelope, Id, Strict } from '../identity/schemas.js';
import { readTrustedScope } from '../identity/trusted-scope.js';
import type { FunAsrTranscripts } from './transcript.js';

const base = '/api/v1/content-assets/:contentAssetId/transcription';
const asset = Type.Object({ contentAssetId: Id }, Strict);
const segmentId = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9][0-9]{0,9})$' });
const ordinal = Type.Integer({ minimum: 0, maximum: 2_147_483_647 });
const contentRevision = Type.String({ pattern: '^[0-9]+$' });
const transcript = Type.Object({
  contentAssetId: Id, title: Type.String(), sourceKind: Type.String(), createdAt: Type.String({ format: 'date-time' }),
  contentStatus: ContentStatusSchema, resourceId: Type.Union([Id, Type.Null()]), transcriptionId: Type.Union([Id, Type.Null()]),
  durationMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]), language: Type.Union([Type.String(), Type.Null()]),
  text: Type.Union([Type.String(), Type.Null()]), contentRevision: Type.Union([contentRevision, Type.Null()]),
}, Strict);
const errors = { 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema };
const noQuery = Type.Object({}, Strict);
const scope = (request: FastifyRequest) => readTrustedScope(request.headers, request.id);

export function registerFunAsrTranscripts(app: FastifyInstance, transcripts: FunAsrTranscripts) {
  app.get<{ Params: { contentAssetId: string } }>(base, {
    schema: { params: asset, querystring: noQuery, response: { 200: Envelope(transcript), ...errors } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    idempotencyKey(request, 'forbidden');
    return success(await transcripts.read(scope(request), request.params.contentAssetId), request.id);
  });

  app.get<{ Params: { contentAssetId: string } }>(`${base}/text`, {
    schema: { params: asset, querystring: noQuery, response: {
      200: Envelope(Type.Object({ transcriptionId: Id, contentRevision, text: Type.String() }, Strict)), ...errors,
    } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    idempotencyKey(request, 'forbidden');
    return success(await transcripts.fullText(scope(request), request.params.contentAssetId), request.id);
  });

  app.patch<{ Params: { contentAssetId: string; segmentId: string }; Body: { text: string; revision: number } }>(`${base}/segments/:segmentId`, {
    schema: { params: Type.Object({ contentAssetId: Id, segmentId }, Strict), querystring: noQuery,
      body: Type.Object({ text: Type.String({ maxLength: 20_000 }), revision: Type.Integer({ minimum: 0, maximum: 2_147_483_646 }) }, Strict),
      response: { 200: Envelope(Type.Object({ segmentId, text: Type.String(), revision: ordinal }, Strict)), ...errors },
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { contentAssetId, segmentId: id } = request.params;
    const owner = scope(request);
    return success(await transcripts.edit(owner, contentAssetId, id, request.body, idempotencyKey(request, 'required')!), request.id);
  });
}
