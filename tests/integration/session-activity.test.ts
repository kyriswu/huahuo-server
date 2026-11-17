import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApiServer } from '../../src/apps/api-server.js';
import { migrate } from '../../src/db/migrate.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { IdentityService } from '../../src/modules/identity/service.js';
import { assertScope } from '../../src/modules/identity/store.js';
import { loadTestConfig as loadConfig } from '../sms-fixture.js';
import { insertFixtureSession, insertFixtureUser, testJwtEnv } from './jwt-fixture.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL;
const apiUrl = process.env.TEST_DATABASE_API_URL;
const redisUrls = [process.env.REDIS_CACHE_URL, process.env.REDIS_QUEUE_URL];
if (!migrationUrl || !apiUrl || !/^huahuo_test_[a-z0-9_]+$/u.test(new URL(migrationUrl).pathname.slice(1))
  || new URL(migrationUrl).hostname !== '127.0.0.1'
  || new URL(apiUrl).hostname !== '127.0.0.1'
  || new URL(apiUrl).pathname !== new URL(migrationUrl).pathname
  || redisUrls.some(url => !url || new URL(url).hostname !== '127.0.0.1' || Number(new URL(url).pathname.slice(1)) < 10)) {
  throw new Error('ISOLATED_DATABASE_REQUIRED');
}
const config = loadConfig('api-server', {
  ...testJwtEnv, APP_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: apiUrl,
  APP_TOKEN_SECRET: 'session-activity-fixture-'.repeat(3), APP_PUBLIC_BASE_URL: 'http://sessions.test',
  DATABASE_STATEMENT_TIMEOUT_MS: '1000', REDIS_CACHE_URL: redisUrls[0], REDIS_QUEUE_URL: redisUrls[1],
  REDIS_KEY_PREFIX: 'session_activity_' + randomUUID().replaceAll('-', ''), METRICS_ENABLED: 'false',
  PROVIDER_MODE: 'disabled', RAG_PROVIDER_MODE: 'disabled', BILLING_MODE: 'disabled',
  PROCESSING_NODES_ENABLED: 'false', PROCESSING_NODES_CLOUD_CONTROL_ENABLED: 'false',
});
const migrationConfig = loadConfig('migrate', { APP_ENV: 'test', DATABASE_URL: migrationUrl });
const root = poolFor(migrationConfig), pool = poolFor(config), secondPool = poolFor(config);
const sms = { async send() { throw new Error('SMS_CALL_FORBIDDEN'); } };
const identity = new IdentityService(pool, config, { sms });
const secondIdentity = new IdentityService(secondPool, config, { sms });
const users: string[] = [];

beforeAll(() => migrate(migrationConfig));
afterAll(async () => {
  try {
    await root.query('DELETE FROM user_audit_events WHERE user_id=ANY($1::uuid[])', [users]);
    await root.query('DELETE FROM user_sessions WHERE user_id=ANY($1::uuid[])', [users]);
    await root.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
  } finally { await Promise.all([pool.end(), secondPool.end(), root.end()]); }
});

async function fixture() {
  const userId = await insertFixtureUser(root), sessionId = randomUUID();
  users.push(userId);
  const bearer = await insertFixtureSession(root, userId, sessionId, 'activity-fixture');
  return { bearer, scope: { userId, sessionId, traceId: randomUUID() } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const authenticate = (f: Fixture, service = identity) => service.authenticate(`Bearer ${f.bearer}`, f.scope.traceId);
async function state(f: Fixture) {
  return (await root.query<{ version: string; location: string; seen: Date; access_expires_at: Date; expires_at: Date }>(
    'SELECT xmin::text AS version,ctid::text AS location,last_seen_at AS seen,access_expires_at,expires_at FROM user_sessions WHERE id=$1',
    [f.scope.sessionId],
  )).rows[0]!;
}
async function makeDue(f: Fixture) {
  await root.query("UPDATE user_sessions SET last_seen_at=now()-interval '2 minutes' WHERE id=$1", [f.scope.sessionId]);
  return state(f);
}

it('reads recently active sessions without writing a new row version for each authentication', async () => {
  const f = await fixture(), before = await state(f);
  for (let i = 0; i < 4; i++) expect(await authenticate(f)).toEqual(f.scope);
  expect(await state(f)).toEqual(before);
});

it('updates an overdue activity timestamp once and preserves session expiration', async () => {
  const f = await fixture(), before = await makeDue(f);
  expect(await authenticate(f)).toEqual(f.scope);
  const after = await state(f);
  expect(after.seen.getTime()).toBeGreaterThan(before.seen.getTime());
  expect(after.version).not.toBe(before.version);
  expect(after.access_expires_at).toEqual(before.access_expires_at);
  expect(after.expires_at).toEqual(before.expires_at);
  for (let i = 0; i < 3; i++) await authenticate(f);
  expect(await state(f)).toEqual(after);
});

it('authenticates before a real business share lock is released and retries the skipped activity on a later request', async () => {
  const f = await fixture(), before = await makeDue(f), business = await pool.connect();
  try {
    await business.query('BEGIN');
    await assertScope(business, f.scope);
    // Keep the business transaction open during authentication. A blocking UPDATE
    // hits the auth connection's statement timeout; no timed lock release masks it.
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => authenticate(f, i % 2 ? secondIdentity : identity)));
    for (const result of results) expect(result).toEqual(f.scope);
    expect(await state(f)).toEqual(before);
  } finally { await business.query('ROLLBACK'); business.release(); }
  await authenticate(f);
  expect((await state(f)).seen.getTime()).toBeGreaterThan(before.seen.getTime());
});

