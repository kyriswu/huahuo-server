import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { digest, canonical, seal, unseal } from '../../lib/crypto.js';
import { DomainError, transaction, assertScope, type Scope } from '../identity/store.js';
import type { LinkExtractor } from '../../lib/link-extraction/index.js';

type Extracted = Awaited<ReturnType<LinkExtractor['extract']>>;
type Result = Extracted & {contentAssetId: string};
type State = {owner: string} | {result: Result};
const operation = 'content-asset.link-extraction';
export const extractionTimeoutMs = 60_000;

/** The short reservation and final asset commit are separate transactions.
 * A replacement owner fences late responses from an expired request. */
export async function importLink(pool: pg.Pool, secret: string, scope: Scope, key: string, url: string,
  extract: () => Promise<Extracted>, save: (tx: pg.PoolClient, body: Extracted) => Promise<Result>, signal: AbortSignal): Promise<Result> {
  const identity = [scope.userId, operation, key];
  const hash = digest(canonical({url}));
  const owner = randomUUID();
  const reservation = seal({owner},secret);
  const previous = await transaction(pool, async tx => {
    await assertScope(tx,scope);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[canonical(identity)]);
    const row = (await tx.query<{request_hash:string; response_cipher:string; valid:boolean}>(
      'SELECT request_hash,response_cipher,expires_at>clock_timestamp() AS valid FROM api_idempotency WHERE scope=$1 AND operation=$2 AND key=$3 FOR UPDATE',identity)).rows[0];
    if (row) {
      if (row.request_hash !== hash) throw new DomainError(409,'IDEMPOTENCY_CONFLICT');
      const state = unseal<State>(row.response_cipher,secret);
      if ('result' in state) {
        if (!row.valid) throw new DomainError(409,'IDEMPOTENCY_KEY_EXPIRED');
        return state.result;
      }
      if (row.valid) throw new DomainError(409,'LINK_EXTRACTION_IN_PROGRESS');
    }
    await tx.query(`INSERT INTO api_idempotency(scope,operation,key,request_hash,response_cipher,expires_at)
      VALUES ($1,$2,$3,$4,$5,clock_timestamp()+$6*interval '1 millisecond') ON CONFLICT(scope,operation,key) DO UPDATE
      SET response_cipher=excluded.response_cipher,expires_at=excluded.expires_at`,[...identity,hash,reservation,extractionTimeoutMs]);
  });
  if (previous) return previous;
  try {
    const extracted = await extract();
    return await transaction(pool,async tx => {
      signal.throwIfAborted();
      const claim = await tx.query('SELECT 1 FROM api_idempotency WHERE scope=$1 AND operation=$2 AND key=$3 AND response_cipher=$4 AND expires_at>clock_timestamp() FOR UPDATE',[...identity,reservation]);
      if (!claim.rowCount) throw new DomainError(409,'LINK_EXTRACTION_LEASE_LOST');
      const result = await save(tx,extracted);
      signal.throwIfAborted();
      await tx.query("UPDATE api_idempotency SET response_cipher=$4, expires_at=clock_timestamp()+interval '1 day' WHERE scope=$1 AND operation=$2 AND key=$3",[...identity,seal({result},secret)]);
      return result;
    });
  } catch (error) {
    await pool.query('UPDATE api_idempotency SET expires_at=clock_timestamp() WHERE scope=$1 AND operation=$2 AND key=$3 AND response_cipher=$4',[...identity,reservation]);
    throw error;
  }
}
