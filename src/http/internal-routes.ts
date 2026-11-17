import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/service.js';
import type { DocumentCallbacks } from '../modules/ingestion/document-callbacks.js';
import type { RagQueryService } from '../modules/rag/query-service.js';
import type { RuntimeSettings } from '../modules/runtime-settings/service.js';
import { registerGatewayAuthRoute } from '../modules/gateway/routes.js';
import { registerDocumentCallbacks } from '../modules/ingestion/document-callback-routes.js';
import { registerInternalRagRoutes } from '../modules/rag/internal-routes.js';
import { registerInternalApi } from './internal-api.js';

/** The only application entry point for service-to-service routes. */
export function registerInternalRoutes(app: FastifyInstance, services: {
  identity: IdentityService; callbacks: DocumentCallbacks; ragQuery: RagQueryService; settings: RuntimeSettings;
}) {
  registerInternalApi(app, internal => {
    registerGatewayAuthRoute(internal, services.identity);
    registerInternalRagRoutes(internal, services.ragQuery);
    registerDocumentCallbacks(internal, services.callbacks);
  }, services.settings);
}
