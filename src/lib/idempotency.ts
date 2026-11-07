import type pg from 'pg';
import { canonical, digest, seal, unseal } from './crypto.js';
import { DomainError } from './domain-error.js';

/**
 * Must run inside the caller's transaction. The advisory lock, business writes
 * and encrypted response commit together, so failures can safely retry.
 * Expired keys fail explicitly rather than silently repeating a mutation.
 */
export async function idempotent<T>(tx: pg.PoolClient, secret: string, scope: string, operation: string, key: string | undefined, input: unknown, fn: () => Promise<T>, ttl = 86400): Promise<T> {
  if (!key) return fn();
  if (!secret || secret.length < 32) throw new Error('IDEMPOTENCY_SECRET_REQUIRED');
  if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error('IDEMPOTENCY_TTL_INVALID');
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['idem:' + canonical([scope, operation, key])]);
  const hash = digest(canonical(input));
  const r = await tx.query<{ request_hash: string; response_cipher: string; valid: boolean }>('SELECT request_hash,response_cipher,expires_at>now() valid FROM api_idempotency WHERE scope=$1 AND operation=$2 AND key=$3', [scope, operation, key]);
  const previous = r.rows[0];
  if (previous) {
    if (!previous.valid) throw new DomainError(409, 'IDEMPOTENCY_KEY_EXPIRED');
    if (previous.request_hash !== hash) throw new DomainError(409, 'IDEMPOTENCY_CONFLICT');
    return unseal<T>(previous.response_cipher, secret);
  }
  const result = await fn();
  await tx.query("INSERT INTO api_idempotency(scope,operation,key,request_hash,response_cipher,expires_at) VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 second')", [scope, operation, key, hash, seal(result, secret), ttl]);
  return result;
}
