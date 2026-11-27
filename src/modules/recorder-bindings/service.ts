import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { idempotent } from '../../lib/idempotency.js';
import { assertScope, DomainError, lock, transaction, type Scope } from '../identity/store.js';

export type RecorderMode = 'auto' | 'manual';
export interface RecorderBinding {
  bindingId: string;
  deviceId: string;
  modelCode: string;
  displayName: string | null;
  transferMode: RecorderMode;
  generationMode: RecorderMode;
  transcriptionLanguage: string;
  boundAt: string;
  updatedAt: string;
}

export interface RecorderBindingVerifier {
  /** Verify a fresh proof for this account and SN; the model comes from the verified device. */
  verify(input: {userId: string; deviceId: string; proof: string}): Promise<{deviceId: string; modelCode: string} | null>;
}

export interface BindRecorderInput {
  deviceId: string;
  transferMode?: RecorderMode;
  proof?: string;
}

export interface UpdateRecorderInput {
  displayName?: string;
  transferMode?: RecorderMode;
  generationMode?: RecorderMode;
  transcriptionLanguage?: 'auto';
}

type BindingRow = Omit<RecorderBinding, 'boundAt' | 'updatedAt'> & { boundAt: Date; updatedAt: Date };
const columns = `binding_id AS "bindingId", device_id AS "deviceId", model_code AS "modelCode",
  display_name AS "displayName", transfer_mode AS "transferMode", generation_mode AS "generationMode",
  transcription_language AS "transcriptionLanguage", bound_at AS "boundAt", updated_at AS "updatedAt"`;

