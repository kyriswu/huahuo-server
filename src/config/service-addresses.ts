import type { Env } from './config.js';

/** API address visible to other services, independent of this process's listen address. */
export function loadApiServiceBaseUrl(env: Env): string | undefined {
  const value = env.API_SERVICE_BASE_URL?.trim() || env.APP_PUBLIC_BASE_URL?.trim();
  if (!value) return;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash)
      throw new Error('INVALID_ADDRESS');
    return url.href.replace(/\/+$/, '');
  } catch { throw new Error('INVALID_CONFIG:API_SERVICE_BASE_URL'); }
}
