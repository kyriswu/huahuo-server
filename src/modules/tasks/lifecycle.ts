import type pg from 'pg';
import { DomainError } from '../../lib/domain-error.js';
import { event, terminal, type TaskRow } from './model.js';

export type TerminalOutcome =
  | { state: 'succeeded'; resultId: string }
  | { state: 'failed'; errorCode: string; retryable: boolean }
  | { state: 'cancelled'; errorCode?: string };

/** Recheck the live lease after obtaining the row lock, using database wall time. */
export async function lockOwnedAttemptTx(tx: pg.PoolClient, attempt: {
  task: { id: string }; version: number; attempt: number; owner: string;
}) {
  const result = await tx.query<TaskRow>(`WITH locked AS MATERIALIZED (
    SELECT * FROM tasks WHERE id=$1 FOR UPDATE
  ) SELECT * FROM locked WHERE state='running' AND version=$2 AND attempt_no=$3
    AND lease_owner=$4 AND lease_until>clock_timestamp()`,
  [attempt.task.id, attempt.version, attempt.attempt, attempt.owner]);
  return result.rows[0];
}

/** Caller locks the task row. Optional database effects share the transaction; no billing policy lives here. */
export async function finalizeTaskTx(tx: pg.PoolClient, task: TaskRow, outcome: TerminalOutcome,
  effect?: (tx: pg.PoolClient) => Promise<unknown>) {
  if (terminal(task.state)) throw new DomainError(409, 'TASK_ALREADY_TERMINAL');
  if (outcome.state !== 'succeeded' && task.external_state !== 'none') throw new DomainError(409, 'TASK_EXTERNAL_OUTCOME_UNKNOWN');
  const updated = await tx.query(`UPDATE tasks SET state=$4,version=version+1,lease_owner=NULL,lease_until=NULL,
    available_at=now(),result_id=$5,error_code=$6,retryable=$7,
    cancel_requested_at=CASE WHEN $4='cancelled' THEN coalesce(cancel_requested_at,now()) ELSE cancel_requested_at END
    WHERE id=$1 AND version=$2 AND state=$3`,
  [task.id, task.version, task.state, outcome.state, outcome.state === 'succeeded' ? outcome.resultId : null,
    outcome.state === 'succeeded' ? null : outcome.errorCode ?? null,
    outcome.state === 'failed' && outcome.retryable]);
  if (updated.rowCount !== 1) throw new DomainError(409, 'TASK_STATE_CHANGED');
  if (effect) await effect(tx);
  await event(tx, task.id);
}
