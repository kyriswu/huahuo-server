import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../lib/domain-error.js';

interface CreditReservation extends Record<string, unknown> {
  reservation_id: string;
  user_id: string;
  task_id: string | null;
  requested_credits: string;
  reserved_credits: string;
  status: 'reserved' | 'committed' | 'released' | 'pending' | 'uncovered';
}

type TaskOwner = { userId: string | null; taskId: string };

export async function lockCreditReservationTx(tx: pg.PoolClient, id: string, expectedTask?: TaskOwner) {
  const result = await tx.query<CreditReservation>('SELECT * FROM credit_reservations WHERE reservation_id=$1 FOR UPDATE', [id]);
  const reservation = result.rows[0];
  if (!reservation) throw new DomainError(404, 'RESERVATION_NOT_FOUND');
  if (expectedTask && (reservation.user_id !== expectedTask.userId || reservation.task_id !== expectedTask.taskId)) {
    throw new DomainError(409, 'TASK_RESERVATION_MISMATCH');
  }
  return reservation;
}

/** Release existing funds only; this operation never grants credit or creates an account. */
export async function releaseCreditReservationTx(
  tx: pg.PoolClient,
  id: string,
  expectedTask?: TaskOwner,
) {
  const reservation = await lockCreditReservationTx(tx, id, expectedTask);
  if (reservation.status === 'released') return reservation;
  if (reservation.status !== 'reserved') throw new DomainError(409, 'RESERVATION_NOT_ACTIVE');
  const lots = await tx.query<{ lot_id: string; credits: string }>(
    'SELECT lot_id,credits FROM credit_reservation_lots WHERE reservation_id=$1 ORDER BY lot_id', [id],
  );
  if (lots.rows.reduce((total, lot) => total + BigInt(lot.credits), 0n) !== BigInt(reservation.reserved_credits)) {
    throw new DomainError(409, 'RESERVATION_LOT_CONFLICT');
  }
  for (const lot of lots.rows) {
    const updated = await tx.query(
      'UPDATE credit_lots SET reserved_credits=reserved_credits-$1,available_credits=available_credits+$1 WHERE lot_id=$2 AND user_id=$3 AND reserved_credits>=$1',
      [lot.credits, lot.lot_id, reservation.user_id],
    );
    if (updated.rowCount !== 1) throw new DomainError(409, 'RESERVATION_LOT_CONFLICT');
    await tx.query("INSERT INTO credit_ledger_entries(entry_id,user_id,reservation_id,lot_id,entry_type,credits) VALUES($1,$2,$3,$4,'release',$5)",
      [randomUUID(), reservation.user_id, id, lot.lot_id, lot.credits]);
  }
  await tx.query("UPDATE credit_reservations SET status='released',updated_at=now() WHERE reservation_id=$1", [id]);
  return { ...reservation, status: 'released' };
}
