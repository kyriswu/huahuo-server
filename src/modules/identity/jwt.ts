import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { decodeProtectedHeader, exportJWK, importPKCS8, importSPKI, jwtVerify, SignJWT, type JWK, type JWTPayload } from 'jose';

type KeyLike = KeyObject | CryptoKey;

export interface JwtSettings {
  issuer: string;
  audience: string[];
  serverAudience: string;
  keyId: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  privateKeyPem?: string;
  publicKeyPem?: string;
}

export interface AccessClaims {
  sub: string;
  jti: string;
  iss: string;
  aud: string | string[];
  iat: number;
  exp: number;
}

export interface LoadedJwtKeys {
  privateKey: KeyLike;
  publicKey: KeyLike;
  keyId: string;
}

export async function loadEd25519Keys(settings: JwtSettings): Promise<LoadedJwtKeys> {
  if ((settings.privateKeyPem && !settings.publicKeyPem) || (!settings.privateKeyPem && settings.publicKeyPem)) {
    throw new Error('JWT_KEY_PAIR_INCOMPLETE');
  }
  const pair = settings.privateKeyPem && settings.publicKeyPem
    ? { privateKey: await importPKCS8(settings.privateKeyPem, 'EdDSA'), publicKey: await importSPKI(settings.publicKeyPem, 'EdDSA') }
    : generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    keyId: settings.keyId,
  };
}

export async function signAccessToken(
  privateKey: KeyLike,
  settings: JwtSettings,
  userId: string,
  sessionId: string,
): Promise<{ token: string; expiresAt: string }> {
  const expiresAt = new Date(Date.now() + settings.accessTtlSeconds * 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: settings.keyId })
    .setSubject(userId)
    .setIssuer(settings.issuer)
    .setAudience(settings.audience)
    .setIssuedAt()
    .setJti(sessionId)
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(privateKey);
  return { token, expiresAt: expiresAt.toISOString() };
}

export async function verifyAccessToken(keys: LoadedJwtKeys, settings: JwtSettings, token: string): Promise<AccessClaims> {
  const header = decodeProtectedHeader(token);
  if (header.alg !== 'EdDSA' || typeof header.kid !== 'string' || !header.kid) throw new Error('JWT_HEADER_INVALID');
  const publicKey = header.kid === keys.keyId ? keys.publicKey : undefined;
  if (!publicKey) throw new Error('JWT_KEY_UNKNOWN');
  const result = await jwtVerify(token, publicKey, {
    algorithms: ['EdDSA'],
    issuer: settings.issuer,
    audience: settings.serverAudience,
    requiredClaims: ['sub', 'iss', 'aud', 'iat', 'exp', 'jti'],
  });
  const payload: JWTPayload = result.payload;
  if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.jti !== 'string' || !payload.jti || typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
    throw new Error('JWT_CLAIMS_INVALID');
  }
  return payload as AccessClaims;
}

export async function publicJwks(keys: LoadedJwtKeys): Promise<{ keys: JWK[] }> {
  const current = await exportJWK(keys.publicKey);
  const entries: JWK[] = [{ ...current, kid: keys.keyId, alg: 'EdDSA', use: 'sig', key_ops: ['verify'] }];
  return { keys: entries };
}

