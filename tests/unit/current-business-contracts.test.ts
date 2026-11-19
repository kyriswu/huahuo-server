import Fastify,{type FastifyError} from 'fastify';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { registerContentAssetRoutes } from '../../src/modules/content-assets/routes.js';
import type { ContentAssetService } from '../../src/modules/content-assets/service.js';
import type { StorageService } from '../../src/modules/storage/service.js';
import { registerTaskRoutes } from '../../src/modules/tasks/routes.js';
import { TaskService } from '../../src/modules/tasks/service.js';
import type { TaskRow } from '../../src/modules/tasks/model.js';
import { failure } from '../../src/contracts/envelope.js';

const id='11111111-1111-4111-8111-111111111111';
describe('current business contracts',()=>{
 it('rejects retired search and folder restore parameters and removes regenerate',async()=>{
  const app=Fastify({ajv:{customOptions:{removeAdditional:false}}});
  app.setErrorHandler<FastifyError>((error,req,reply)=>reply.code(error.validation?400:500).send(failure(error.validation?'VALIDATION_ERROR':'INTERNAL_ERROR','Request failed',req.id)));
  const search=vi.fn(),deleteFolder=vi.fn();
  registerContentAssetRoutes(app,{search,deleteFolder} as unknown as ContentAssetService,{} as StorageService);
  registerTaskRoutes(app,{} as TaskService,false);
  try{
   expect((await app.inject({method:'POST',url:`/api/v1/workspaces/${id}/search`,payload:{query:'text',keywordAttemptId:'old'}})).statusCode).toBe(400);
   for(const payload of [{parentFolderId:null},{overrideParentFolder:true}]){
    expect((await app.inject({method:'POST',url:`/api/v1/workspaces/${id}/folders/${id}/restore`,payload})).statusCode).toBe(400);
   }
   expect((await app.inject({method:'POST',url:`/api/v1/tasks/${id}/regenerate`,payload:{}})).statusCode).toBe(404);
   expect(search).not.toHaveBeenCalled();expect(deleteFolder).not.toHaveBeenCalled();
  }finally{await app.close();}
 });
 it('does not advertise the demo retry operation for a real failed task',async()=>{
  const task={id,user_id:id,workspace_id:id,kind:'content-asset.tag-extract',state:'failed',retryable:true,external_state:'none',attempt_no:3,resume_count:0,version:1,result_id:null,created_at:new Date(),updated_at:new Date(),error_code:'TAG_PROVIDER_UNAVAILABLE'} as TaskRow;
  const client={on:vi.fn(),removeListener:vi.fn(),release:vi.fn(),query:vi.fn(async(sql:string)=>({rows:sql.includes('SELECT t.*')?[task]:[{id}],rowCount:1}))};
  const service=new TaskService({connect:async()=>client} as unknown as pg.Pool,'unit-secret-'.repeat(4));
  const detail=await service.detail({userId:id,sessionId:id,traceId:'unit'},id);
  expect(detail.retryActions).toEqual([{action:'runtime',title:'重试',allowed:false}]);
  expect(detail.task).toMatchObject({state:'failed'});expect(detail.task).not.toHaveProperty('status');
  await expect(service.change(client as unknown as pg.PoolClient,task,'retry')).rejects.toMatchObject({code:'TASK_RETRY_NOT_ALLOWED'});
 });
});
