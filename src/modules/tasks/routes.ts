import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { ErrorSchema,success } from '../../contracts/envelope.js';
import { Envelope,Id,Text,Strict,Nullable } from '../identity/schemas.js';
import type { IdentityService } from '../identity/service.js';
import { idempotencyKey } from '../identity/routes.js';
import { DomainError } from '../identity/store.js';
import { TaskService } from './service.js';
export const TaskSchema=Type.Object({taskId:Id,taskType:Type.String(),status:Type.String(),state:Type.String(),workspaceId:Nullable(Id),version:Type.Integer(),attempt:Type.Integer(),resultId:Nullable(Id),createdAt:Type.String(),updatedAt:Type.String(),error:Type.Optional(Type.Object({code:Type.String(),userMessage:Type.String(),retryable:Type.Boolean()}))});
export const MutationSchema=Type.Object({task:TaskSchema});
export const taskErrors={400:ErrorSchema,401:ErrorSchema,403:ErrorSchema,404:ErrorSchema,409:ErrorSchema,429:ErrorSchema,503:ErrorSchema};
export function registerTaskRoutes(app:FastifyInstance,identity:IdentityService,service:TaskService,demoEnabled:boolean){
 const auth=async(req:FastifyRequest)=>{req.authScope=await identity.authenticate(req.headers.authorization,req.id);idempotencyKey(req,req.method==='GET'?'forbidden':'required');};
 const scope=(req:FastifyRequest)=>{if(!req.authScope)throw new DomainError(401,'UNAUTHORIZED');return req.authScope;};
 const key=(req:FastifyRequest)=>idempotencyKey(req,'required')!;
 const id=(req:FastifyRequest)=>(req.params as {taskId:string}).taskId;
 const params=Type.Object({taskId:Id},Strict),empty=Type.Object({},Strict);
 if(demoEnabled)app.post('/api/v1/tasks/demo',{preHandler:auth,schema:{body:Type.Object({workspaceId:Id,text:Text(10000)},Strict),querystring:empty,response:{200:Envelope(MutationSchema),...taskErrors}}},async req=>success(await service.create(scope(req),req.body as {workspaceId:string;text:string},key(req)),req.id));
 app.get('/api/v1/tasks/running',{preHandler:auth,schema:{querystring:empty,response:{200:Envelope(Type.Object({items:Type.Array(TaskSchema)})),...taskErrors}}},async req=>success(await service.running(scope(req)),req.id));
 app.get('/api/v1/tasks/:taskId',{preHandler:auth,schema:{params,querystring:empty,response:{200:Envelope(Type.Object({task:TaskSchema,retryActions:Type.Array(Type.Object({action:Type.String(),title:Type.String(),allowed:Type.Boolean()}))})),...taskErrors}}},async req=>success(await service.detail(scope(req),id(req)),req.id));
 app.get('/api/v1/tasks/:taskId/events',{preHandler:auth,schema:{params,querystring:Type.Object({afterSequence:Type.Optional(Type.Integer({minimum:0,maximum:2147483647})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))},Strict),response:{200:Envelope(Type.Object({taskId:Id,items:Type.Array(Type.Object({sequence:Type.Integer(),state:Type.String(),createdAt:Type.String()})),nextSequence:Type.Integer(),hasMore:Type.Boolean()})),...taskErrors}}},async req=>{const q=req.query as {afterSequence?:number;limit?:number};return success(await service.events(scope(req),id(req),q.afterSequence??0,q.limit??100),req.id);});
 app.get('/api/v1/tasks/:taskId/result',{preHandler:auth,schema:{params,querystring:empty,response:{200:Envelope(Type.Object({taskId:Id,resultId:Id,digest:Type.String(),byteCount:Type.Integer()})),...taskErrors}}},async req=>success(await service.result(scope(req),id(req)),req.id));
 for(const action of ['retry','cancel'] as const)app.post(`/api/v1/tasks/:taskId/${action}`,{preHandler:auth,schema:{params,querystring:empty,body:action==='retry'?Type.Object({stage:Type.Optional(Type.Literal('runtime'))},Strict):Type.Object({reason:Type.Optional(Text(240))},Strict),response:{200:Envelope(MutationSchema),...taskErrors}}},async req=>success(await service.mutate(scope(req),id(req),action,key(req),req.body),req.id));
 // Regeneration is a new paid/business intent, not queue retry. Implement with P09 domain policy.
 app.post('/api/v1/tasks/:taskId/regenerate',{preHandler:auth,schema:{params,querystring:empty,body:Type.Object({supplement:Type.Optional(Text(500))},Strict),response:taskErrors}},async req=>{await service.detail(scope(req),id(req));throw new DomainError(409,'REGENERATION_NOT_AVAILABLE');});
}
