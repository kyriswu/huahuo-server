import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { FunAsrWorkflowConfig } from '../../config/funasr.js';
import { FunAsrError, type FunAsrClient, type FunAsrEvent } from '../../integrations/funasr/client.js';
import type { FunAsrCompute } from '../../integrations/funasr-compute/index.js';
import type { BillingService } from '../billing/service.js';
import { transaction } from '../identity/store.js';
import type { StoragePort } from '../storage/port.js';
import type { Attempt, ExternalTaskExecutor } from '../tasks/execution.js';
import { deferTaskAttemptTx } from '../tasks/external-continuation.js';
import { finalizeTaskTx, lockOwnedAttemptTx } from '../tasks/lifecycle.js';
import { hash } from '../tasks/model.js';
import { finalizeUnsuccessfulTaskTx } from '../tasks/reservations.js';
import { FunAsrAllocations } from './allocations.js';
import { assetInput, type FunAsrJob, type FunAsrStore } from './store.js';

type Settings = Extract<FunAsrWorkflowConfig, { role: 'worker' }>;
interface AudioResource {
  object_key: string; object_version: string; mime_type: string; size_bytes: string; file_name: string;
}
const remaining = (at: Date) => Math.max(0, at.getTime() - Date.now());
const retryMs = (attempts: number) => Math.min(60_000, 3000 * 2 ** Math.min(5, attempts));

export class FunAsrJobs implements ExternalTaskExecutor {
  private readonly allocations: FunAsrAllocations;

  constructor(private readonly pool: pg.Pool, private readonly config: Settings,
    private readonly compute: FunAsrCompute, private readonly client: FunAsrClient,
    private readonly storage: StoragePort, private readonly storageDriver: string, private readonly storageBucket: string | undefined,
    private readonly store: FunAsrStore, private readonly billing: BillingService) {
    this.allocations = new FunAsrAllocations(pool, compute, config.compute.provider, config.idleMs);
  }

  collect(signal?: AbortSignal) { return this.allocations.collect(signal); }

  fail(a: Attempt, code: string, retryable: boolean): Promise<boolean> {
    if (a.signal?.aborted) return Promise.resolve(false);
    const maxAge = this.config.computeWaitMs + this.config.taskTimeoutMs;
    return retryable && Date.now() - a.task.created_at.getTime() < maxAge
      ? this.defer(a, 5000, true)
      : this.finish(a, code);
  }

  async execute(a: Attempt): Promise<boolean> {
    const prepared = await transaction(this.pool, async tx => {
      const task = await lockOwnedAttemptTx(tx, a);
      if (!task) return;
      const job = await this.store.forTask(tx, task.id);
      const eligible = job.base_url || job.event_id ? true : await this.store.assets.isAudioTranscriptionCurrent(tx, task.user_id!, assetInput(job));
      if (!job.base_url && eligible && !task.cancel_requested_at && !job.allocation_id) {
        job.allocation_id = await this.allocations.assign(tx, task.id);
      }
      return { job, eligible, age: Date.now() - task.created_at.getTime(), cancelled: Boolean(task.cancel_requested_at) };
    });
    if (!prepared) return false;
    const { job, eligible, age, cancelled } = prepared;
    if (job.event_id) return this.settle(a, job);
    if (!job.base_url) {
      if (cancelled || !eligible) return this.finish(a, 'FUNASR_ASSET_SUPERSEDED', true);
      if (age >= this.config.computeWaitMs) return this.finish(a, 'FUNASR_COMPUTE_TIMEOUT');
      return this.provision(a, job.allocation_id!);
    }
    const left = remaining(job.deadline_at!);
    if (!left) return this.finish(a, 'FUNASR_TASK_TIMEOUT');
    if (!job.remote_task_id) {
      // A lost 202 is reconciled with the same request key and instance. A cancelled upload can still callback.
      if (cancelled) return this.defer(a, left);
      return this.submit(a, job);
    }
    const wait = remaining(job.poll_at!);
    if (wait) return this.defer(a, Math.min(left, wait));
    return this.poll(a, job, left);
  }

