import type { IncomingHttpHeaders } from 'node:http';
import { DomainError, type Scope } from './store.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The gateway and trusted internal callers supply identity; business handlers
 * never turn a Bearer token or a request body into a user scope. */
export function readTrustedScope(headers: IncomingHttpHeaders, traceId: string): Scope {
  const userId = headers['x-huahuo-user-id'];
  const sessionId = headers['x-huahuo-session-id'];
  const method = headers['x-huahuo-auth-method'];
  if (typeof userId !== 'string' || !uuid.test(userId)
    || typeof sessionId !== 'string' || !uuid.test(sessionId)
    || (method !== 'bearer' && method !== 'cookie')) {
    throw new DomainError(401, 'UNAUTHORIZED');
  }
  return Object.freeze({ userId: userId.toLowerCase(), sessionId: sessionId.toLowerCase(), traceId });
}
