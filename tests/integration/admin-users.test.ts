import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/config/config.js';
import { migrate } from '../../src/db/migrate.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { buildAdminServer } from '../../src/apps/admin.js';
import { hashPassword } from '../../src/modules/identity/crypto.js';
import { loadEd25519Keys, signAccessToken } from '../../src/modules/identity/jwt.js';
import type { AdminUserList } from '../../src/modules/admin/user-schemas.js';
import { testJwtEnv } from './jwt-fixture.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL;
if (!migrationUrl || !/^huahuo_test_[a-z0-9_]+$/.test(new URL(migrationUrl).pathname.slice(1))) {
  throw new Error('ISOLATED_TEST_DATABASE_REQUIRED');
}
const common = {
  ...process.env, ...testJwtEnv, APP_ENV: 'test', LOG_LEVEL: 'silent',
  APP_TOKEN_SECRET: 'app-test-'.repeat(8), ADMIN_SESSION_SECRET: 'admin-test-'.repeat(8),
  APP_PUBLIC_BASE_URL: 'http://localhost:3000', ADMIN_PUBLIC_BASE_URL: 'http://localhost:3001',
};
const config = loadConfig('admin', { ...common, DATABASE_URL: process.env.TEST_DATABASE_ADMIN_URL });
const root = poolFor(loadConfig('migrate', { DATABASE_URL: migrationUrl }));
const limited = poolFor(config);
const prefix = `user-list-${randomUUID()}`;
const ids = Array.from({ length: 5 }, () => randomUUID());
const adminIds = [randomUUID(), randomUUID()];
const password = 'isolated-admin-users-fixture-password';
const cookies: string[] = [];
let app: FastifyInstance;

beforeAll(async () => {
  await migrate(loadConfig('migrate', { DATABASE_URL: migrationUrl }));
  app = await buildAdminServer({ config });
  for (const [index, id] of adminIds.entries()) {
    const username = `list-${id}`;
    await root.query('INSERT INTO admin_users(id,username,password_hash,role) VALUES($1,$2,$3,$4)',
      [id, username, await hashPassword(password), index === 0 ? 'operator' : 'superadmin']);
    const response = await app.inject({ method: 'POST', url: '/admin/api/v1/login',
      headers: { origin: config.adminOrigin }, payload: { username, password }, remoteAddress: `127.8.0.${index + 1}` });
    expect(response.statusCode).toBe(200);
    cookies.push(String(response.headers['set-cookie']).split(';')[0]!);
  }
  for (const [index, id] of ids.entries()) {
    const status = index === 3 ? 'suspended' : index === 4 ? 'deleted' : 'active';
    await root.query(`INSERT INTO users(id,display_name,status,created_at,deleted_at) VALUES($1,$2,$3,$4,$5)`,
      [id, `${prefix}-${index}${index === 2 ? '-%_' : ''}`, status,
        new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(index / 2))), status === 'deleted' ? new Date() : null]);
  }
  // An unverified identity cannot supply a displayed phone; multiple identities
  // must never duplicate users or inflate the count.
  for (const [index, verified] of [false, true, true].entries()) {
    await root.query(`INSERT INTO user_identities(id,user_id,provider,subject_hash,subject_masked,verified_at,created_at)
      VALUES($1,$2,'phone',$3,$4,$5,$6)`, [randomUUID(), ids[0], randomUUID().replaceAll('-', '').repeat(2),
      `138****000${index}`, verified ? new Date() : null, new Date(Date.UTC(2026, 0, 1, 0, 0, index))]);
  }
}, 20000);

afterAll(async () => {
  await app?.close();
  await root.query('DELETE FROM user_identities WHERE user_id=ANY($1::uuid[])', [ids]);
  await root.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [ids]);
  await root.query('DELETE FROM admin_sessions WHERE admin_id=ANY($1::uuid[])', [adminIds]);
  await root.query('DELETE FROM admin_audit_events WHERE admin_id=ANY($1::uuid[])', [adminIds]);
  await root.query('DELETE FROM admin_users WHERE id=ANY($1::uuid[])', [adminIds]);
  await limited.end();
  await root.end();
});

async function list(query: Record<string, string> = {}, cookie = cookies[0]) {
  return app.inject({ url: `/admin/api/v1/users?${new URLSearchParams({ search: prefix, ...query })}`, headers: { cookie } });
}

