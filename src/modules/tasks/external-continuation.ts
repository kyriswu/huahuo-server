import type pg from 'pg';
import type { Attempt } from './execution.js';
import { enqueueIntent, event, type TaskRow } from './model.js';
import { DomainError } from '../../lib/domain-error.js';

/** Caller holds the owned attempt's row lock and has already checked for an early callback. */
export async function deferTaskAttemptTx(tx: pg.PoolClient, task: TaskRow, attempt: Attempt, delayMs: number) {
  const state = task.cancel_requested_at ? 'cancel_requested' : 'waiting_external';
  const updated = await tx.query(`UPDATE tasks SET state=$3, lease_owner=NULL, lease_until=NULL, version=version+1,
    available_at=now()+$2*interval '1 millisecond', error_code=NULL, retryable=false
    WHERE id=$1 AND state='running' AND version=$4 AND attempt_no=$5 AND lease_owner=$6 AND lease_until>clock_timestamp()`,
  [task.id, delayMs, state, attempt.version, attempt.attempt, attempt.owner]);
  if (updated.rowCount !== 1) throw new DomainError(409, 'TASK_STATE_CHANGED');
  await tx.query(`UPDATE task_attempts SET state='waiting_external', finished_at=now()
    WHERE task_id=$1 AND attempt_no=$2`, [task.id, attempt.attempt]);
  await enqueueIntent(tx, task.id, delayMs);
  await event(tx, task.id);
}

/** Caller holds the task lock and has verified the callback belongs to the active submission. */
export async function wakeExternalTaskTx(tx: pg.PoolClient, task: TaskRow): Promise<boolean> {
  const updated = await tx.query(`UPDATE tasks SET available_at=now(),
    state=CASE WHEN state='waiting_external' THEN 'reconciling' ELSE state END
    WHERE id=$1 AND state IN ('waiting_external','reconciling','cancel_requested')
      AND (lease_until IS NULL OR lease_until<clock_timestamp())`, [task.id]);
  if (updated.rowCount !== 1) return false;
  await enqueueIntent(tx, task.id);
  await event(tx, task.id);
  return true;
}
