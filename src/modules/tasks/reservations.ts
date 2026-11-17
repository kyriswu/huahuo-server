import type pg from 'pg';
import { releaseCreditReservationTx } from '../billing/reservations.js';
import type { TaskRow } from './model.js';
import { finalizeTaskTx, type TerminalOutcome } from './lifecycle.js';

/** Existing reservation cleanup adapter; task lifecycle itself has no charging rules. */
export async function finalizeUnsuccessfulTaskTx(
  tx: pg.PoolClient, task: TaskRow, outcome: Exclude<TerminalOutcome, { state: 'succeeded' }>,
) {
  await finalizeTaskTx(tx, task, outcome, async () => {
    if (task.reservation_id) await releaseCreditReservationTx(tx, task.reservation_id,
      { userId: task.user_id, taskId: task.id });
  });
}
