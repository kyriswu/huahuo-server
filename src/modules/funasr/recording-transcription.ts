import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AudioTranscriptionInput, AudioTranscriptionQueue } from '../content-assets/service.js';
import { DomainError, type Scope } from '../identity/store.js';
import { event, funAsrTaskKind, funAsrTaskReference } from '../tasks/model.js';

const admissionErrors = new Set(['RECORDING_TRANSCRIPTION_UNAVAILABLE','BILLING_NOT_CONFIGURED','BILLING_UNCOVERED_CREDIT','INSUFFICIENT_CREDITS']);

/** Record processing admission separately so an unavailable ASR service never loses a claimed recording. */
export async function enqueueRecordingTranscription(tx: pg.PoolClient, scope: Scope, input: AudioTranscriptionInput, queue?: AudioTranscriptionQueue) {
  await tx.query('SAVEPOINT recorder_asr_admission');
  try {
    if (!queue) throw new DomainError(503,'RECORDING_TRANSCRIPTION_UNAVAILABLE');
    await queue.enqueue(tx,scope,input);
    await tx.query('RELEASE SAVEPOINT recorder_asr_admission');
    return 'processing' as const;
  } catch (error) {
    if (!(error instanceof DomainError) || !admissionErrors.has(error.code)) throw error;
    await tx.query('ROLLBACK TO SAVEPOINT recorder_asr_admission');
    await tx.query('RELEASE SAVEPOINT recorder_asr_admission');
    const id = randomUUID(), inputId = randomUUID();
    await tx.query('INSERT INTO task_inputs(id,user_id,body) VALUES($1,$2,$3)',
      [inputId,scope.userId,JSON.stringify({language:input.language ?? 'auto'})]);
    await tx.query(`INSERT INTO tasks(id,user_id,kind,queue,state,trace_id,error_code,retryable,external_reference,input_id)
      VALUES($1,$2,$3,'content','failed',$4,$5,true,$6,$7)`,[id,scope.userId,funAsrTaskKind,scope.traceId,error.code,funAsrTaskReference(id),inputId]);
    await tx.query(`INSERT INTO funasr_jobs(task_id,submission_id,asset_id,resource_id,raw_revision_id,finished_at,error_code)
      VALUES($1,$2,$3,$4,$5,clock_timestamp(),$6)`,[id,randomUUID(),input.assetId,input.resourceId,input.rawRevisionId,error.code]);
    await event(tx,id);
    return 'failed' as const;
  }
}
