import type pg from 'pg';
import { Type } from '@sinclair/typebox';
import { Id, Strict } from '../identity/schemas.js';
import { terminal, type TaskState } from '../tasks/model.js';

export const recordingOutlineKind = 'content-asset.recording-outline';
export const outlineReference = (assetId: string, revision: string) => 'recording-outline:' + assetId + ':' + revision;
export type RecordingAction = 'start' | 'retry';
type Phase = 'pending' | 'transcribing' | 'outlining' | 'completed' | 'failed';
export interface RecordingProcessingStatus {
  stage: Phase;
  failedStage: 'transcription' | 'outline' | null;
  errorCode: string | null;
  allowedActions: RecordingAction[];
  taskId: string | null;
  outlineRunId: string | null;
}

const nullableId = Type.Union([Id,Type.Null()]);
export const RecordingProcessingSchema = Type.Object({
  stage: Type.Union([Type.Literal('pending'),Type.Literal('transcribing'),Type.Literal('outlining'),Type.Literal('completed'),Type.Literal('failed')]),
  failedStage: Type.Union([Type.Null(),Type.Literal('transcription'),Type.Literal('outline')]),
  errorCode: Type.Union([Type.Null(),Type.String()]),
  allowedActions: Type.Array(Type.Union([Type.Literal('start'),Type.Literal('retry')])),
  taskId: nullableId,outlineRunId: nullableId,
},Strict);

interface Row {
  id: string; has_text: boolean; asr_unknown: boolean;
  asr_state: TaskState | null; asr_task: string | null; asr_error: string | null;
  outline_state: TaskState | null; outline_task: string | null; outline_error: string | null; run_id: string | null;
}

function status(row: Row): RecordingProcessingStatus {
  const result: RecordingProcessingStatus = {
    stage: 'pending', failedStage: null, errorCode: null, allowedActions: ['start'], taskId: null, outlineRunId: null,
  };
  const outline = row.has_text;
  const state = outline ? row.outline_state : row.asr_state;
  if (!state) return result;
  result.taskId = outline ? row.outline_task : row.asr_task;
  result.allowedActions = [];
  if (outline && row.run_id) {
    result.stage = 'completed';
    result.outlineRunId = row.run_id;
  } else if (terminal(state)) {
    result.stage = 'failed';
    result.failedStage = outline ? 'outline' : 'transcription';
    result.errorCode = (outline ? row.outline_error : row.asr_error) ?? 'RECORDING_PROCESSING_FAILED';
    // Finishing a local task does not prove a submitted remote job failed.
    if (outline || !row.asr_unknown) {
      result.allowedActions = ['retry'];
    }
  } else result.stage = outline ? 'outlining' : 'transcribing';
  return result;
}

export async function readRecordingProcessingBatch(tx: pg.PoolClient, userId: string, ids: readonly string[]) {
  const result = new Map<string, RecordingProcessingStatus>();
  if (!ids.length) return result;
  const { rows } = await tx.query<Row>(`SELECT a.content_asset_id AS id, asr.unknown AS asr_unknown,
      trim(p.content_markdown) <> '' AS has_text, asr.id AS asr_task, asr.state AS asr_state, asr.error_code AS asr_error,
      outline.id AS outline_task, outline.state AS outline_state, outline.error_code AS outline_error,
      run.id AS run_id
    FROM content_assets a JOIN content_asset_parts p ON p.content_asset_id=a.content_asset_id AND p.part='raw'
    LEFT JOIN LATERAL (SELECT t.id,t.state,t.error_code,
        (j.upload_attempts>0 AND j.event_id IS NULL AND NOT (
          j.finished_at IS NOT NULL AND j.remote_task_id IS NULL AND
          coalesce(j.error_code,'') IN ('FUNASR_PROVIDER_HTTP_ERROR','FUNASR_UPLOAD_INVALID')
        )) AS unknown FROM funasr_jobs j JOIN tasks t ON t.id=j.task_id
      WHERE j.asset_id=a.content_asset_id AND j.raw_revision_id=p.part_revision_id AND t.user_id=a.user_id
      ORDER BY t.created_at DESC,t.id DESC LIMIT 1) asr ON true
    LEFT JOIN LATERAL (SELECT t.* FROM tasks t WHERE t.user_id=a.user_id AND t.kind='content-asset.recording-outline'
      AND t.external_reference='recording-outline:'||a.content_asset_id::text||':'||p.part_revision_id::text
      ORDER BY t.created_at DESC,t.id DESC LIMIT 1) outline ON true
    LEFT JOIN ai_template_runs run ON run.id=outline.id AND run.user_id=a.user_id AND run.state='succeeded'
    WHERE a.content_asset_id=ANY($1::uuid[]) AND a.user_id=$2 AND a.asset_kind='audio'
      AND a.source_kind='recorder_card' AND a.state='active'`, [ids,userId]);
  for (const row of rows) result.set(row.id, status(row));
  return result;
}

export async function readRecordingProcessing(tx: pg.PoolClient, userId: string, assetId: string) {
  return (await readRecordingProcessingBatch(tx, userId, [assetId])).get(assetId);
}
