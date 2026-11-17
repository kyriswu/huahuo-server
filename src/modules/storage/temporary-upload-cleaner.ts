import type pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import { DomainError } from '../identity/store.js';
import type { StoragePort } from './port.js';
import type { TemporaryUploadStore } from './temporary-uploads.js';
import { findUploadedObject, withUploadLock } from './upload-session.js';

/** Expiry makes a file eligible for cleanup; ownership stays until cleanup succeeds. */
export class TemporaryUploadCleaner {
  private stopping = false;
  constructor(private readonly pool: pg.Pool, private readonly storage: StoragePort,
    private readonly uploads: TemporaryUploadStore, private readonly config: AppConfig) {}

  stop() { this.stopping = true; }

  async sweep(limit = 20) {
    const ids = await this.uploads.due(limit);
    const result = { checked: ids.length, removed: 0, retained: 0, failures: [] as Array<{ resourceId: string; code: string }> };
    for (const id of ids) {
      if (this.stopping) break;
      try {
        const removed = await withUploadLock(this.pool, id, async client => {
          // The same lock is held by ResourceClaims inside the business transaction.
          // Never inspect individual business tables or infer usage from a Redis key.
          if ((await client.query('SELECT 1 FROM resources WHERE resource_id=$1', [id])).rowCount) {
            await this.uploads.forget(id);
            return false;
          }
          const upload = await this.uploads.get(id);
          if (!upload) { await this.uploads.forget(id); return false; }
          if (upload.status !== 'cancelled' && upload.expiresAt > Date.now()) return false;
          if (upload.storageDriver !== this.config.storageDriver || upload.storageBucket !== this.config.storageAliyunOss?.bucket
            || !this.storage.abortUpload || !this.storage.head) throw new DomainError(503, 'UPLOAD_CLEANUP_STORAGE_MISMATCH');

          // Persist the decision before issuing a destructive RPC. If this DB
          // connection is lost, a new claimant must still reject the receipt.
          upload.status = 'cancelled';
          await this.uploads.save(upload);
          const aborted = upload.remoteUploadId ? await this.storage.abortUpload(id, upload.remoteUploadId) : 'missing';
          const object = await findUploadedObject(this.storage, id);
          if (object) {
            if (object.uploadSessionId !== id) throw new DomainError(409, 'UPLOAD_OBJECT_IDENTITY_MISMATCH');
            // Remember observed completion before deletion, so a lost DELETE
            // response or Redis outage can retry a now-missing object safely.
            upload.object = object;
            await this.uploads.save(upload);
            // A versioned bucket requires the actual version; a key-only delete
            // would leave the bytes behind a delete marker.
            await this.storage.remove(id, object.version);
          } else if (upload.completionStartedAt && aborted === 'missing' && !upload.object) {
            // OSS may still be executing a timed-out Complete. Retain the receipt
            // rather than declaring an unknown result to be a successful cleanup.
            throw new DomainError(409, 'UPLOAD_OUTCOME_UNKNOWN');
          }
          await this.uploads.forget(id);
          return true;
        });
        if (removed) result.removed++; else result.retained++;
      } catch (error) {
        result.failures.push({ resourceId: id, code: error instanceof DomainError ? error.code : 'UPLOAD_CLEANUP_FAILED' });
        // A few bad objects must not starve later entries in the bounded scan.
        await this.uploads.defer(id, 60_000).catch(() => undefined);
      }
    }
    return result;
  }
}
