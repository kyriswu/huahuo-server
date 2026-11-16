import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { decodeJwt } from 'jose';
import type { AppConfig } from '../../config/config.js';
import type { IdentityService, TokenPair } from '../identity/service.js';
import { DomainError, type Scope } from '../identity/store.js';

export const studioAccessCookie = 'huahuo-studio-access';
export const studioRefreshCookie = 'huahuo-studio-refresh';
type Identity = Pick<IdentityService, 'authenticate' | 'refresh' | 'logout'>;
type StudioConfig = AppConfig['gatewayStudio'];

function cookieValue(header: string | undefined, name: string): string | undefined {
  const value = header?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value || value.length > 12_000) return undefined;
  try { return decodeURIComponent(value); } catch { return undefined; }
}

export function studioCookies(config: StudioConfig, tokens?: TokenPair): string[] {
  const attributes = `; HttpOnly; SameSite=Lax${config.origin.startsWith('https:') ? '; Secure' : ''}`;
  const expiredRoot = [studioAccessCookie, studioRefreshCookie].map(name => `${name}=; Path=/${attributes}; Max-Age=0`);
  const options = `; Path=${config.publicPath}${attributes}`;
  return [
    ...expiredRoot,
    `${studioAccessCookie}=${encodeURIComponent(tokens?.accessToken ?? '')}${options}; Max-Age=${tokens ? Math.max(1, Math.floor((Date.parse(tokens.accessTokenExpiresAt) - Date.now()) / 1_000)) : 0}`,
    `${studioRefreshCookie}=${encodeURIComponent(tokens?.refreshToken ?? '')}${options}; Max-Age=${tokens ? 30 * 24 * 60 * 60 : 0}`,
  ];
}

/** Cookie attributes remain owned by Server. Ingress copies these opaque
 * values into four Set-Cookie headers, including on denied navigation. */
export function studioAuthCookieHeaders(config: StudioConfig, tokens?: TokenPair): Record<string, string> {
  const names = ['X-Huahuo-Clear-Access-Cookie', 'X-Huahuo-Clear-Refresh-Cookie',
    'X-Huahuo-Studio-Access-Cookie', 'X-Huahuo-Studio-Refresh-Cookie'];
  return Object.fromEntries(studioCookies(config, tokens).map((value, index) => [names[index]!, value]));
}

/** Refresh deduplication stores only rotating token results. Every request still
 * checks the current account and session through IdentityService.authenticate. */
export class GatewaySession {
  private readonly refreshes = new Map<string, { expiresAt: number; result: Promise<TokenPair> }>();
  constructor(private readonly identity: Identity, readonly config: StudioConfig) {}

  assertOrigin(headers: IncomingHttpHeaders, method: string): void {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && headers.origin !== this.config.origin) {
      throw new DomainError(403, 'ORIGIN_INVALID');
    }
  }

  isStudioNavigation(headers: IncomingHttpHeaders): boolean {
    const method = headers['x-forwarded-method'], uri = headers['x-forwarded-uri'];
    if (!this.config.enabled || headers.authorization !== undefined || (method !== 'GET' && method !== 'HEAD')
      || !headers.accept?.toLowerCase().includes('text/html') || typeof uri !== 'string') return false;
    const path = uri.split('?')[0]!;
    if (path !== this.config.publicPath && !path.startsWith(`${this.config.publicPath}/`)) return false;
    const relative = path.slice(this.config.publicPath.length);
    return !/^\/(?:api|studio-auth|internal|assets)(?:\/|$)/u.test(relative) && !/\.[a-z0-9]+$/iu.test(relative);
  }

  async authenticate(headers: IncomingHttpHeaders, traceId: string, originalPath?: string): Promise<{ scope: Scope; method: 'bearer' | 'cookie'; tokens?: TokenPair }> {
    if (headers.authorization !== undefined) {
      return { scope: await this.identity.authenticate(headers.authorization, traceId), method: 'bearer' };
    }
    const uri = originalPath ?? headers['x-forwarded-uri'];
    const method = headers['x-forwarded-method'];
    if (!this.config.enabled || typeof uri !== 'string'
      || !(uri.split('?')[0] === this.config.publicPath || uri.startsWith(`${this.config.publicPath}/`))
      || typeof method !== 'string' || !/^[A-Z]+$/.test(method)) {
      throw new DomainError(401, 'UNAUTHORIZED');
    }
    this.assertOrigin(headers, method);
    const access = cookieValue(headers.cookie, studioAccessCookie);
    const refresh = cookieValue(headers.cookie, studioRefreshCookie);
    if (access) {
      try {
        const scope = await this.identity.authenticate(`Bearer ${access}`, traceId);
        const expiration = decodeJwt(access).exp;
        if (!refresh || (typeof expiration === 'number' && expiration * 1_000 - Date.now() > 45_000)) {
          return { scope, method: 'cookie' };
        }
      } catch (error) {
        // Availability failures must not rotate a token or pretend to be logout.
        if (!(error instanceof DomainError && error.statusCode === 401)) throw error;
      }
    }
    if (!refresh) throw new DomainError(401, 'AUTH_SESSION_EXPIRED');
    const key = createHash('sha256').update(refresh).digest('hex');
    for (const [id, entry] of this.refreshes) if (entry.expiresAt <= Date.now()) this.refreshes.delete(id);
    let entry = this.refreshes.get(key);
    if (!entry) {
      entry = { expiresAt: Date.now() + 60_000, result: this.identity.refresh(refresh, traceId) };
      this.refreshes.set(key, entry);
      const pending = entry;
      void pending.result.catch(() => {
        // A transient failure must not remain cached for the success replay
        // window. Do not remove a newer attempt that replaced this entry.
        if (this.refreshes.get(key) === pending) this.refreshes.delete(key);
      });
    }
    const tokens = await entry.result;
    return { scope: await this.identity.authenticate(`Bearer ${tokens.accessToken}`, traceId), method: 'cookie', tokens };
  }

  async logout(headers: IncomingHttpHeaders, traceId: string): Promise<void> {
    if (headers.authorization === undefined) this.assertOrigin(headers, 'POST');
    try {
      const { scope } = await this.authenticate({ ...headers, 'x-forwarded-method': 'POST' }, traceId, `${this.config.publicPath}/studio-auth/logout`);
      await this.identity.logout(scope);
    } catch (error) {
      // An invalid/expired credential must not trap the browser in a login loop.
      if (!(error instanceof DomainError && error.statusCode === 401)) throw error;
    } finally {
      const refresh = cookieValue(headers.cookie, studioRefreshCookie);
      if (refresh) this.refreshes.delete(createHash('sha256').update(refresh).digest('hex'));
    }
  }
}
