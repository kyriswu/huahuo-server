import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type pg from 'pg';
import { success, ErrorSchema } from '../../contracts/envelope.js';
import { idempotent } from '../../lib/idempotency.js';
import { originalAudioResource, type AudioTranscriptionQueue } from '../content-assets/service.js';
import { assertScope, DomainError, transaction, type Scope } from '../identity/store.js';
import { idempotencyKey } from '../identity/routes.js';
import { enqueueIntent, event } from '../tasks/model.js';
import { readTrustedScope } from '../identity/trusted-scope.js';
import { Envelope, Id, Strict } from '../identity/schemas.js';
import { enqueueRecordingOutline } from './recording-outline.js';
import { RecordingProcessingSchema, readRecordingProcessing, type RecordingAction } from './recording-status.js';
export { readRecordingProcessing, readRecordingProcessingBatch } from './recording-status.js';

export class RecordingProcessing {
  constructor(private readonly pool: pg.Pool, private readonly secret: string, private readonly asr?: AudioTranscriptionQueue) {}

  async submit(scope: Scope, id: string, action: RecordingAction, key: string) {
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      const asset = (await tx.query(`SELECT a.content_asset_id FROM content_assets a
        WHERE a.content_asset_id=$1 AND a.user_id=$2 AND a.source_kind='recorder_card' AND a.asset_kind='audio'
        AND a.state='active' FOR UPDATE`, [id,scope.userId])).rows[0];
      if (!asset) throw new DomainError(404, 'CONTENT_ASSET_NOT_FOUND');
      return idempotent(tx, this.secret, scope.userId, 'recorder.processing', key, { id, action }, async () => {
        const before = await readRecordingProcessing(tx, scope.userId, id);
        if (!before) throw new DomainError(409, 'RECORDING_INPUT_MISSING');
        if (before.stage === 'transcribing' || before.stage === 'outlining' || before.stage === 'completed') return before;
        if (!before.allowedActions.includes(action)) throw new DomainError(409, 'RECORDING_ACTION_NOT_ALLOWED');
        const raw = (await tx.query<{ revision: string; has_text: boolean }>(
          "SELECT part_revision_id AS revision,trim(content_markdown)<>'' AS has_text FROM content_asset_parts WHERE content_asset_id=$1 AND part='raw'", [id])).rows[0]!;
        if (raw.has_text) {
          if (before.stage === 'failed' && before.taskId) {
            // Reuse the same task/run UUID and the same remote idempotency key even when the previous response was lost.
            const reset = await tx.query(`UPDATE tasks SET state='queued',version=version+1,resume_count=attempt_no,
              error_code=NULL,retryable=false,cancel_requested_at=NULL,available_at=clock_timestamp()
              WHERE id=$1 AND user_id=$2 AND state IN ('failed','cancelled')`,[before.taskId,scope.userId]);
            if (reset.rowCount !== 1) throw new DomainError(409,'TASK_STATE_CHANGED');
            await enqueueIntent(tx,before.taskId);
            await event(tx,before.taskId);
          } else await enqueueRecordingOutline(tx, scope.userId, scope.traceId, id, raw.revision);
        } else {
          if (!this.asr) throw new DomainError(503, 'RECORDING_TRANSCRIPTION_UNAVAILABLE');
          const resourceId = await originalAudioResource(tx,scope.userId,id);
          if (!resourceId) throw new DomainError(409, 'RECORDING_INPUT_MISSING');
          // Runtime recovery may close a task without reaching its ASR handler.
          if (before.taskId) {
            await tx.query(`UPDATE funasr_jobs j SET finished_at=clock_timestamp(),error_code=coalesce(j.error_code,t.error_code)
              FROM tasks t WHERE t.id=j.task_id AND t.id=$1 AND t.user_id=$2 AND j.asset_id=$3 AND j.raw_revision_id=$4
              AND t.state IN ('failed','cancelled') AND j.finished_at IS NULL
              AND (j.upload_attempts=0 OR j.event_id IS NOT NULL)`,[before.taskId,scope.userId,id,raw.revision]);
          }
          await tx.query("UPDATE content_assets SET processing_status='processing' WHERE content_asset_id=$1", [id]);
          const previous = before.taskId ? (await tx.query<{ body: string }>(`SELECT i.body FROM tasks t
            JOIN task_inputs i ON i.id=t.input_id AND i.user_id=t.user_id WHERE t.id=$1 AND t.user_id=$2`,
            [before.taskId,scope.userId])).rows[0] : undefined;
          const language = previous ? (JSON.parse(previous.body) as { language: string }).language : 'auto';
          if (language !== 'auto') throw new DomainError(409,'RECORDING_LANGUAGE_UNSUPPORTED');
          await this.asr.enqueue(tx,scope,{ assetId:id,resourceId,rawRevisionId:raw.revision,language });
        }
        return (await readRecordingProcessing(tx, scope.userId, id))!;
      });
    });
  }
}

export function registerRecordingProcessing(app: FastifyInstance, processing: RecordingProcessing) {
  const action = Type.Union([Type.Literal('start'),Type.Literal('retry')]);
  app.post<{ Params: { contentAssetId: string }; Body: { action: RecordingAction } }>(
    '/api/v1/content-assets/:contentAssetId/processing-runs', {
      schema: { params: Type.Object({contentAssetId: Id}, Strict), querystring: Type.Object({},Strict),
        body: Type.Object({action},Strict),
        response: {200: Envelope(RecordingProcessingSchema),
          400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 429: ErrorSchema, 503: ErrorSchema } },
    }, async (req,reply) => {
      reply.header('Cache-Control','no-store');
      return success(await processing.submit(readTrustedScope(req.headers, req.id), req.params.contentAssetId,
        req.body.action,idempotencyKey(req,'required')!),req.id);
    });
}