  private async provision(a: Attempt, id: string) {
    let status;
    try {
      await this.compute.start(id, a.signal);
      status = await this.compute.status(id, a.signal);
    } catch (error) {
      if (a.signal?.aborted) return false;
      if (error instanceof Error && error.message === 'FUNASR_COMPUTE_CONFIGURATION_CHANGED') {
        return this.replaceAllocation(a, id);
      }
      return this.defer(a, 5000);
    }
    if (status.state !== 'ready') {
      if (status.state === 'starting') return this.defer(a, 3000);
      return this.replaceAllocation(a, id);
    }
    const { baseUrl } = status;
    // Persist the provider destination before upload. Callbacks can arrive before the HTTP response.
    const job = await transaction(this.pool, async tx => {
      if (!await lockOwnedAttemptTx(tx, a)) return;
      return (await tx.query<FunAsrJob>(`UPDATE funasr_jobs SET base_url=$2, deadline_at=now()+$3*interval '1 millisecond'
        WHERE task_id=$1 RETURNING *`, [a.task.id, baseUrl, this.config.taskTimeoutMs])).rows[0];
    });
    return job ? this.submit(a, job) : false;
  }

  private async replaceAllocation(a: Attempt, id: string) {
    await this.allocations.retire(id);
    return this.defer(a, 5000, false, async tx => {
      await tx.query('UPDATE funasr_jobs SET allocation_id=NULL WHERE task_id=$1 AND base_url IS NULL', [a.task.id]);
    });
  }

  private async submit(a: Attempt, job: FunAsrJob) {
    const prepared = await transaction(this.pool, async tx => {
      const task = await lockOwnedAttemptTx(tx, a);
      if (!task) return;
      const current = await this.store.forTask(tx, task.id);
      if (current.event_id || task.cancel_requested_at) return { state: 'changed' } as const;
      if (!await this.store.assets.isAudioTranscriptionCurrent(tx, task.user_id!, assetInput(current))) {
        return { state: 'superseded' } as const;
      }
      const resource = (await tx.query<AudioResource>(`SELECT object_key,object_version,mime_type,size_bytes,file_name FROM resources
        WHERE resource_id=$1 AND user_id=$2 AND status='ready' AND storage_driver=$3
          AND storage_bucket IS NOT DISTINCT FROM $4`, [current.resource_id, task.user_id, this.storageDriver, this.storageBucket ?? null])).rows[0];
      if (!resource) return { state: 'unavailable' } as const;
      await tx.query('UPDATE funasr_jobs SET upload_attempts=upload_attempts+1 WHERE task_id=$1', [task.id]);
      await tx.query("UPDATE tasks SET external_state='unknown' WHERE id=$1", [task.id]);
      return { state: 'send', resource } as const;
    });
    if (!prepared) return false;
    if (prepared.state === 'changed') return this.defer(a, 0);
    if (prepared.state === 'superseded') return this.finish(a, 'FUNASR_ASSET_SUPERSEDED', true);
    if (prepared.state === 'unavailable') return this.finish(a, 'FUNASR_RESOURCE_UNAVAILABLE');
    const { resource } = prepared;
    let response;
    try {
      const body = await this.storage.read(resource.object_key, undefined, resource.object_version);
      response = await this.client.submit(job.base_url!, {
        body, filename: resource.file_name, mimeType: resource.mime_type, sizeBytes: Number(resource.size_bytes),
        callbackUrl: new URL(`/internal/v1/funasr/callbacks/${job.submission_id}`, this.config.callbackOrigin).href,
        idempotencyKey: job.submission_id,
      }, a.signal);
    } catch (error) {
      if (a.signal?.aborted) return false;
      if (error instanceof FunAsrError && !error.retryable) return this.finish(a, error.code);
      if (!(error instanceof FunAsrError && error.status === 429) && job.upload_attempts >= 3) {
        return this.defer(a, remaining(job.deadline_at!));
      }
      return this.defer(a, retryMs(job.upload_attempts));
    }
    return this.defer(a, this.config.callbackWaitMs, false, async (tx, current) => {
      if (current.remote_task_id && current.remote_task_id !== response.taskId) throw new Error('FUNASR_SUBMISSION_RECEIPT_CONFLICT');
      await tx.query(`UPDATE funasr_jobs SET remote_task_id=$2,poll_at=now()+$3*interval '1 millisecond' WHERE task_id=$1`,
        [a.task.id, response.taskId, this.config.callbackWaitMs]);
      await tx.query("UPDATE tasks SET external_state='submitted' WHERE id=$1", [a.task.id]);
    });
  }

