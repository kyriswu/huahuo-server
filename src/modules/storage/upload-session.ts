import type pg from 'pg';
import { DomainError } from '../identity/store.js';
import type { ObjectMetadata, StoragePort } from './port.js';
import type { TemporaryUpload } from './temporary-uploads.js';

/** Serializes control requests across replicas without an open transaction during OSS I/O.
 * A busy caller retries; no file data or long-lived upload connection holds this lock.
 * The session lock disappears if the process/connection dies.
 */
export async function withUploadLock<T>(pool: pg.Pool, uploadId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const key = `storage-upload:${uploadId}`;
  let locked = false;
  let discard = false;
  let connectionLost = false;
  // pg-pool removes its idle error listener on checkout. A disconnected checked-
  // out client must not emit an unhandled error while we await an OSS request.
  const onError = () => { connectionLost = true; discard = true; };
  client.on('error', onError);
  try {
    const ownership = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [key]);
    locked = ownership.rows[0]?.acquired === true;
    if (!locked) throw new DomainError(409, 'UPLOAD_BUSY');
    const result = await fn(client);
    if (connectionLost) throw new DomainError(503, 'UPLOAD_COORDINATION_UNAVAILABLE');
    return result;
  } finally {
    if (locked && !connectionLost) {
      try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); }
      catch { discard = true; }
    }
    // Never return a possibly locked connection to the pool.
    client.release(discard);
    client.off('error', onError);
  }
}

/** Only a missing object is absence. Access errors, missing buckets and timeouts must retry. */
export async function findUploadedObject(storage: StoragePort, key: string): Promise<ObjectMetadata | undefined> {
  if (!storage.head) throw new Error('DIRECT_UPLOAD_NOT_CONFIGURED');
  try { return await storage.head(key); }
  catch (error) {
    if ((error as { code?: string })?.code === 'NoSuchKey') return undefined;
    throw error;
  }
}

export function validateUploadedObject(session: TemporaryUpload, object: ObjectMetadata): void {
  if (object.uploadSessionId !== session.id) throw new DomainError(409, 'UPLOAD_OBJECT_IDENTITY_MISMATCH');
  if (!Number.isSafeInteger(object.bytes) || object.bytes <= 0 || !object.version || !object.etag) {
    throw new DomainError(409, 'UPLOAD_OBJECT_METADATA_INVALID');
  }
  if (object.bytes !== session.sizeBytes) throw new DomainError(400, 'UPLOAD_SIZE_MISMATCH');
  if (object.contentType.split(';', 1)[0]!.trim().toLowerCase() !== session.mimeType.toLowerCase()) {
    throw new DomainError(400, 'UPLOAD_MIME_MISMATCH');
  }
}
