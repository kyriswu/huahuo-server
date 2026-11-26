import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { FunAsrEvent } from '../../integrations/funasr/client.js';
import { resolveTraceId } from '../../lib/trace.js';
import type { BillingService } from '../billing/service.js';
import type { AudioTranscriptionInput, ContentAssetService } from '../content-assets/service.js';
import { DomainError, transaction, type Scope } from '../identity/store.js';
import { wakeExternalTaskTx } from '../tasks/external-continuation.js';
import { enqueueIntent, event, funAsrTaskKind, funAsrTaskReference, hash, newTaskMaxAttempts, terminal, type TaskRow } from '../tasks/model.js';
import { persistAudioTranscript } from './transcript-data.js';

export interface FunAsrJob {
  task_id: string; submission_id: string; asset_id: string; resource_id: string; raw_revision_id: string;
  allocation_id: string | null; base_url: string | null; remote_task_id: string | null;
  deadline_at: Date | null; poll_at: Date | null; upload_attempts: number; poll_attempts: number;
  event_id: string | null; event_hash: string | null; transcript: { text: string } | null;
  error_code: string | null; delivery: 'callback' | 'poll' | null; asset_applied: boolean; finished_at: Date | null;
}

export const assetInput = (job: FunAsrJob): AudioTranscriptionInput => ({
  assetId: job.asset_id, resourceId: job.resource_id, rawRevisionId: job.raw_revision_id,
});

export function transcriptionQueue(credits: number, billing: BillingService) {
  return { async enqueue(tx: pg.PoolClient, scope: Scope, input: AudioTranscriptionInput) {
    const taskId = randomUUID();
    await tx.query(`INSERT INTO tasks(id,user_id,kind,queue,state,trace_id,max_attempts,external_reference)
      VALUES($1,$2,$3,'content','queued',$4,$5,$6)`,
    [taskId, scope.userId, funAsrTaskKind, resolveTraceId(scope.traceId), newTaskMaxAttempts(), funAsrTaskReference(taskId)]);
    await tx.query(`INSERT INTO funasr_jobs(task_id,submission_id,asset_id,resource_id,raw_revision_id) VALUES($1,$2,$3,$4,$5)`,
      [taskId, randomUUID(), input.assetId, input.resourceId, input.rawRevisionId]);
    if (credits > 0) {
      const reservation = await billing.reserveCreditsTx(tx, { userId: scope.userId, taskId,
        reservationKey: `funasr:${taskId}`, requestedCredits: BigInt(credits), ttlMs: 86_400_000 });
      await tx.query('UPDATE tasks SET reservation_id=$2 WHERE id=$1', [taskId, reservation.reservationId]);
    }
    await enqueueIntent(tx, taskId);
    await event(tx, taskId);
  } };
}

export class FunAsrStore {
  constructor(private readonly pool: pg.Pool, readonly assets: ContentAssetService) {}

  async forTask(tx: pg.PoolClient, id: string): Promise<FunAsrJob> {
    const job = (await tx.query<FunAsrJob>(`SELECT task_id,submission_id,asset_id,resource_id,raw_revision_id,
      allocation_id,base_url,remote_task_id,deadline_at,poll_at,upload_attempts,poll_attempts,event_id,event_hash,
      CASE WHEN transcript IS NOT NULL THEN jsonb_build_object('text',transcript->>'text') END AS transcript,
      error_code,delivery,asset_applied,finished_at
      FROM funasr_jobs WHERE task_id=$1 FOR UPDATE`, [id])).rows[0];
    if (!job) throw new Error('FUNASR_JOB_MISSING');
    return job;
  }

  async receive(submissionId: string, receipt: FunAsrEvent) {
    return transaction(this.pool, async tx => {
      const task = (await tx.query<TaskRow>(`SELECT t.* FROM tasks t JOIN funasr_jobs j ON j.task_id=t.id
        WHERE j.submission_id=$1 AND t.kind=$2 FOR UPDATE OF t`, [submissionId, funAsrTaskKind])).rows[0];
      if (!task) throw new DomainError(404, 'FUNASR_CALLBACK_NOT_FOUND');
      const job = await this.forTask(tx, task.id);
      if (await this.record(tx, task, job, receipt, 'callback')) await wakeExternalTaskTx(tx, task);
    });
  }

  async record(tx: pg.PoolClient, task: TaskRow, job: FunAsrJob, receipt: FunAsrEvent, delivery: 'callback' | 'poll') {
    if (!job.base_url || !job.deadline_at || !job.upload_attempts || (job.remote_task_id && job.remote_task_id !== receipt.taskId)) {
      throw new DomainError(409, 'FUNASR_CALLBACK_TASK_CONFLICT');
    }
    // Preserve the normalized receipt hash used by workers before language and speaker metadata were stored.
    const digest = hash(JSON.stringify(receipt.status === 'succeeded' ? {
      ...receipt,
      result: {
        text: receipt.result.text, durationSeconds: receipt.result.durationSeconds,
        processingSeconds: receipt.result.processingSeconds, segments: receipt.result.segments,
      },
    } : receipt));
    if (job.event_id) {
      if (job.event_id !== receipt.eventId || job.event_hash !== digest) throw new DomainError(409, 'FUNASR_CALLBACK_EVENT_CONFLICT');
      return false;
    }
    if (job.finished_at || terminal(task.state)) throw new DomainError(409, 'FUNASR_CALLBACK_TASK_CLOSED');
    const transcript = receipt.status === 'succeeded' && receipt.result.text.trim() ? receipt.result : null;
    const error = receipt.status === 'failed' ? 'FUNASR_TRANSCRIPTION_FAILED' : transcript ? null : 'FUNASR_NO_SPEECH';
    const cancelled = Boolean(task.cancel_requested_at);
    const applied = await this.assets.finishAudioTranscription(tx, { userId: task.user_id!, traceId: task.trace_id },
      { ...assetInput(job), text: cancelled ? null : transcript?.text ?? null });
    const saved = applied && !cancelled ? transcript : null;
    if (saved) await persistAudioTranscript(tx, {
      assetId: job.asset_id, resourceId: job.resource_id, transcriptionId: job.task_id, transcript: saved,
    });
    await tx.query(`UPDATE funasr_jobs SET remote_task_id=$2,event_id=$3,event_hash=$4,delivery=$5,
       transcript=$6,error_code=$7,asset_applied=$8,segment_count=$9,speaker_ids=$10 WHERE task_id=$1`,
    [job.task_id, receipt.taskId, receipt.eventId, digest, delivery,
      saved ? JSON.stringify(saved) : null, error, applied, saved?.segments.length ?? null,
      saved?.speakers.map(speaker => speaker.speakerId) ?? []]);
    return true;
  }
}
