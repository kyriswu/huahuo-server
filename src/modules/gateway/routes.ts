import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { ErrorSchema } from '../../contracts/envelope.js';
import type { IdentityService } from '../identity/service.js';
import { GatewaySession, studioAuthCookieHeaders, studioCookies } from './studio-session.js';
import { DomainError } from '../identity/store.js';

/** The ingress auth subrequest calls this body-less GET before forwarding a protected
 * request. This is the only user-token authentication boundary. Business
 * handlers consume the resulting scope and enforce resource ownership. */
export function registerGatewayAuthRoute(app: FastifyInstance, identity: IdentityService) {
  const session = new GatewaySession(identity, identity.config.gatewayStudio);
  const authenticated = new WeakMap<FastifyRequest, Awaited<ReturnType<GatewaySession['authenticate']>>>();
  app.get('/gateway/auth', {
    config: { internalApi: { auth: 'gateway-session', authorize: async (request, reply) => {
      try { authenticated.set(request, await session.authenticate(request.headers, request.id)); }
      catch (error) {
        if (error instanceof DomainError && error.statusCode === 401 && session.isStudioNavigation(request.headers)) {
          reply.headers(studioAuthCookieHeaders(session.config));
          reply.header('X-Huahuo-Login-Redirect', `${session.config.publicPath}/studio-login`);
        }
        throw error;
      }
    } } },
    schema: {
      hide: true,
      querystring: Type.Object({}, { additionalProperties: false }),
      response: { 204: Type.Null(), 401: ErrorSchema, 403: ErrorSchema, 500: ErrorSchema, 503: ErrorSchema },
    },
  }, async (request, reply) => {
    const result = authenticated.get(request)!;
    reply.header('X-Huahuo-User-Id', result.scope.userId);
    reply.header('X-Huahuo-Session-Id', result.scope.sessionId);
    reply.header('X-Huahuo-Auth-Method', result.method);
    reply.header('X-Trace-Id', result.scope.traceId);
    // Separate headers preserve all cookies through a native auth subrequest.
    // Logout is a normal response and continues to use Set-Cookie directly.
    if (result.tokens) reply.headers(studioAuthCookieHeaders(session.config, result.tokens));
    return reply.code(204).send();
  });
  // A dedicated route lets an expired browser clear its cookies. The ingress
  // maps only POST /agent/studio-auth/logout here, without an auth subrequest.
  app.post('/gateway/logout', {
    config: { internalApi: { auth: 'gateway-session', authorize: async (request, reply) => {
      if (request.headers.authorization === undefined) session.assertOrigin(request.headers, 'POST');
      try { await session.logout(request.headers, request.id); }
      finally { reply.header('Set-Cookie', studioCookies(session.config)); }
    } } },
    schema: { hide: true, querystring: Type.Object({}, { additionalProperties: false }),
      response: { 200: Type.Object({ signedOut: Type.Literal(true) }), 403: ErrorSchema, 500: ErrorSchema, 503: ErrorSchema } },
  }, async () => ({ signedOut: true as const }));
}
