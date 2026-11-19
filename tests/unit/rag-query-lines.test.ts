import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { buildBase } from '../../src/apps/base.js';
import { registerRagRoutes } from '../../src/modules/rag/routes.js';
import type { RagIngestionRepository } from '../../src/modules/rag/repository.js';
import type { RagQueryService } from '../../src/modules/rag/query-service.js';
import { config, dependencies } from '../helpers.js';

it('routes content assets and documents through their respective query lines',async()=>{
 const app=await buildBase({config:config(),dependencies:dependencies()}),query=vi.fn<RagQueryService['query']>(async()=>({mode:'keyword',query:'needle',results:[]}));
 registerRagRoutes(app,{} as RagIngestionRepository,{read:async()=>{throw Error('UNUSED');}}, {query} as unknown as RagQueryService);
 const headers={'x-huahuo-user-id':randomUUID(),'x-huahuo-session-id':randomUUID(),'x-huahuo-auth-method':'bearer'};
 try{
  for(const url of ['/api/v1/rag/query','/api/v1/kb/documents/query']){
   const response=await app.inject({method:'POST',url,headers,payload:{query:'needle',sourceType:'file'}});
   expect(response.statusCode,response.body).toBe(200);expect(query.mock.lastCall?.[1]).toMatchObject({sourceType:'file'});
   expect((await app.inject({method:'POST',url,headers,payload:{query:'needle',sourceType:'text'}})).statusCode).toBe(400);
  }
  const contentAsset=await app.inject({method:'POST',url:'/api/v1/kb/content-assets/query',headers,payload:{query:'needle'}});
  expect(contentAsset.statusCode,contentAsset.body).toBe(200);
  expect(query.mock.lastCall?.[1]).toMatchObject({sourceType:'content_asset'});
  expect((await app.inject({method:'POST',url:'/api/v1/rag/query',headers,payload:{query:'needle',sourceType:'note'}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/api/v1/kb/notes/query',headers,payload:{query:'needle'}})).statusCode).toBe(404);
  expect(query).toHaveBeenCalledTimes(3);
 }finally{await app.close();}
});