it('keeps parallel admissions valid across service instances and skips later writes inside the activity interval', async () => {
  const f = await fixture(), before = await makeDue(f);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => authenticate(f, i % 2 ? secondIdentity : identity)));
  for (const result of results) expect(result).toEqual(f.scope);
  const after = await state(f);
  expect(after.seen.getTime()).toBeGreaterThan(before.seen.getTime());
  expect(after.version).not.toBe(before.version);
  await Promise.all(Array.from({ length: 12 }, (_, i) => authenticate(f, i % 2 ? identity : secondIdentity)));
  expect(await state(f)).toEqual(after);
});

it('admits an in-flight read before revocation commits, then rejects the next admission after commit', async () => {
  const f = await fixture(), before = await makeDue(f), revocation = await root.connect();
  let pendingTransaction = false;
  try {
    await revocation.query('BEGIN');
    pendingTransaction = true;
    await revocation.query('UPDATE user_sessions SET revoked_at=now() WHERE id=$1', [f.scope.sessionId]);
    // READ COMMITTED sees the preceding committed session while this write is
    // uncommitted; activity must skip its row lock instead of waiting for COMMIT.
    expect(await authenticate(f)).toEqual(f.scope);
    const pending = (await revocation.query<{ seen: Date }>('SELECT last_seen_at AS seen FROM user_sessions WHERE id=$1', [f.scope.sessionId])).rows[0]!;
    expect(pending.seen).toEqual(before.seen);
    await revocation.query('COMMIT');
    pendingTransaction = false;
    await expect(authenticate(f)).rejects.toMatchObject({ statusCode: 401, code: 'AUTH_SESSION_EXPIRED' });
  } finally {
    try { if (pendingTransaction) await revocation.query('ROLLBACK'); }
    finally { revocation.release(); }
  }
});

it.each(['revoked', 'suspended', 'deleted', 'access-expired', 'session-expired', 'jti-mismatch', 'hash-mismatch', 'missing'] as const)(
  'rejects a committed %s state even when the session was recently active', async invalid => {
    const f = await fixture();
    await authenticate(f);
    switch (invalid) {
      case 'revoked': await identity.logout(f.scope); break;
      case 'suspended': await root.query("UPDATE users SET status='suspended' WHERE id=$1", [f.scope.userId]); break;
      case 'deleted': await root.query("UPDATE users SET status='deleted',deleted_at=now() WHERE id=$1", [f.scope.userId]); break;
      case 'access-expired': await root.query("UPDATE user_sessions SET access_expires_at=now()-interval '1 second' WHERE id=$1", [f.scope.sessionId]); break;
      case 'session-expired': await root.query("UPDATE user_sessions SET access_expires_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE id=$1", [f.scope.sessionId]); break;
      case 'jti-mismatch': await root.query('UPDATE user_sessions SET access_jti=$2 WHERE id=$1', [f.scope.sessionId, randomUUID()]); break;
      case 'hash-mismatch': await root.query("UPDATE user_sessions SET access_hash=repeat('0',64) WHERE id=$1", [f.scope.sessionId]); break;
      case 'missing': await root.query('DELETE FROM user_sessions WHERE id=$1', [f.scope.sessionId]); break;
    }
    await expect(authenticate(f)).rejects.toMatchObject({ statusCode: 401, code: 'AUTH_SESSION_EXPIRED' });
  },
);

it('returns gateway identity headers while a business transaction holds the overdue session share lock', async () => {
  const f = await fixture(), before = await makeDue(f);
  const app = await buildApiServer({ config, sms }), business = await pool.connect();
  try {
    await business.query('BEGIN');
    await assertScope(business, f.scope);
    const response = await app.inject({ method: 'GET', url: '/internal/v1/gateway/auth', headers: { authorization: `Bearer ${f.bearer}` } });
    expect(response.statusCode, response.body).toBe(204);
    expect(response.headers['x-huahuo-user-id']).toBe(f.scope.userId);
    expect(response.headers['x-huahuo-session-id']).toBe(f.scope.sessionId);
    expect(response.headers['x-huahuo-auth-method']).toBe('bearer');
    expect(await state(f)).toEqual(before);
  } finally {
    await business.query('ROLLBACK'); business.release();
    await app.close();
  }
});
