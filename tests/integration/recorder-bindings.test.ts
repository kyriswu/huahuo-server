import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApiServer } from '../../src/apps/api-server.js';
import { migrate } from '../../src/db/migrate.js';
import { RecorderBindingService, type RecorderBinding, type RecorderBindingVerifier } from '../../src/modules/recorder-bindings/service.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { loadTestConfig } from '../sms-fixture.js';
import { fixtureScopeHeaders, insertFixtureSession, insertFixtureUser, testJwtEnv } from './jwt-fixture.js';

const migrator = loadTestConfig('migrate', { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_MIGRATION_URL });
const root = poolFor(migrator);
const secret = 'recorder-bindings-integration'.repeat(2);
const listPath = '/api/v1/recorder-bindings';
let api: Awaited<ReturnType<typeof buildApiServer>>;

// The hardware proof protocol belongs to the provider. This fixture scopes proof to both user and device.
const verifier: RecorderBindingVerifier = {
  async verify({ userId, deviceId, proof }) {
    if (proof === 'simulated-outage') throw new Error('test verifier unavailable');
    if (proof === 'wrong-device') return { deviceId: 'another-SN', modelCode: 'fixture-card' };
    return proof === userId + '/' + deviceId ? { deviceId, modelCode: 'fixture-card' } : null;
  },
};

async function account(existingUserId?: string) {
  const userId = existingUserId ?? await insertFixtureUser(root);
  const sessionId = randomUUID();
  const token = await insertFixtureSession(root, userId, sessionId, 'phone-' + sessionId);
  return { userId, sessionId, headers: fixtureScopeHeaders(token) };
}
type Account = Awaited<ReturnType<typeof account>>;
const writeHeaders = (user: Account, key: string = randomUUID()) => ({ ...user.headers, 'x-idempotency-key': key });
const bind = (user: Account, payload: object, key?: string) =>
  api.inject({ method: 'POST', url: listPath, headers: writeHeaders(user, key), payload });
const proofFor = (user: Account, deviceId: string) => ({ deviceId, transferMode: 'manual', proof: user.userId + '/' + deviceId });

beforeAll(async () => {
  await migrate(migrator);
  const config = loadTestConfig('api-server', {
    ...process.env, ...testJwtEnv, LOG_LEVEL: 'silent', APP_TOKEN_SECRET: secret,
    APP_PUBLIC_BASE_URL: 'http://api.test', DATABASE_URL: process.env.TEST_DATABASE_API_URL,
  });
  api = await buildApiServer({ config, recorderBindingVerifier: verifier });
});
afterAll(async () => { try { await api?.close(); } finally { await root.end(); } });

