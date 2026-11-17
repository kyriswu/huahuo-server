import { failure } from '../../src/contracts/envelope.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { GatewaySession, studioAuthCookieHeaders, studioCookies } from '../../src/modules/gateway/studio-session.js';
import { registerInternalApi } from '../../src/http/internal-api.js';
import { registerGatewayAuthRoute } from '../../src/modules/gateway/routes.js';
import { readTrustedScope } from '../../src/modules/identity/trusted-scope.js';
import { DomainError } from '../../src/modules/identity/store.js';
import type { IdentityService } from '../../src/modules/identity/service.js';
import { config, env } from '../helpers.js';
import { loadConfig } from '../../src/config/config.js';

const userId = randomUUID(), sessionId = randomUUID();
const scope = { userId, sessionId, traceId: 'gateway-unit' };
const studio = { enabled: true, origin: 'https://api.example.test', publicPath: '/agent' };
const jwt = (seconds: number) => `e30.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url')}.signature`;
const forwarded = { 'x-forwarded-uri': '/agent/api/agents/huox', 'x-forwarded-method': 'GET' };
const access = jwt(300), expired = jwt(-10), next = jwt(900);
const pair = { tokenType: 'Bearer' as const, accessToken: next, refreshToken: 'refresh_next', accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), expiresIn: 900, rotated: true };
function identity() {
  return {
    config: { ...config(), gatewayStudio: studio },
    authenticate: vi.fn(async (authorization: string | undefined) => {
      if (authorization !== `Bearer ${access}` && authorization !== `Bearer ${next}`) throw new DomainError(401, 'AUTH_TOKEN_INVALID');
      return scope;
    }),
    refresh: vi.fn(async () => pair),
    logout: vi.fn(async () => ({ revoked: true, scope: 'current' })),
  };
}
afterEach(() => vi.restoreAllMocks());

describe('trusted business identity', () => {
  it('accepts only a complete scope and never falls back to a Bearer or ServiceKey', () => {
    const headers = { 'x-huahuo-user-id': userId, 'x-huahuo-session-id': sessionId, 'x-huahuo-auth-method': 'bearer' };
    expect(readTrustedScope(headers, 'trace')).toEqual({ userId, sessionId, traceId: 'trace' });
    expect(Object.isFrozen(readTrustedScope(headers, 'trace'))).toBe(true);
    for (const value of [{}, { authorization: `Bearer ${access}` }, { 'x-huahuo-service-key': 'retired' },
      { ...headers, 'x-huahuo-user-id': `${userId},${userId}` }, { ...headers, 'x-huahuo-session-id': [sessionId] },
      { ...headers, 'x-huahuo-auth-method': undefined }, { ...headers, 'x-huahuo-session-id': 'invalid' }, { ...headers, 'x-huahuo-auth-method': 'admin' }]) {
      expect(() => readTrustedScope(value, 'trace')).toThrow('UNAUTHORIZED');
    }
  });
});