function view(row: BindingRow): RecorderBinding {
  return { ...row, boundAt: row.boundAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function checkDeviceId(deviceId: string) {
  if (!deviceId || deviceId.trim() !== deviceId || Buffer.byteLength(deviceId) > 128
      || Buffer.from(deviceId).toString('utf8') !== deviceId || /\p{Cc}/u.test(deviceId)) {
    throw new DomainError(400, 'RECORDER_DEVICE_ID_INVALID');
  }
}

/** A shared row lock makes a cloud write and a concurrent unbind observe a single binding lifetime. */
export async function requireActiveRecorderBinding(tx: pg.PoolClient, userId: string, bindingId: string, lockForWrite = false) {
  const { rows: [row] } = await tx.query<BindingRow>(`SELECT ${columns} FROM recorder_bindings
    WHERE user_id=$1 AND binding_id=$2 AND unbound_at IS NULL ${lockForWrite ? 'FOR SHARE' : ''}`, [userId, bindingId]);
  if (!row) throw new DomainError(404, 'RECORDER_BINDING_NOT_FOUND');
  return view(row);
}

async function currentOwner(tx: pg.PoolClient, deviceId: string) {
  const { rows: [row] } = await tx.query<{user_id: string; binding_id: string}>(`SELECT user_id, binding_id FROM recorder_bindings
    WHERE device_id=$1 AND unbound_at IS NULL`, [deviceId]);
  return row;
}

export class RecorderBindingService {
  constructor(private readonly pool: pg.Pool, private readonly secret: string, private readonly verifier?: RecorderBindingVerifier) {}

  async list(scope: Scope, deviceId?: string) {
    if (deviceId !== undefined) checkDeviceId(deviceId);
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      const args = deviceId === undefined ? [scope.userId] : [scope.userId, deviceId];
      const { rows } = await tx.query<BindingRow>(`SELECT ${columns} FROM recorder_bindings
        WHERE user_id=$1 AND unbound_at IS NULL ${deviceId === undefined ? '' : 'AND device_id=$2'}
        ORDER BY bound_at DESC, binding_id`, args);
      return { items: rows.map(view) };
    });
  }

  async detail(scope: Scope, bindingId: string) {
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      return requireActiveRecorderBinding(tx, scope.userId, bindingId);
    });
  }

  async bind(scope: Scope, input: BindRecorderInput, key: string): Promise<RecorderBinding> {
    const { deviceId, transferMode } = input;
    checkDeviceId(deviceId);
    const initial = await transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      return currentOwner(tx, deviceId);
    });
    if (initial && initial.user_id !== scope.userId) throw new DomainError(409, 'RECORDER_ALREADY_BOUND');
    if (!initial && !transferMode) throw new DomainError(400, 'RECORDER_TRANSFER_MODE_REQUIRED');
    const verified = initial ? undefined : await this.verifyFirstBinding(scope.userId, deviceId, input.proof);
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      await lock(tx, 'recorder-bind:' + deviceId);
      const response = await idempotent(tx, this.secret, scope.userId, 'recorder.bind', key, { deviceId, transferMode }, async () => {
        const owner = await currentOwner(tx, deviceId);
        if (owner) {
          if (owner.user_id !== scope.userId) throw new DomainError(409, 'RECORDER_ALREADY_BOUND');
          return requireActiveRecorderBinding(tx, scope.userId, owner.binding_id, true);
        }
        if (!verified) throw new DomainError(409, 'RECORDER_BINDING_CHANGED');
        const { rows } = await tx.query<BindingRow>(`INSERT INTO recorder_bindings
          (binding_id,user_id,device_id,model_code,transfer_mode,generation_mode,transcription_language)
          VALUES($1,$2,$3,$4,$5,'auto','auto') RETURNING ${columns}`,
        [randomUUID(), scope.userId, deviceId, verified.modelCode, transferMode]);
        return view(rows[0]!);
      });
      // A request replay must never advertise a historical binding as active.
      return requireActiveRecorderBinding(tx, scope.userId, response.bindingId, true);
    });
  }

  private async verifyFirstBinding(userId: string, deviceId: string, proof?: string) {
    if (!this.verifier) throw new DomainError(503, 'RECORDER_VERIFIER_UNAVAILABLE');
    if (!proof?.trim()) throw new DomainError(403, 'RECORDER_PROOF_REQUIRED');
    const verified = await this.verifier.verify({ userId, deviceId, proof }).catch(error => {
      if (error instanceof DomainError) throw error;
      throw new DomainError(503, 'RECORDER_VERIFIER_UNAVAILABLE');
    });
    if (!verified || verified.deviceId !== deviceId || !verified.modelCode.trim()
        || Buffer.byteLength(verified.modelCode) > 128 || /\p{Cc}/u.test(verified.modelCode)) {
      throw new DomainError(403, 'RECORDER_PROOF_INVALID');
    }
    return verified;
  }

  async update(scope: Scope, bindingId: string, patch: UpdateRecorderInput, key: string) {
    if (patch.displayName !== undefined && /\p{Cc}/u.test(patch.displayName)) throw new DomainError(400, 'RECORDER_DISPLAY_NAME_INVALID');
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      const response = await idempotent(tx, this.secret, scope.userId, 'recorder.update', key, { bindingId, patch }, async () => {
        const { rows: [row] } = await tx.query<BindingRow>(`UPDATE recorder_bindings SET
          display_name=COALESCE($3,display_name), transfer_mode=COALESCE($4,transfer_mode),
          generation_mode=COALESCE($5,generation_mode), transcription_language=COALESCE($6,transcription_language),
          updated_at=clock_timestamp()
          WHERE binding_id=$1 AND user_id=$2 AND unbound_at IS NULL RETURNING ${columns}`,
        [bindingId, scope.userId, patch.displayName?.trim(), patch.transferMode, patch.generationMode, patch.transcriptionLanguage]);
        if (!row) throw new DomainError(404, 'RECORDER_BINDING_NOT_FOUND');
        return view(row);
      });
      await requireActiveRecorderBinding(tx, scope.userId, bindingId, true);
      return response;
    });
  }

  async unbind(scope: Scope, bindingId: string, key: string) {
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      return idempotent(tx, this.secret, scope.userId, 'recorder.unbind', key, { bindingId }, async () => {
        const { rows: [row] } = await tx.query<{unbound_at: Date}>(`UPDATE recorder_bindings
          SET unbound_at=statement_timestamp(), updated_at=statement_timestamp()
          WHERE binding_id=$1 AND user_id=$2 AND unbound_at IS NULL RETURNING unbound_at`, [bindingId, scope.userId]);
        if (!row) throw new DomainError(404, 'RECORDER_BINDING_NOT_FOUND');
        return { bindingId, unboundAt: row.unbound_at.toISOString() };
      });
    });
  }
}