describe('recorder binding routes against isolated PostgreSQL', () => {
  it('requires a signed-in account, an explicit transfer choice and verification for first claim', async () => {
    const user = await account(), deviceId = randomUUID();
    expect((await api.inject(listPath)).statusCode).toBe(401);
    expect((await bind(user, { deviceId })).json().error.code).toBe('RECORDER_TRANSFER_MODE_REQUIRED');
    expect((await bind(user, { deviceId, transferMode: 'manual' })).json().error.code).toBe('RECORDER_PROOF_REQUIRED');
    for (const proof of ['bogus', 'wrong-device']) {
      expect((await bind(user, { deviceId, transferMode: 'auto', proof })).json().error.code).toBe('RECORDER_PROOF_INVALID');
    }
    expect((await bind(user, { deviceId, transferMode: 'auto', proof: 'simulated-outage' })).statusCode).toBe(503);
    const offline = new RecorderBindingService(root, secret);
    await expect(offline.bind({ ...user, traceId: randomUUID() }, { deviceId, transferMode: 'auto', proof: 'some-proof' }, randomUUID()))
      .rejects.toMatchObject({ statusCode: 503, code: 'RECORDER_VERIFIER_UNAVAILABLE' });
    expect((await bind(user, proofFor(user, '卡'.repeat(43)))).json().error.code).toBe('RECORDER_DEVICE_ID_INVALID');
    expect((await api.inject({ url: listPath, headers: user.headers })).json().data.items).toEqual([]);
  });

  it('lists and updates account-owned cards across phones, then transfers ownership in a new binding period', async () => {
    const owner = await account(), secondPhone = await account(owner.userId), other = await account();
    const deviceId = randomUUID(), extraDevice = randomUUID(), bindKey = randomUUID();
    const first = await bind(owner, proofFor(owner, deviceId), bindKey);
    expect(first.statusCode).toBe(200);
    const binding = first.json().data as RecorderBinding;
    expect(binding).toMatchObject({ deviceId, modelCode: 'fixture-card', displayName: null,
      transferMode: 'manual', generationMode: 'auto', transcriptionLanguage: 'auto' });
    expect((await bind(secondPhone, proofFor(owner, deviceId), bindKey)).json().data).toEqual(binding);
    expect((await bind(secondPhone, { deviceId })).json().data).toEqual(binding);
    expect((await bind(owner, proofFor(owner, extraDevice))).statusCode).toBe(200);
    const contested = await bind(other, proofFor(other, deviceId));
    expect(contested.statusCode).toBe(409);
    expect(contested.json().error.code).toBe('RECORDER_ALREADY_BOUND');
    expect((await api.inject({ url: listPath, headers: owner.headers })).json().data.items).toHaveLength(2);
    const filtered = listPath + '?deviceId=' + deviceId;
    expect((await api.inject({ url: filtered, headers: secondPhone.headers })).json().data.items).toEqual([binding]);
    expect((await api.inject({ url: filtered, headers: other.headers })).json().data.items).toEqual([]);

    const detailPath = listPath + '/' + binding.bindingId;
    expect((await api.inject({ url: detailPath, headers: other.headers })).statusCode).toBe(404);
    const patch = { displayName: '会议用卡', generationMode: 'manual', transferMode: 'auto', transcriptionLanguage: 'auto' };
    const change = (user: Account, key: string) =>
      api.inject({ method: 'PATCH', url: detailPath, headers: writeHeaders(user, key), payload: patch });
    const end = (user: Account, key: string) => api.inject({ method: 'DELETE', url: detailPath, headers: writeHeaders(user, key) });
    expect((await change(other, randomUUID())).statusCode).toBe(404);
    expect((await end(other, randomUUID())).statusCode).toBe(404);
    const changeKey = randomUUID();
    expect((await change(secondPhone, changeKey)).json().data).toMatchObject(patch);
    expect((await api.inject({ url: detailPath, headers: owner.headers })).json().data).toMatchObject(patch);
    const endKey = randomUUID();
    const ended = await end(owner, endKey);
    expect(ended.statusCode).toBe(200);
    expect((await change(secondPhone, changeKey)).statusCode).toBe(404);
    expect((await api.inject({ url: detailPath, headers: owner.headers })).statusCode).toBe(404);
    expect((await api.inject({ url: filtered, headers: owner.headers })).json().data.items).toEqual([]);

    const next = await bind(other, proofFor(other, deviceId));
    expect(next.statusCode).toBe(200);
    const newBinding = next.json().data as RecorderBinding;
    expect(newBinding.bindingId).not.toBe(binding.bindingId);
    expect(newBinding.displayName).toBeNull();
    expect((await end(owner, endKey)).json().data).toEqual(ended.json().data);
    expect((await api.inject({ url: filtered, headers: other.headers })).json().data.items).toEqual([newBinding]);
    const history = await root.query('SELECT user_id, unbound_at FROM recorder_bindings WHERE device_id=$1 ORDER BY bound_at', [deviceId]);
    expect(history.rows).toEqual([{ user_id: owner.userId, unbound_at: expect.any(Date) }, { user_id: other.userId, unbound_at: null }]);
  });

  it('serializes first claims from different accounts for the same SN', async () => {
    const deviceId = randomUUID(), users = await Promise.all([account(), account()]);
    const results = await Promise.all(users.map(user => bind(user, proofFor(user, deviceId))));
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect((await root.query('SELECT binding_id FROM recorder_bindings WHERE device_id=$1 AND unbound_at IS NULL', [deviceId])).rowCount).toBe(1);
  });
});