  private async poll(a: Attempt, job: FunAsrJob, left: number) {
    let result;
    try { result = await this.client.result(job.base_url!, job.remote_task_id!, a.signal); }
    catch (error) {
      if (a.signal?.aborted) return false;
      if (error instanceof FunAsrError && !error.retryable) return this.finish(a, error.code);
      return this.deferPoll(a, job, left);
    }
    if (result.state === 'pending') return this.deferPoll(a, job, left);
    if (result.state !== 'event') return this.finish(a, result.state === 'missing' ? 'FUNASR_REMOTE_TASK_LOST' : 'FUNASR_RESULT_CONSUMED');
    const receipt: FunAsrEvent = result.event;
    const saved = await transaction(this.pool, async tx => {
      const task = await lockOwnedAttemptTx(tx, a);
      if (!task) return;
      const current = await this.store.forTask(tx, task.id);
      await this.store.record(tx, task, current, receipt, 'poll');
      return this.store.forTask(tx, task.id);
    });
    return saved ? this.settle(a, saved) : false;
  }

  private deferPoll(a: Attempt, job: FunAsrJob, left: number) {
    const delay = Math.min(left, retryMs(job.poll_attempts));
    return this.defer(a, delay, false, async tx => {
      await tx.query(`UPDATE funasr_jobs SET poll_attempts=poll_attempts+1,poll_at=now()+$2*interval '1 millisecond'
        WHERE task_id=$1`, [a.task.id, delay]);
    });
  }

  private async settle(a: Attempt, job: FunAsrJob) {
    // HTTP pull never consumes on read. ACK only after the transaction saving the event and asset has committed.
    if (job.delivery === 'poll' && remaining(job.deadline_at!) > 0) {
      try { await this.client.ack(job.base_url!, job.remote_task_id!, job.event_id!, a.signal); }
      catch (error) {
        if (a.signal?.aborted) return false;
        if (!(error instanceof FunAsrError) || error.retryable) {
          return this.defer(a, Math.min(remaining(job.deadline_at!), retryMs(job.poll_attempts)), true, async tx => {
            await tx.query('UPDATE funasr_jobs SET poll_attempts=poll_attempts+1 WHERE task_id=$1', [a.task.id]);
          });
        }
      }
    }
    return this.finish(a);
  }

  private async defer(a: Attempt, delay: number, ignoreReceipt = false,
    update?: (tx: pg.PoolClient, job: FunAsrJob) => Promise<void>): Promise<boolean> {
    const deferred = await transaction(this.pool, async tx => {
      const task = await lockOwnedAttemptTx(tx, a);
      if (!task) return false;
      const job = await this.store.forTask(tx, task.id);
      if (update) await update(tx, job);
      await deferTaskAttemptTx(tx, task, a, !ignoreReceipt && job.event_id ? 0 : delay);
      return true;
    });
    a.stepOutcome = deferred ? 'deferred' : 'stale';
    return false;
  }

  private async finish(a: Attempt, failure?: string, superseded = false) {
    const finished = await transaction(this.pool, async tx => {
      const task = await lockOwnedAttemptTx(tx, a);
      if (!task) return false;
      const job = await this.store.forTask(tx, task.id);
      if (!job.event_id) {
        await this.store.assets.finishAudioTranscription(tx, { userId: task.user_id!, traceId: task.trace_id },
          { ...assetInput(job), text: null });
      }
      await tx.query("UPDATE tasks SET external_state='none' WHERE id=$1", [task.id]);
      const success = Boolean(job.transcript);
      const cancelled = !success && (superseded || Boolean(task.cancel_requested_at) || Boolean(job.event_id && !job.asset_applied));
      const errorCode = success || cancelled ? null : job.error_code ?? failure ?? 'FUNASR_RESULT_MISSING';
      await tx.query('UPDATE funasr_jobs SET finished_at=now(),error_code=$2 WHERE task_id=$1', [task.id, errorCode]);
      await tx.query('UPDATE task_attempts SET state=$3,error_code=$4,finished_at=now() WHERE task_id=$1 AND attempt_no=$2',
        [task.id, a.attempt, success ? 'succeeded' : cancelled ? 'cancelled' : 'failed', errorCode]);
      if (success) {
        const text = job.transcript!.text;
        const resultId = randomUUID();
        await tx.query('INSERT INTO task_results(id,task_id,attempt_no,digest,byte_count) VALUES($1,$2,$3,$4,$5)',
          [resultId, task.id, a.attempt, hash(text), Buffer.byteLength(text)]);
        await finalizeTaskTx(tx, task, { state: 'succeeded', resultId }, async () => {
          if (task.reservation_id) await this.billing.commitReservationTx(tx, task.reservation_id);
        });
      } else await finalizeUnsuccessfulTaskTx(tx, { ...task, external_state: 'none' }, cancelled
        ? { state: 'cancelled' } : { state: 'failed', errorCode: errorCode!, retryable: false });
      return true;
    });
    a.stepOutcome = finished ? 'recorded' : 'stale';
    return finished;
  }
}
