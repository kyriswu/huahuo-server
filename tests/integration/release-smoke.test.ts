import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config/config.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { migrate } from '../../src/db/migrate.js';
import { buildApiServer } from '../../src/apps/api-server.js';
import { insertFixtureUser, insertFixtureSession, testJwtEnv } from './jwt-fixture.js';
// @ts-expect-error Release tooling deliberately uses dependency-free plain JavaScript.
import { readSmokeConfig, runSmoke } from '../../scripts/release/smoke.mjs';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL!;
if (!migrationUrl || !/^huahuo_test_/.test(new URL(migrationUrl).pathname.slice(1))) throw new Error('TEST_DB_REQUIRED');
const config = loadConfig('api-server', {
  ...process.env, ...testJwtEnv, DATABASE_URL: process.env.TEST_DATABASE_API_URL,
  APP_ENV: 'test', LOG_LEVEL: 'silent', APP_TOKEN_SECRET: 'smoke-fixture-'.repeat(4),
  APP_PUBLIC_BASE_URL: 'http://localhost:3000', BILLING_MODE: 'disabled', SMS_PROVIDER: 'disabled',
  PROVIDER_MODE: 'disabled', RAG_PROVIDER_MODE: 'disabled', RAG_RERANK_PROVIDER: 'disabled',
  PROCESSING_NODES_ENABLED: 'false', ENABLE_DEMO_TASKS: 'false',
});
const root = poolFor(loadConfig('migrate', { DATABASE_URL: migrationUrl }));
let app: Awaited<ReturnType<typeof buildApiServer>>;
let baseUrl: string;

beforeAll(async () => {
  await migrate(loadConfig('migrate', { DATABASE_URL: migrationUrl }));
  app = await buildApiServer({ config });
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
}, 20000);
afterAll(async () => { await app?.close(); await root.end(); });

async function fixture() {
  const userId = randomUUID(), sessionId = randomUUID(), workspaceId = randomUUID();
  await insertFixtureUser(root, userId);
  const bearer = await insertFixtureSession(root, userId, sessionId, 'release-smoke-fixture');
  await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'Smoke fixture',true,$3)", [workspaceId, userId, randomUUID()]);
  await root.query("UPDATE user_sessions SET last_seen_at=now()-interval '1 day' WHERE id=$1", [sessionId]);
  return { userId, sessionId, workspaceId, bearer,
    env: { SMOKE_BASE_URL: baseUrl, SMOKE_ACCESS_TOKEN: bearer, SMOKE_USER_ID: userId, SMOKE_WORKSPACE_ID: workspaceId } };
}
async function counts() {
  return (await root.query(`SELECT
    (SELECT count(*) FROM users)::int AS users,
    (SELECT count(*) FROM user_sessions)::int AS sessions,
    (SELECT count(*) FROM workspaces)::int AS workspaces,
    (SELECT count(*) FROM notes)::int AS notes,
    (SELECT count(*) FROM resources)::int AS resources,
    (SELECT count(*) FROM tasks)::int AS tasks,
    (SELECT count(*) FROM task_outbox)::int AS outbox,
    (SELECT count(*) FROM task_attempts)::int AS attempts,
    (SELECT count(*) FROM task_results)::int AS results,
    (SELECT count(*) FROM document_parse_callbacks)::int AS callbacks,
    (SELECT count(*) FROM processing_node_assignments)::int AS assignments,
    (SELECT count(*) FROM user_audit_events)::int AS user_audits,
    (SELECT count(*) FROM admin_audit_events)::int AS admin_audits,
    (SELECT count(*) FROM credit_ledger_entries)::int AS credit_entries,
    (SELECT count(*) FROM credit_reservations)::int AS credit_reservations,
    (SELECT count(*) FROM storage_reservations)::int AS storage_reservations,
    (SELECT count(*) FROM auth_rate_limits)::int AS auth_limits`)).rows[0];
}
async function account(userId: string, sessionId: string, workspaceId: string) {
  return (await root.query(`SELECT
    (SELECT to_jsonb(u) FROM users u WHERE u.id=$1) AS account,
    (SELECT to_jsonb(w) FROM workspaces w WHERE w.id=$3) AS workspace,
    (SELECT to_jsonb(s)-'last_seen_at' FROM user_sessions s WHERE s.id=$2) AS session,
    (SELECT last_seen_at FROM user_sessions WHERE id=$2) AS last_seen_at`, [userId, sessionId, workspaceId])).rows[0];
}

describe('release smoke over real isolated PG/Redis and loopback API', () => {
  it('passes six real GETs without creating business records; only normal session last_seen_at changes', async () => {
    const f = await fixture();
    const beforeCounts = await counts(), before = await account(f.userId, f.sessionId, f.workspaceId);
    const result = await runSmoke(readSmokeConfig(f.env));
    expect(result.status).toBe('passed'); expect(result.requestCount).toBe(6);
    expect(result.checks).toHaveLength(6);
    expect(await counts()).toEqual(beforeCounts);
    const after = await account(f.userId, f.sessionId, f.workspaceId);
    expect(after.account).toEqual(before.account); expect(after.workspace).toEqual(before.workspace); expect(after.session).toEqual(before.session);
    expect(after.last_seen_at.getTime()).toBeGreaterThan(before.last_seen_at.getTime());
    const output = JSON.stringify(result);
    for (const privateValue of [f.userId, f.sessionId, f.workspaceId, f.bearer, 'Smoke fixture', baseUrl]) expect(output).not.toContain(privateValue);
  });

  it('fails when the valid credential belongs to a different expected account', async () => {
    const f = await fixture(), before = await counts();
    const result = await runSmoke(readSmokeConfig({ ...f.env, SMOKE_USER_ID: randomUUID() }));
    expect(result.status).toBe('failed'); expect(result.requestCount).toBe(4);
    expect(result.checks.at(-1)).toMatchObject({ name: 'identity', status: 'failed', code: 'SMOKE_IDENTITY_MISMATCH', httpStatus: 200 });
    expect(await counts()).toEqual(before);
  });

  it.each(['revoked', 'expired'] as const)('fails with a %s session and never refreshes or creates another session', async kind => {
    const f = await fixture();
    if (kind === 'revoked') await root.query('UPDATE user_sessions SET revoked_at=now() WHERE id=$1', [f.sessionId]);
    else await root.query("UPDATE user_sessions SET access_expires_at=now()-interval '1 second' WHERE id=$1", [f.sessionId]);
    const beforeCounts = await counts(), before = await account(f.userId, f.sessionId, f.workspaceId);
    const result = await runSmoke(readSmokeConfig(f.env));
    expect(result.status).toBe('failed'); expect(result.requestCount).toBe(4);
    expect(result.checks.at(-1)).toMatchObject({ name: 'identity', status: 'failed', code: 'SMOKE_HTTP_STATUS', httpStatus: 401 });
    expect(await counts()).toEqual(beforeCounts);
    expect(await account(f.userId, f.sessionId, f.workspaceId)).toEqual(before);
  });
});