describe('basic read-only user management with real PostgreSQL and runtime grants', () => {
  it('allows both admin roles, returns only basic fields and a verified masked phone', async () => {
    for (const cookie of cookies) {
      const response = await list({}, cookie);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const data = response.json().data as AdminUserList;
      expect(data.total).toBe(5);
      expect(data.page).toBe(1);
      expect(data.pageSize).toBe(20);
      expect(data.items.find(user => user.userId === ids[0])?.phoneMasked).toBe('138****0001');
      expect(data.items.find(user => user.userId === ids[1])?.phoneMasked).toBeNull();
      expect(data.items.every(user => Object.keys(user).sort().join(',') === 'createdAt,displayName,phoneMasked,status,userId')).toBe(true);
    }
  });

  it('paginates deterministically by registration time and user ID with no duplicates', async () => {
    const expected = [...ids].sort((a, b) => Math.floor(ids.indexOf(b) / 2) - Math.floor(ids.indexOf(a) / 2) || b.localeCompare(a));
    const returned: string[] = [];
    for (const page of [1, 2, 3]) {
      const response = await list({ page: String(page), pageSize: '2' });
      const data = response.json().data as AdminUserList;
      expect(data.total).toBe(5);
      returned.push(...data.items.map(user => user.userId));
    }
    expect(returned).toEqual(expected);
    expect((await list({ page: '10000' })).json().data).toMatchObject({ items: [], total: 5 });
  });

  it('supports case-insensitive nickname lookup, exact user ID and combined status filters', async () => {
    expect((await list({ search: prefix.toUpperCase(), status: 'active' })).json().data.total).toBe(3);
    expect((await list({ status: 'suspended' })).json().data.items).toMatchObject([{ userId: ids[3] }]);
    expect((await list({ status: 'deleted' })).json().data.items).toMatchObject([{ userId: ids[4] }]);
    expect((await list({ search: ` ${ids[0]!.toUpperCase()} ` })).json().data.items).toMatchObject([{ userId: ids[0] }]);
    expect((await list({ search: ids[0]!, status: 'deleted' })).json().data.total).toBe(0);
  });

  it('treats wildcard and SQL-like input as literal text and returns an honest empty result', async () => {
    expect((await list({ search: `${prefix}-2-%_` })).json().data.total).toBe(1);
    expect((await list({ search: `${prefix}' OR 1=1 --` })).json().data).toMatchObject({ items: [], total: 0 });
    const response = await list({ search: `${prefix}-missing` });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ items: [], total: 0 });
  });

  it('rejects invalid pagination, status, oversized searches and extra query fields', async () => {
    const invalid: Record<string, string>[] = [{ page: '0' }, { page: '-1' }, { page: '10001' }, { page: '1.5' },
      { pageSize: '0' }, { pageSize: '101' }, { status: 'unknown' }, { search: 'x'.repeat(121) }, { export: 'true' }];
    for (const query of invalid) {
      expect((await list(query)).statusCode).toBe(400);
    }
  });

  it('does not accept an App JWT or an anonymous request as admin authentication', async () => {
    const keys = await loadEd25519Keys(config.jwt);
    const jwt = await signAccessToken(keys.privateKey, config.jwt, ids[0]!, randomUUID());
    for (const headers of [{}, { authorization: `Bearer ${jwt.token}` }]) {
      const response = await app.inject({ url: '/admin/api/v1/users', headers });
      expect(response.statusCode).toBe(401);
    }
    expect((await app.inject({ method: 'POST', url: '/admin/api/v1/users', headers: { cookie: cookies[0]! }, payload: {} })).statusCode).toBe(404);
  });

  it('keeps identity hashes and user sessions inaccessible and never permits user writes', async () => {
    for (const sql of ['SELECT subject_hash FROM user_identities', 'SELECT provider_subject FROM user_identities',
      'SELECT * FROM user_sessions', 'SELECT * FROM refresh_tokens', 'SELECT * FROM user_api_keys',
      "UPDATE users SET display_name='forbidden' WHERE false", 'DELETE FROM users WHERE false']) {
      await expect(limited.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
    expect((await limited.query('SELECT id,display_name,status,created_at FROM users WHERE id=$1', [ids[0]])).rowCount).toBe(1);
  });

  it('audits list access without recording query values and rejects revoked sessions', async () => {
    const trace = `users-${randomUUID()}`;
    await app.inject({ url: `/admin/api/v1/users?search=${ids[0]}`, headers: { cookie: cookies[0]!, 'x-trace-id': trace } });
    const rows = await root.query('SELECT admin_id,action,target_id,reason FROM admin_audit_events WHERE trace_id=$1', [trace]);
    expect(rows.rows).toEqual([{ admin_id: adminIds[0], action: 'user.list', target_id: null, reason: null }]);
    await root.query('UPDATE admin_sessions SET revoked_at=now() WHERE admin_id=$1', [adminIds[0]]);
    expect((await list()).statusCode).toBe(401);
  });
});
