import { describe, expect, it } from 'vitest';
import { loadEd25519Keys, publicJwks, signAccessToken, verifyAccessToken } from '../../src/modules/identity/jwt.js';

describe('JWT access tokens', () => {
  it('signs and validates required claims', async () => {
    const settings = { issuer: 'huahuo-server', audience: ['huahuo-server', 'huahuo-agent'], serverAudience: 'huahuo-server', keyId: 'test-current', accessTtlSeconds: 900, refreshTtlSeconds: 2_592_000 };
    const keys = await loadEd25519Keys(settings);
    const signed = await signAccessToken(keys.privateKey, settings, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
    const claims = await verifyAccessToken(keys, settings, signed.token);
    expect(claims).toMatchObject({ sub: '00000000-0000-0000-0000-000000000001', jti: '00000000-0000-0000-0000-000000000002', iss: settings.issuer, aud: settings.audience });
    expect(signed.expiresAt).toBeTruthy();
  });

  it('rejects tampered tokens and issuer/audience mismatches', async () => {
    const settings = { issuer: 'huahuo-server', audience: ['huahuo-server', 'huahuo-agent'], serverAudience: 'huahuo-server', keyId: 'test-current', accessTtlSeconds: 900, refreshTtlSeconds: 2_592_000 };
    const keys = await loadEd25519Keys(settings);
    const signed = await signAccessToken(keys.privateKey, settings, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
    const parts = signed.token.split('.');
    parts[2] = `${parts[2]!.startsWith('A') ? 'B' : 'A'}${parts[2]!.slice(1)}`;
    await expect(verifyAccessToken(keys, settings, parts.join('.'))).rejects.toThrow();
    await expect(verifyAccessToken(keys, { ...settings, issuer: 'other' }, signed.token)).rejects.toThrow();
    await expect(verifyAccessToken(keys, { ...settings, serverAudience: 'other' }, signed.token)).rejects.toThrow();
  });

  it('rejects expired access tokens', async () => {
    const settings = { issuer: 'huahuo-server', audience: ['huahuo-server', 'huahuo-agent'], serverAudience: 'huahuo-server', keyId: 'test-current', accessTtlSeconds: -1, refreshTtlSeconds: 2_592_000 };
    const keys = await loadEd25519Keys(settings);
    const signed = await signAccessToken(keys.privateKey, settings, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
    await expect(verifyAccessToken(keys, { ...settings, accessTtlSeconds: 900 }, signed.token)).rejects.toThrow();
  });

  it('publishes the active verification key as JWKS and requires kid', async () => {
    const settings = { issuer: 'huahuo-server', audience: ['huahuo-server', 'huahuo-agent'], serverAudience: 'huahuo-server', keyId: 'test-current', accessTtlSeconds: 900, refreshTtlSeconds: 2_592_000 };
    const keys = await loadEd25519Keys(settings);
    const jwks = await publicJwks(keys);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kid: 'test-current', alg: 'EdDSA', use: 'sig', key_ops: ['verify'], crv: 'Ed25519' });
    const signed = await signAccessToken(keys.privateKey, settings, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
    const [header, payload, signature] = signed.token.split('.');
    const parsed = JSON.parse(Buffer.from(header!, 'base64url').toString('utf8')) as Record<string, unknown>;
    delete parsed.kid;
    const noKid = `${Buffer.from(JSON.stringify(parsed)).toString('base64url')}.${payload}.${signature}`;
    await expect(verifyAccessToken(keys, settings, noKid)).rejects.toThrow();
  });

  it('rejects tokens from a retired key', async () => {
    const settings = { issuer: 'huahuo-server', audience: ['huahuo-server'], serverAudience: 'huahuo-server', keyId: 'current', accessTtlSeconds: 900, refreshTtlSeconds: 2_592_000 };
    const keys = await loadEd25519Keys(settings);
    const retired = await loadEd25519Keys({ ...settings, keyId: 'retired' });
    const signed = await signAccessToken(retired.privateKey, { ...settings, keyId: 'retired' }, 'user', 'session');
    await expect(verifyAccessToken(keys, settings, signed.token)).rejects.toThrow('JWT_KEY_UNKNOWN');
    expect((await publicJwks(keys)).keys.map(key => key.kid)).toEqual(['current']);
  });
});
