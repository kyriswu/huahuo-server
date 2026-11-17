import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import { afterCommit, DomainError, type Scope } from '../identity/store.js';
import type { TemporaryUploadStore } from './temporary-uploads.js';

/** Called only by the business transaction that first references a completed upload. */
export class ResourceClaims {
  constructor(private readonly config: AppConfig, private readonly uploads: TemporaryUploadStore) {}

  /** Acquire before workspace/resource/business rows in any write that can claim uploads. */
  async lockAccount(tx: pg.PoolClient, scope: Scope): Promise<void> {
    const user = await tx.query("SELECT id FROM users WHERE id=$1 AND status='active' AND deleted_at IS NULL FOR UPDATE", [scope.userId]);
    if (!user.rowCount) throw new DomainError(401, 'UNAUTHORIZED');
  }

  async ensure(tx: pg.PoolClient, scope: Scope, workspaceId: string | undefined, resourceIds: readonly string[]): Promise<void> {
    const ids = [...new Set(resourceIds.map(id => id.toLowerCase()))].sort();
    if (!ids.length) return;
    if (ids.length > 1000 || ids.some(id => !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/u.test(id))) {
      throw new DomainError(400, 'RESOURCE_IDS_INVALID');
    }
    await this.lockAccount(tx, scope);
    // Same key and sorted acquisition order as temporary-upload cleanup.
    await tx.query(`WITH ordered AS MATERIALIZED (SELECT id FROM unnest($1::uuid[]) AS x(id) ORDER BY id)
      SELECT pg_advisory_xact_lock(hashtextextended('storage-upload:'||id::text,0)) FROM ordered`, [ids]);
    const rows = (await tx.query<{resource_id:string;user_id:string;workspace_id:string;status:string}>(
      'SELECT resource_id,user_id,workspace_id,status FROM resources WHERE resource_id=ANY($1::uuid[]) ORDER BY resource_id FOR UPDATE', [ids])).rows;
    const existing = new Map(rows.map(row => [row.resource_id, row]));
    for (const row of rows) {
      if (row.user_id !== scope.userId || (workspaceId && row.workspace_id !== workspaceId) || row.status !== 'ready') {
        throw new DomainError(404, 'RESOURCE_NOT_FOUND');
      }
    }
    const missing = ids.filter(id => !existing.has(id));
    if (!missing.length) return;
    const receipts = await Promise.all(missing.map(id => this.uploads.get(id)));
    const now = Date.now();
    for (let i = 0; i < receipts.length; i++) {
      const receipt = receipts[i];
      if (!receipt || receipt.id !== missing[i] || receipt.userId !== scope.userId
        || (workspaceId && receipt.workspaceId !== workspaceId) || receipt.status !== 'completed'
        || receipt.expiresAt <= now || !receipt.object || receipt.object.uploadSessionId !== receipt.id
        || !Number.isSafeInteger(receipt.object.bytes) || receipt.object.bytes <= 0 || receipt.object.bytes !== receipt.sizeBytes
        || !receipt.object.version || receipt.object.contentType.split(';',1)[0]!.trim().toLowerCase() !== receipt.mimeType.toLowerCase()) throw new DomainError(404, 'RESOURCE_NOT_FOUND');
      if (receipt.storageDriver !== 'aliyun-oss' || this.config.storageDriver !== 'aliyun-oss'
        || receipt.storageBucket !== this.config.storageAliyunOss?.bucket) throw new DomainError(409, 'RESOURCE_STORAGE_MISMATCH');
    }
    const completed = receipts.filter(receipt => receipt !== undefined && receipt !== null);
    const workspaces = [...new Set(completed.map(receipt => receipt.workspaceId))];
    const allowed = await tx.query("SELECT id FROM workspaces WHERE id=ANY($1::uuid[]) AND user_id=$2 AND state='ready' ORDER BY id FOR SHARE", [workspaces, scope.userId]);
    if (allowed.rowCount !== workspaces.length) throw new DomainError(404, 'WORKSPACE_NOT_FOUND');
    const added = completed.reduce((sum, receipt) => sum + BigInt(receipt.sizeBytes), 0n);
    const accounted=await tx.query(`UPDATE users SET storage_used_bytes=storage_used_bytes+$2::bigint
      WHERE id=$1 AND storage_used_bytes+storage_reserved_bytes+$2::bigint<=$3::bigint RETURNING id`,
    [scope.userId,added,this.config.storageQuotaBytes]);
    if(!accounted.rowCount)throw new DomainError(409,'STORAGE_QUOTA_EXCEEDED');
    for (const receipt of completed) {
      await tx.query(`INSERT INTO resources(resource_id,user_id,workspace_id,upload_id,file_name,mime_type,size_bytes,
        sha256,object_key,object_version,storage_driver,storage_bucket,status,processing_status)
        VALUES($1,$2,$3,$1,$4,$5,$6,NULL,$1,$7,$8,$9,'ready','metadata_confirmed')`,
      [receipt.id, receipt.userId, receipt.workspaceId, receipt.fileName, receipt.mimeType, receipt.sizeBytes,
        receipt.object!.version, receipt.storageDriver, receipt.storageBucket]);
      await tx.query(`INSERT INTO storage_reservations(reservation_id,user_id,resource_key,requested_bytes,confirmed_bytes,status,expires_at)
        VALUES($1,$2,$3,$4,$4,'confirmed',$5)`, [randomUUID(), receipt.userId, `resource:${receipt.id}`, receipt.sizeBytes, new Date(receipt.expiresAt)]);
      // On Redis failure the temporary cleaner sees the committed PG resource
      // and drops only its receipt; it never deletes the owned object.
      afterCommit(tx, () => this.uploads.forget(receipt.id));
    }
  }
}
