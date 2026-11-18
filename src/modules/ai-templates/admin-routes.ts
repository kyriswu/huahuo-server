import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';

import { ErrorSchema, success } from '../../contracts/envelope.js';
import type { AdminScope } from '../admin/service.js';
import { Envelope, Strict } from '../identity/schemas.js';
import type { AiTemplateCatalog } from './catalog.js';
import { CatalogSchema, SceneKeySchema, type Catalog, type SceneKey } from './model.js';

const revision = Type.Integer({ minimum: 1 });
const params = Type.Object({ sceneKey: SceneKeySchema }, Strict);
const path = '/admin/api/v1/ai-template-scenes/:sceneKey';
const editBody = Type.Object({ draftRevision: revision, catalog: CatalogSchema }, Strict);
const response = {
  200: Envelope(Type.Object({
    sceneKey: SceneKeySchema,
    draft: CatalogSchema,
    draftRevision: revision,
    publishedRevision: revision,
    hasUnpublishedDraft: Type.Boolean(),
    variables: Type.Array(Type.String()),
    history: Type.Array(Type.Object({
      version: revision,
      publishedAt: Type.String(),
      restoredFrom: Type.Union([revision, Type.Null()]),
    })),
  })),
  400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 503: ErrorSchema,
};

export function registerAiTemplateAdminRoutes(
  app: FastifyInstance, catalog: AiTemplateCatalog,
  guard: {
    auth: (req: FastifyRequest) => Promise<void>;
    csrf: (req: FastifyRequest) => Promise<void>;
    scope: (req: FastifyRequest) => AdminScope;
  },
) {
  const scene = (req: FastifyRequest) => (req.params as { sceneKey: SceneKey }).sceneKey;
  const preHandler = [guard.auth, guard.csrf];
  app.get(path, { preHandler: guard.auth, schema: { params, response } },
    async req => success(await catalog.get(scene(req), guard.scope(req)), req.id));

  app.put(`${path}/draft`, { preHandler, bodyLimit: 4 * 1024 * 1024, schema: { params, body: editBody, response } },
    async req => success(await catalog.edit(scene(req), guard.scope(req), {
      action: 'save', ...(req.body as { draftRevision: number; catalog: Catalog }),
    }, req.id), req.id));

  app.post(`${path}/publish`, { preHandler, bodyLimit: 4 * 1024 * 1024, schema: { params, body: editBody, response } },
    async req => success(await catalog.edit(scene(req), guard.scope(req), {
      action: 'publish', ...(req.body as { draftRevision: number; catalog: Catalog }),
    }, req.id), req.id));

  app.post(`${path}/restore`, {
    preHandler, schema: { params, response, body: Type.Object({ draftRevision: revision, version: revision }, Strict) },
  }, async req => success(await catalog.edit(scene(req), guard.scope(req), {
    action: 'restore', ...(req.body as { draftRevision: number; version: number }),
  }, req.id), req.id));
}
