import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildBase } from '../../src/apps/base.js';
import { registerInternalRoutes } from '../../src/http/internal-routes.js';
import { registerRagRoutes } from '../../src/modules/rag/routes.js';
import type { RagQueryService } from '../../src/modules/rag/query-service.js';
import type { RagIngestionRepository } from '../../src/modules/rag/repository.js';
import type { IdentityService } from '../../src/modules/identity/service.js';
import type { DocumentCallbacks } from '../../src/modules/ingestion/document-callbacks.js';
import type { RuntimeSettings } from '../../src/modules/runtime-settings/service.js';
import { config, dependencies } from '../helpers.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function fixture() {
  const cfg = config(), app = await buildBase({ config: cfg, dependencies: dependencies() });
  apps.push(app);
  const query = vi.fn(async (_scope: unknown, input: { query: string }) => ({ mode: 'keyword', query: input.query, results: [] }));
  const service = { query } as unknown as RagQueryService;
  const callback = { authorize: vi.fn(), receive: vi.fn(async () => ({ accepted: true, duplicate: false })) };
  registerInternalRoutes(app, {
    identity: { config: cfg } as IdentityService, callbacks: callback as unknown as DocumentCallbacks,
    ragQuery: service, settings: { enter: async (done: () => void) => done() } as RuntimeSettings,
  });
  registerRagRoutes(app, {} as RagIngestionRepository, {} as never, service);
  const headers = { 'x-huahuo-user-id': randomUUID(), 'x-huahuo-session-id': randomUUID(), 'x-huahuo-auth-method': 'bearer', 'x-trace-id': 'contract-service-trace' };
  return { app, query, callback, headers };
}

describe('Server internal service contract with explicit business substitutes', () => {
  it('registers the business modules under one prefix and keeps their routes out of public OpenAPI', async () => {
    const { app } = await fixture();
    await app.ready();
    expect(app.hasRoute({ method: 'GET', url: '/internal/v1/gateway/auth' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/internal/v1/gateway/logout' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/internal/v1/rag/query' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/internal/v1/document-parser/callbacks/:id/:token' })).toBe(true);
    expect(Object.keys(app.swagger().paths ?? {}).filter(path => path.startsWith('/internal/'))).toEqual([]);
    expect(app.swagger().paths).toHaveProperty('/api/v1/rag/query');
  });

  it('uses the same RAG request and response contract for public and service callers', async () => {
    const { app, query, headers } = await fixture();
    for (const url of ['/api/v1/rag/query', '/internal/v1/rag/query']) {
      const response = await app.inject({ method: 'POST', url, headers, payload: { query: 'query', mode: 'keyword', topK: 7 } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ success: true, data: { mode: 'keyword', query: 'query', results: [] }, traceId: headers['x-trace-id'] });
      expect(response.headers['cache-control']).toBe('no-store');
      for (const payload of [{ query: 'query', userId: randomUUID() }, { query: 'query', topK: 51 }]) {
        expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(400);
      }
    }
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![0]).toEqual(query.mock.calls[1]![0]);
  });

  it('does not accept a user identity or a second authentication scheme in place of trusted headers', async () => {
    const { app, query } = await fixture();
    const response = await app.inject({ method: 'POST', url: '/internal/v1/rag/query', headers: { authorization: 'Bearer fixture', 'x-service-key': 'fixture' }, payload: { query: 'query' } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    expect(query).not.toHaveBeenCalled();
  });

  it('registers only the internal callback address generated for the parser', async () => {
    const { app, callback } = await fixture(), suffix = `${randomUUID()}/${'t'.repeat(43)}`;
    expect((await app.inject({ method: 'POST', url: '/api/v1/document-parser/callbacks/' + suffix, payload: {} })).statusCode).toBe(404);
    expect(callback.authorize).not.toHaveBeenCalled();
    const response = await app.inject({ method: 'POST', url: '/internal/v1/document-parser/callbacks/' + suffix, payload: {} });
    expect(response.statusCode, response.body).toBe(200);
    expect(callback.authorize).toHaveBeenCalledOnce();
    expect(callback.receive).toHaveBeenCalledOnce();
  });
});
