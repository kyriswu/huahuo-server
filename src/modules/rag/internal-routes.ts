import type { FastifyInstance } from 'fastify';
import { DomainError } from '../identity/store.js';
import type { RagQueryService } from './query-service.js';
import { createRagQueryRoute } from './query-routes.js';

export function registerInternalRagRoutes(app: FastifyInstance, query: RagQueryService) {
  const {route,handler}=createRagQueryRoute(query,async request=>{
    if(!request.authScope)throw new DomainError(401,'UNAUTHORIZED');
  });
  app.post('/rag/query',{...route,config:{internalApi:{auth:'trusted-scope',runtimeSettings:true}}},handler);
}
