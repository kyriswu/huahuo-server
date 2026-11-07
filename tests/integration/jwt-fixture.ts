import { loadEd25519Keys, signAccessToken } from '../../src/modules/identity/jwt.js';
import { createHash, randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import type pg from 'pg';

// Test-only Ed25519 pair. Production keys are supplied through environment variables.
export const testJwtEnv = {
  APP_JWT_PRIVATE_KEY: 'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1DNENBUUF3QlFZREsyVndCQ0lFSU81Vk1iZVRrUStNS3BzSit6a2pPQTY4cUhQb1FtbzF0NzJIV0lkZTNmRm4KLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQo=',
  APP_JWT_PUBLIC_KEY: 'LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUNvd0JRWURLMlZ3QXlFQWVuMTBYTDgrZGJrWjZrUE1qSzhzQzBVRkp6TWpHWG5acmd5VE9ldFFwK0U9Ci0tLS0tRU5EIFBVQkxJQyBLRVktLS0tLQo=',
  APP_JWT_AUDIENCE: 'huahuo-server,huahuo-agent',
  APP_JWT_SERVER_AUDIENCE: 'huahuo-server',
  APP_JWT_KEY_ID: 'test-current',
};

export async function fixtureAccessToken(userId: string, sessionId: string): Promise<string> {
  const settings = { issuer: 'huahuo-server', audience: ['huahuo-server', 'huahuo-agent'], serverAudience: 'huahuo-server', keyId: 'test-current', accessTtlSeconds: 900, refreshTtlSeconds: 2_592_000 };
  const keys = await loadEd25519Keys({ ...settings, privateKeyPem: Buffer.from(testJwtEnv.APP_JWT_PRIVATE_KEY, 'base64').toString('utf8'), publicKeyPem: Buffer.from(testJwtEnv.APP_JWT_PUBLIC_KEY, 'base64').toString('utf8') });
  return (await signAccessToken(keys.privateKey, settings, userId, sessionId)).token;
}

/** Business fixtures use the same user/session schema as real sign-in. */
export async function insertFixtureUser(pool: pg.Pool, userId: string = randomUUID()): Promise<string> {
  await pool.query('INSERT INTO users(id) VALUES($1)', [userId]);
  return userId;
}

export async function insertFixtureSession(pool: pg.Pool, userId: string, sessionId: string = randomUUID(), clientId = 'integration-fixture'): Promise<string> {
  const bearer = await fixtureAccessToken(userId, sessionId);
  const claims = decodeJwt(bearer);
  if (!claims.jti || !claims.exp) throw new Error('FIXTURE_JWT_CLAIMS_REQUIRED');
  await pool.query(`INSERT INTO user_sessions(id,user_id,client_type,client_id,access_jti,access_hash,access_expires_at,expires_at)
    VALUES($1,$2,'app',$3,$4,$5,$6,now()+interval '1 day')`,
  [sessionId,userId,clientId,claims.jti,createHash('sha256').update(bearer).digest('hex'),new Date(claims.exp*1000)]);
  return bearer;
}

