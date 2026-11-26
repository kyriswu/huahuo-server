import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readTrustedScope } from '../modules/identity/trusted-scope.js';
import type { RuntimeSettings } from '../modules/runtime-settings/service.js';

export const INTERNAL_API_PREFIX = '/internal/v1';
type Authorize = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export type InternalApiPolicy =
  | { auth: 'trusted-scope'; runtimeSettings?: true }
  | { auth: 'gateway-session' | 'parser-capability' | 'signed-provider'; authorize: Authorize };

declare module 'fastify' { interface FastifyContextConfig { internalApi?: InternalApiPolicy } }

/** Only the internal registrar owns this scope. Each business supplies its routes
 * and domain authorization; user identity and request settings are shared here. */
export function registerInternalApi(app: FastifyInstance, routes: (internal: FastifyInstance) => void,
  settings?: Pick<RuntimeSettings, 'enter'>) {
  void app.register(async internal => {
    internal.addHook('onRoute', route => {
      const policy = route.config?.internalApi;
      if (!policy || !['trusted-scope','gateway-session','parser-capability','signed-provider'].includes(policy.auth)
        || policy.auth !== 'trusted-scope' && typeof policy.authorize !== 'function'
        || policy.auth === 'trusted-scope' && policy.runtimeSettings && !settings) {
        throw new Error('INTERNAL_API_POLICY_REQUIRED');
      }
      route.schema = { ...route.schema, hide: true, tags: ['internal'] };
    });
    internal.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const policy = request.routeOptions.config.internalApi;
      if (!policy) return;
      if (policy.auth === 'trusted-scope') request.authScope = readTrustedScope(request.headers, request.id);
      else if (policy.auth !== 'gateway-session') await policy.authorize(request, reply);
    });
    // Gateway authorization may rotate/revoke sessions; validate its request first.
    // Parser capabilities must be checked before accepting a large callback body.
    internal.addHook('preHandler', async (request, reply) => {
      const policy = request.routeOptions.config.internalApi;
      if (policy?.auth === 'gateway-session') await policy.authorize(request, reply);
    });
    internal.addHook('onRequest', (request, _reply, done) => {
      const policy = request.routeOptions.config.internalApi;
      if (policy?.auth === 'trusted-scope' && policy.runtimeSettings) void settings!.enter(done);
      else done();
    });
    routes(internal);
  }, { prefix: INTERNAL_API_PREFIX });
}
