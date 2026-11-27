import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { success, ErrorSchema } from '../../contracts/envelope.js';
import { RecordingProcessingSchema } from '../funasr/recording-status.js';
import { idempotencyKey } from '../identity/routes.js';
import { readTrustedScope } from '../identity/trusted-scope.js';
import { Id, Envelope, Strict, Text } from '../identity/schemas.js';
import type { ContentAssetService } from '../content-assets/service.js';

const path = '/api/v1/recorder-bindings/:bindingId/recordings';
const recordingKey = Text(256);
const params = Type.Object({bindingId: Id}, Strict);
const statusFields = {
  recordingKey,
  status: Type.Union([Type.Literal('not_synced'), Type.Literal('synced'), Type.Literal('deleted')]),
  contentAssetId: Type.Union([Id, Type.Null()]), resourceId: Type.Union([Id, Type.Null()]),
};
const errors = {400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 410: ErrorSchema, 503: ErrorSchema};
const empty = Type.Object({}, Strict);

export function registerRecorderSyncRoutes(app: FastifyInstance, assets: ContentAssetService) {
  app.post<{Params: {bindingId: string}; Body: {recordingKeys: string[]}}>(path + '/sync-status', {
    schema: {params, querystring: empty, body: Type.Object({
      recordingKeys: Type.Array(recordingKey, {minItems: 1, maxItems: 100, uniqueItems: true}),
    }, Strict), response: {200: Envelope(Type.Object({items: Type.Array(Type.Object(statusFields, Strict))})), ...errors}},
  }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const scope = readTrustedScope(req.headers, req.id);
    idempotencyKey(req, 'forbidden');
    return success(await assets.checkRecordings(scope, req.params.bindingId, req.body.recordingKeys), req.id);
  });
  app.post<{Params: {bindingId: string}; Body: {uploadId: string; recordingKey: string; title?: string}}>(path, {
    schema: {params, querystring: empty, body: Type.Object({uploadId: Id, recordingKey, title: Type.Optional(Text(240))}, Strict),
      response: {200: Envelope(Type.Object({...statusFields, processing: Type.Optional(RecordingProcessingSchema)}, Strict)), ...errors}},
  }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const scope = readTrustedScope(req.headers, req.id);
    return success(await assets.archiveRecording(scope, req.params.bindingId, req.body, idempotencyKey(req, 'required')!), req.id);
  });
}
