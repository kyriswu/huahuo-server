import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config/config.js';
import { migrate } from '../../src/db/migrate.js';
import { IdentityService } from '../../src/modules/identity/service.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { insertFixtureSession, insertFixtureUser, testJwtEnv } from './jwt-fixture.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL;
if (!migrationUrl || !/^huahuo_test_[a-z0-9_]+$/.test(new URL(migrationUrl).pathname.slice(1))) {
  throw new Error('REAL_ISOLATED_TEST_DATABASE_REQUIRED: run scripts/integration.mjs');
}
const migrationConfig = loadConfig('migrate', { DATABASE_URL: migrationUrl });
const root = poolFor(migrationConfig);
const config = loadConfig('api-server', {
  ...process.env, ...testJwtEnv, APP_ENV: 'test', LOG_LEVEL: 'silent',
  APP_TOKEN_SECRET: 'unified-users-test-secret-'.repeat(2),
  APP_PUBLIC_BASE_URL: 'http://users.test', DATABASE_URL: process.env.TEST_DATABASE_API_URL,
});
const pool = poolFor(config);
const identity = new IdentityService(pool, config);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('unified users and authentication schema', () => {
  beforeAll(() => migrate(migrationConfig));
  afterAll(async () => { await Promise.all([pool.end(), root.end()]); });

  it('uses one fresh schema without old user tables or phone/session aliases', async () => {
    const tables = await root.query<{ name: string; kind: string }>(`SELECT c.relname AS name,c.relkind AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])`, [
      ['users','user_identities','user_sessions','refresh_tokens','otp_requests','user_agreement_acceptances','user_api_keys','app_users','agreement_acceptances','rag_parent_segments'],
    ]);
    expect(tables.rows.map(row => row.name).sort()).toEqual(['users','user_identities','user_sessions','refresh_tokens','otp_requests','user_agreement_acceptances','user_api_keys'].sort());
    expect(tables.rows.every(row => row.kind === 'r')).toBe(true);
    const columns = (await root.query<{ table_name: string; column_name: string }>(`SELECT table_name,column_name
      FROM information_schema.columns WHERE table_schema='public'`)).rows;
    for (const [tableName, required] of Object.entries({
      users: ['id','status','deleted_at','updated_at'],
      user_identities: ['id','user_id','provider','subject_hash','subject_masked'],
      user_sessions: ['user_id','client_type','client_id','access_jti','access_hash'],
      otp_requests: ['subject_hash','purpose','delivery_status'],
      user_agreement_acceptances: ['user_id','session_id','accepted_via'],
      user_api_keys: ['id','user_id'],
    })) expect(columns.filter(row => row.table_name===tableName).map(row => row.column_name), tableName).toEqual(expect.arrayContaining(required));
    const aliases = await root.query(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='public' AND ((table_name='users' AND column_name IN ('phone_hash','phone_masked'))
      OR (table_name='user_sessions' AND column_name='device_id')
      OR (table_name='otp_requests' AND column_name IN ('phone_hash','delivery'))
      OR (table_name='refresh_tokens' AND column_name='device_info'))`);
    expect(aliases.rows).toEqual([]);
  });

  it('keeps identity hashes separate from user IDs and enforces provider subject uniqueness', async () => {
    const userId = await insertFixtureUser(root), otherUserId = await insertFixtureUser(root);
    const subjectHash = hash(randomUUID());
    await root.query(`INSERT INTO user_identities(id,user_id,provider,subject_hash,subject_masked)
      VALUES($1,$2,'phone',$3,'138****0000')`, [randomUUID(),userId,subjectHash]);
    const row = (await root.query('SELECT id FROM users WHERE id=$1', [userId])).rows[0];
    expect(row.id).toBe(userId);
    await expect(root.query(`INSERT INTO user_identities(id,user_id,provider,subject_hash,subject_masked)
      VALUES($1,$2,'phone',$3,'138****0000')`, [randomUUID(),otherUserId,subjectHash])).rejects.toMatchObject({ code: '23505' });
    await expect(root.query(`INSERT INTO user_identities(id,user_id,provider,subject_hash,subject_masked)
      VALUES($1,$2,'phone','invalid-hash','138****0000')`, [randomUUID(),userId])).rejects.toMatchObject({ code: '23514' });
  });

  it('authenticates a fixture JWT only when its exact token ID and hash match its session', async () => {
    const userId = await insertFixtureUser(root), sessionId = randomUUID();
    const bearer = await insertFixtureSession(root, userId, sessionId);
    expect(await identity.authenticate(`Bearer ${bearer}`, 'users-fixture')).toMatchObject({ userId, sessionId });
    const session = (await root.query('SELECT client_type,client_id,access_jti,access_hash FROM user_sessions WHERE id=$1', [sessionId])).rows[0];
    expect(session).toMatchObject({ client_type: 'app', access_jti: sessionId, access_hash: hash(bearer) });
    expect(session.client_id).toBeTruthy();
    await root.query('UPDATE user_sessions SET access_jti=$2 WHERE id=$1', [sessionId,randomUUID()]);
    await expect(identity.authenticate(`Bearer ${bearer}`, 'users-fixture')).rejects.toMatchObject({ statusCode: 401 });
  });

  it.each(['suspended','deleted'])('rejects a valid session when its user is %s', async status => {
    const userId = await insertFixtureUser(root), bearer = await insertFixtureSession(root,userId);
    await root.query("UPDATE users SET status=$2,deleted_at=CASE WHEN $2='deleted' THEN now() ELSE NULL END WHERE id=$1", [userId,status]);
    await expect(identity.authenticate(`Bearer ${bearer}`, 'users-fixture')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('uses plain user associations without allowing an orphan session to authenticate', async () => {
    const missingUserId = randomUUID(), bearer = await insertFixtureSession(root,missingUserId);
    expect((await root.query('SELECT count(*)::int n FROM user_sessions WHERE user_id=$1', [missingUserId])).rows[0].n).toBe(1);
    await expect(identity.authenticate(`Bearer ${bearer}`, 'users-fixture')).rejects.toMatchObject({ statusCode: 401 });
    const foreignKeys = await root.query(`SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND c.contype='f'
      AND t.relname=ANY($1::text[])`, [['users','user_identities','user_sessions','refresh_tokens','user_agreement_acceptances','user_api_keys']]);
    expect(foreignKeys.rows).toEqual([]);
  });

  it('enforces session client and token constraints without database foreign keys', async () => {
    const userId = await insertFixtureUser(root), sessionId = randomUUID();
    await insertFixtureSession(root,userId,sessionId);
    for (const sql of [
      "UPDATE user_sessions SET client_id='' WHERE id=$1",
      "UPDATE user_sessions SET client_type='unsupported' WHERE id=$1",
      "UPDATE user_sessions SET access_hash='not-a-sha256-hash' WHERE id=$1",
      "UPDATE user_sessions SET expires_at=created_at-interval '1 second' WHERE id=$1",
    ]) await expect(root.query(sql,[sessionId])).rejects.toMatchObject({ code: '23514' });
    await expect(root.query('UPDATE user_sessions SET access_jti=NULL WHERE id=$1',[sessionId])).rejects.toMatchObject({ code: '23502' });
  });

  it('updates users.updated_at automatically on profile edits', async () => {
    const userId = await insertFixtureUser(root);
    const row = (await root.query(`UPDATE users SET display_name='updated profile',updated_at='2000-01-01T00:00:00Z'
      WHERE id=$1 RETURNING updated_at`,[userId])).rows[0];
    expect(new Date(row.updated_at).getTime()).toBeGreaterThan(Date.now()-60_000);
  });
});
