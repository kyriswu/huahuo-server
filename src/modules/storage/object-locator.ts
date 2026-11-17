import type { AppConfig } from '../../config/config.js';
import { DomainError } from '../identity/store.js';

/** A trusted host/path locator only; ownership still comes from the resource lookup. */
export function ownedObjectKey(value: string, config: AppConfig): string | undefined {
  const oss = config.storageAliyunOss;
  if (config.storageDriver !== 'aliyun-oss' || !oss) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  const endpoints = [oss.endpoint, oss.publicEndpoint].filter(Boolean).map(endpoint => new URL(endpoint!));
  const matching = endpoints.filter(endpoint => url.hostname ===
    (endpoint.hostname.startsWith(oss.bucket + '.') ? endpoint.hostname : `${oss.bucket}.${endpoint.hostname}`));
  if (!matching.length) return undefined;
  if (url.username || url.password || !matching.some(endpoint => url.protocol === endpoint.protocol && url.port === endpoint.port)) {
    throw new DomainError(400, 'RESOURCE_URL_INVALID');
  }
  let path: string;
  try { path = decodeURIComponent(url.pathname).replace(/^\//u, ''); }
  catch { throw new DomainError(400, 'RESOURCE_URL_INVALID'); }
  const prefix = oss.keyPrefix?.replace(/^\/+|\/+$/gu, '') ?? '';
  if (path.includes('\\') || path.includes('//') || path.split('/').some(part => part === '..' || part === '.')
    || (prefix && !path.startsWith(prefix + '/')) || url.searchParams.has('x-oss-process')) throw new DomainError(400, 'RESOURCE_URL_INVALID');
  return prefix ? path.slice(prefix.length + 1) : path;
}
