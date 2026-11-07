import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../lib/domain-error.js';
export { DomainError } from '../../lib/domain-error.js';
export interface Scope { readonly userId: string; readonly sessionId: string; readonly traceId: string; }
export async function transaction<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    try { const result = await fn(tx); await tx.query('COMMIT'); return result; }
    catch (e) { await tx.query(e instanceof DomainError && e.commit ? 'COMMIT' : 'ROLLBACK'); throw e; }
  } finally { tx.release(); }
}
export async function lock(tx: pg.PoolClient, value: string) { await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [value]); }
export async function audit(tx: pg.PoolClient, scope: Scope, action: string, targetId?: string) {
  await tx.query('INSERT INTO user_audit_events(id,user_id,session_id,action,target_id,trace_id) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(),scope.userId,scope.sessionId,action,targetId ?? null,scope.traceId]);
}
export async function assertScope(tx: pg.PoolClient, scope: Scope) {
  const r = await tx.query("SELECT s.id FROM user_sessions s JOIN users u ON u.id=s.user_id AND u.status='active' AND u.deleted_at IS NULL WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.access_expires_at>now() FOR SHARE OF s", [scope.sessionId,scope.userId]);
  if (!r.rowCount) throw new DomainError(401,'AUTH_SESSION_EXPIRED');
}
export async function rateLimit(tx: pg.PoolClient, key: string, max: number, seconds: number, admin = false) {
  const table = admin ? 'admin_login_limits' : 'auth_rate_limits';
  const r = await tx.query<{hits:number}>(`INSERT INTO ${table}(key) VALUES($1)
   ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN ${table}.window_started_at<now()-$2*interval '1 second' THEN 1 ELSE ${table}.hits+1 END,
   window_started_at=CASE WHEN ${table}.window_started_at<now()-$2*interval '1 second' THEN now() ELSE ${table}.window_started_at END RETURNING hits`, [key,seconds]);
  if (r.rows[0]!.hits > max) throw new DomainError(429, admin ? 'ADMIN_RATE_LIMITED' : 'SMS_RATE_LIMITED', true);
}