describe('gateway admission and Studio refresh', () => {
  it('outputs the authenticated scope rather than forged incoming identity headers', async () => {
    const id = identity(), app = Fastify();
    registerInternalApi(app, internal => registerGatewayAuthRoute(internal, id as unknown as IdentityService));
    try {
      const result = await app.inject({ url: '/internal/v1/gateway/auth', headers: { authorization: `Bearer ${access}`, 'x-huahuo-user-id': randomUUID() } });
      expect(result.statusCode).toBe(204);
      expect(result.headers).toMatchObject({ 'x-huahuo-user-id': userId, 'x-huahuo-session-id': sessionId, 'x-huahuo-auth-method': 'bearer', 'cache-control': 'no-store' });
      expect(id.authenticate).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });
  it('rejects malformed gateway requests before refreshing or revoking sessions', async () => {
    const id = identity(), app = Fastify({ajv:{customOptions:{removeAdditional:false}}});
    registerInternalApi(app, internal => registerGatewayAuthRoute(internal, id as unknown as IdentityService));
    try {
      const auth = await app.inject({url:'/internal/v1/gateway/auth?unexpected=true',headers:{...forwarded,cookie:`huahuo-studio-access=${expired}; huahuo-studio-refresh=refresh_old`}});
      expect(auth.statusCode).toBe(400);expect(auth.headers['set-cookie']).toBeUndefined();
      const logout = await app.inject({method:'POST',url:'/internal/v1/gateway/logout',headers:{origin:studio.origin,cookie:`huahuo-studio-access=${access}`,'content-type':'application/json'},payload:'{malformed'});
      expect(logout.statusCode).toBe(400);expect(logout.headers['set-cookie']).toBeUndefined();
      expect(id.authenticate).not.toHaveBeenCalled();expect(id.refresh).not.toHaveBeenCalled();expect(id.logout).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('keeps Bearer priority and does not refresh a bad Bearer using browser cookies', async () => {
    const id = identity(), gateway = new GatewaySession(id, studio);
    await expect(gateway.authenticate({ ...forwarded, authorization: 'Bearer invalid', cookie: `huahuo-studio-access=${access}; huahuo-studio-refresh=refresh_old` }, 'trace')).rejects.toThrow('AUTH_TOKEN_INVALID');
    expect(id.refresh).not.toHaveBeenCalled();
  });
  it('validates active cookie sessions on every request without caching admission', async () => {
    const id = identity(), gateway = new GatewaySession(id, studio), headers = { ...forwarded, cookie: `huahuo-studio-access=${access}` };
    expect(await gateway.authenticate(headers, 'trace')).toMatchObject({ method: 'cookie', scope });
    id.authenticate.mockRejectedValueOnce(new DomainError(401, 'AUTH_SESSION_EXPIRED'));
    await expect(gateway.authenticate(headers, 'trace')).rejects.toThrow('AUTH_SESSION_EXPIRED');
    expect(id.authenticate).toHaveBeenCalledTimes(2);
  });
  it('refreshes expired/near-expiry cookies once under concurrency and rechecks the session each time', async () => {
    const id = identity(), gateway = new GatewaySession(id, studio);
    const headers = { ...forwarded, cookie: `huahuo-studio-access=${expired}; huahuo-studio-refresh=refresh_old` };
    const results = await Promise.all(Array.from({ length: 4 }, () => gateway.authenticate(headers, 'trace')));
    expect(id.refresh).toHaveBeenCalledOnce();
    expect(results.every(result => result.tokens === pair)).toBe(true);
    expect(id.authenticate.mock.calls.filter(([token]) => token === `Bearer ${next}`)).toHaveLength(4);
    id.authenticate.mockRejectedValue(new DomainError(401, 'AUTH_SESSION_EXPIRED'));
    await expect(gateway.authenticate(headers, 'trace')).rejects.toThrow('AUTH_SESSION_EXPIRED');
  });
  it('does not refresh on database/unexpected failures', async () => {
    const id = identity(), gateway = new GatewaySession(id, studio);
    id.authenticate.mockRejectedValue(new Error('database-unavailable'));
    await expect(gateway.authenticate({ ...forwarded, cookie: `huahuo-studio-access=${access}; huahuo-studio-refresh=refresh_old` }, 'trace')).rejects.toThrow('database-unavailable');
    expect(id.refresh).not.toHaveBeenCalled();
  });
  it('does not cache a failed refresh after the dependency recovers', async () => {
    const id = identity(), gateway = new GatewaySession(id, studio);
    const headers = { ...forwarded, cookie: `huahuo-studio-access=${expired}; huahuo-studio-refresh=refresh_old` };
    id.refresh.mockRejectedValueOnce(new Error('temporary-unavailability'));
    await expect(gateway.authenticate(headers, 'trace')).rejects.toThrow('temporary-unavailability');
    await expect(gateway.authenticate(headers, 'trace')).resolves.toMatchObject({ tokens: pair });
    expect(id.refresh).toHaveBeenCalledTimes(2);
  });
  it('refreshes an otherwise valid access cookie before it expires', async () => {
    const id = identity(), gateway = new GatewaySession(id, studio), nearExpiry = jwt(30);
    id.authenticate.mockResolvedValue(scope);
    await expect(gateway.authenticate({ ...forwarded, cookie: `huahuo-studio-access=${nearExpiry}; huahuo-studio-refresh=refresh_old` }, 'trace')).resolves.toMatchObject({ tokens: pair });
    expect(id.refresh).toHaveBeenCalledOnce();
  });
  it('does not reuse admission after a refreshed session is logged out or disabled', async () => {
    const id = identity(), gateway = new GatewaySession(id, studio);
    const oldCookies = `huahuo-studio-access=${expired}; huahuo-studio-refresh=refresh_old`;
    await gateway.authenticate({ ...forwarded, cookie: oldCookies }, 'trace');
    await gateway.logout({ origin: studio.origin, cookie: `huahuo-studio-access=${next}; huahuo-studio-refresh=${pair.refreshToken}` }, 'trace');
    expect(id.logout).toHaveBeenCalledWith(scope);
    id.authenticate.mockRejectedValue(new DomainError(401, 'AUTH_SESSION_EXPIRED'));
    // Even a still-deduplicated refresh result must pass a fresh session check.
    await expect(gateway.authenticate({ ...forwarded, cookie: oldCookies }, 'trace')).rejects.toThrow('AUTH_SESSION_EXPIRED');
    expect(id.refresh).toHaveBeenCalledOnce();
  });
  it('returns a denied subrequest with a redirect hint only for unauthenticated Studio navigation', async () => {
    const id = identity(), app = Fastify();
    app.setErrorHandler((error, request, reply) => reply.code(error instanceof DomainError ? error.statusCode : 500).send(failure(error instanceof DomainError ? error.code : 'INTERNAL_ERROR', 'Authentication failed', request.id)));
    registerInternalApi(app, internal => registerGatewayAuthRoute(internal, id as unknown as IdentityService));
    try {
      const headers = { ...forwarded, 'x-forwarded-uri': '/agent/agents/huox', accept: 'text/html' };
      const page = await app.inject({ url: '/internal/v1/gateway/auth', headers });
      expect(page.statusCode).toBe(401);
      expect(page.headers['x-huahuo-login-redirect']).toBe('/agent/studio-login');
      expect(page.headers.location).toBeUndefined();
      expect(page.headers['set-cookie']).toBeUndefined();
      for (const [name, value] of Object.entries(studioAuthCookieHeaders(studio))) expect(page.headers[name.toLowerCase()]).toBe(value);
      for (const path of ['/agent/api/agents/huox', '/agent/studio-auth/session', '/agent/assets/index.js', '/agent/favicon.ico', '/other']) {
        const result = await app.inject({ url: '/internal/v1/gateway/auth', headers: { ...headers, 'x-forwarded-uri': path } });
        expect(result.statusCode).toBe(401); expect(result.headers['x-huahuo-login-redirect']).toBeUndefined();
      }
      const invalidBearer = await app.inject({ url: '/internal/v1/gateway/auth', headers: { ...headers, authorization: 'Bearer invalid' } });
      expect(invalidBearer.statusCode).toBe(401);
      expect(invalidBearer.headers['x-huahuo-login-redirect']).toBeUndefined();
      id.authenticate.mockRejectedValue(new DomainError(503, 'DATABASE_UNAVAILABLE'));
      const unavailable = await app.inject({ url: '/internal/v1/gateway/auth', headers: { ...headers, cookie: `huahuo-studio-access=${access}` } });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.headers['x-huahuo-login-redirect']).toBeUndefined();
      expect(unavailable.headers['x-huahuo-studio-access-cookie']).toBeUndefined();
    } finally { await app.close(); }
  });
  it('returns every refreshed cookie as a separate opaque auth header without exposing tokens to business requests', async () => {
    const id = identity(), app = Fastify();
    registerInternalApi(app, internal => registerGatewayAuthRoute(internal, id as unknown as IdentityService));
    try {
      const result = await app.inject({ url: '/internal/v1/gateway/auth', headers: {
        ...forwarded, cookie: `huahuo-studio-access=${expired}; huahuo-studio-refresh=refresh_old`,
      } });
      expect(result.statusCode).toBe(204);
      expect(result.headers['set-cookie']).toBeUndefined();
      expect(result.headers['x-huahuo-auth-method']).toBe('cookie');
      for (const [name, value] of Object.entries(studioAuthCookieHeaders(studio, pair))) expect(result.headers[name.toLowerCase()]).toBe(value);
    } finally { await app.close(); }
  });
  it('requires the configured Studio path, enabled environment, and same origin for cookie writes', async () => {
    const id = identity(), gateway = new GatewaySession(id, studio), cookie = `huahuo-studio-access=${access}`;
    for (const path of ['/api/v1/me/status', '/agent-other/api', 'https://example.test/agent/api']) {
      await expect(gateway.authenticate({ ...forwarded, 'x-forwarded-uri': path, cookie }, 'trace')).rejects.toThrow('UNAUTHORIZED');
    }
    await expect(new GatewaySession(id, { ...studio, enabled: false }).authenticate({ ...forwarded, cookie }, 'trace')).rejects.toThrow('UNAUTHORIZED');
    await expect(gateway.authenticate({ ...forwarded, 'x-forwarded-method': 'POST', origin: 'https://other.test', cookie }, 'trace')).rejects.toThrow('ORIGIN_INVALID');
    await expect(gateway.authenticate({ ...forwarded, 'x-forwarded-method': 'POST', origin: studio.origin, cookie }, 'trace')).resolves.toMatchObject({ scope });
  });
  it('clears expired browser cookies at logout and revokes valid sessions', async () => {
    const id = identity(), app = Fastify();
    app.setErrorHandler((error, request, reply) => reply.code(error instanceof DomainError ? error.statusCode : 500).send(failure(error instanceof DomainError ? error.code : 'INTERNAL_ERROR', 'Authentication failed', request.id)));
    registerInternalApi(app, internal => registerGatewayAuthRoute(internal, id as unknown as IdentityService));
    try {
      const valid = await app.inject({ method: 'POST', url: '/internal/v1/gateway/logout', headers: { origin: studio.origin, cookie: `huahuo-studio-access=${access}` } });
      expect(valid.statusCode).toBe(200); expect(valid.json()).toEqual({ signedOut: true });
      expect(id.logout).toHaveBeenCalledWith(scope);
      const invalid = await app.inject({ method: 'POST', url: '/internal/v1/gateway/logout', headers: { origin: studio.origin, cookie: `huahuo-studio-access=${expired}` } });
      expect(invalid.statusCode).toBe(200);
      expect(invalid.headers['set-cookie']).toHaveLength(4);
      expect((invalid.headers['set-cookie'] as string[]).every(value => value.includes('Max-Age=0'))).toBe(true);
      const foreign = await app.inject({ method: 'POST', url: '/internal/v1/gateway/logout', headers: { origin: 'https://other.test' } });
      expect(foreign.statusCode).toBe(403); expect(foreign.headers['set-cookie']).toBeUndefined();
    } finally { await app.close(); }
  });
  it('uses scoped secure cookies and retires legacy root-path cookies', () => {
    const cookies = studioCookies(studio, pair);
    expect(cookies).toHaveLength(4);
    expect(cookies.slice(0, 2).every(value => value.includes('Path=/;') && value.includes('Max-Age=0'))).toBe(true);
    expect(cookies.slice(2).every(value => value.includes('Path=/agent; HttpOnly; SameSite=Lax; Secure'))).toBe(true);
  });
  it('validates Studio gateway configuration without any service keys', () => {
    expect(loadConfig('api-server', { ...env, HUAHUO_STUDIO_AUTH_ENABLED: 'true' }).gatewayStudio).toEqual({ enabled: true, origin: 'http://localhost:3000', publicPath: '/agent' });
    for (const patch of [{ HUAHUO_STUDIO_AUTH_ENABLED: 'invalid' }, { HUAHUO_AGENT_PUBLIC_PATH: '/agent/' }, { HUAHUO_AGENT_PUBLIC_PATH: '//other' }, { HUAHUO_STUDIO_ORIGIN: 'https://api.test/agent' }]) {
      expect(() => loadConfig('api-server', { ...env, ...patch })).toThrow('INVALID_CONFIG:');
    }
  });
});
