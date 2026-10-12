import { TaskService } from '../tasks/service.js';
import { TaskSchema,MutationSchema,taskErrors } from '../tasks/routes.js';
import { idempotencyKey } from '../identity/routes.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { ErrorSchema, success } from '../../contracts/envelope.js';
import type { AppConfig } from '../../config/config.js';
import { DomainError } from '../identity/store.js';
import { AdminService, type AdminScope } from './service.js';
import { Envelope, Text, Strict, Id } from '../identity/schemas.js';
declare module 'fastify' { interface FastifyRequest { adminScope?:AdminScope; } }
function sessionCookie(req:FastifyRequest){
 const values=(req.headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith('hh_admin_session='));
 if(values.length!==1)return undefined;return values[0]!.slice('hh_admin_session='.length);
}
export function registerAdminRoutes(app:FastifyInstance,service:AdminService,config:AppConfig,tasks:TaskService){
 app.decorateRequest('adminScope');
 const cookie=(value:string,maxAge:number)=>`hh_admin_session=${value}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${maxAge}${config.appEnv==='production'?'; Secure':''}`;
 const origin=(req:FastifyRequest)=>{if(req.headers.origin!==config.adminOrigin)throw new DomainError(403,'CSRF_ORIGIN_INVALID');};
 const auth=async(req:FastifyRequest)=>{req.adminScope=await service.authenticate(sessionCookie(req));};
 const csrf=async(req:FastifyRequest)=>{origin(req);service.checkCsrf(sessionCookie(req)??'',req.headers['x-csrf-token']);};
 const scope=(req:FastifyRequest)=>{if(!req.adminScope)throw new DomainError(401,'ADMIN_UNAUTHORIZED');return req.adminScope;};
 const adminSchema=Type.Object({adminId:Id,username:Type.String(),role:Type.Union([Type.Literal('operator'),Type.Literal('superadmin')])});
 const errors={400:ErrorSchema,401:ErrorSchema,403:ErrorSchema,404:ErrorSchema,409:ErrorSchema,429:ErrorSchema};
 app.post('/admin/api/v1/login',{
  preHandler:async req=>origin(req),schema:{body:Type.Object({username:Text(64),password:Type.String({minLength:1,maxLength:128})},Strict),response:{200:Envelope(Type.Object({admin:adminSchema,csrfToken:Type.String()})),...errors}},
 },async(req,reply)=>{
  const input=req.body as {username:string;password:string};const result=await service.login(input.username,input.password,req.ip,req.id);
  reply.header('Set-Cookie',cookie(result.cookie,28800));return success({admin:result.admin,csrfToken:result.csrfToken},req.id);
 });
 for(const path of ['/admin','/admin/api/v1/me'])app.get(path,{preHandler:auth,schema:{response:{200:Envelope(Type.Object({admin:adminSchema,csrfToken:Type.String()})),...errors}}},async req=>{
  const s=scope(req);return success({admin:{adminId:s.adminId,username:s.username,role:s.role},csrfToken:service.csrf(sessionCookie(req)!)},req.id);
 });
 app.post('/admin/api/v1/logout',{preHandler:[auth,csrf],schema:{response:{200:Envelope(Type.Object({revoked:Type.Boolean()})),...errors}}},async(req,reply)=>{
  const out=await service.logout(scope(req),req.id);reply.header('Set-Cookie',cookie('',0));return success(out,req.id);
 });
 app.post('/admin/api/v1/sessions/:adminId/revoke',{preHandler:[auth,csrf],schema:{params:Type.Object({adminId:Id},Strict),body:Type.Object({reason:Text(500)},Strict),response:{200:Envelope(Type.Object({revokedCount:Type.Integer()})),...errors}}},async req=>{
  return success(await service.revoke(scope(req),(req.params as {adminId:string}).adminId,(req.body as {reason:string}).reason,req.id),req.id);
 });
 app.get('/admin/api/v1/tasks/:taskId',{preHandler:auth,schema:{params:Type.Object({taskId:Id},Strict),response:{200:Envelope(Type.Object({task:TaskSchema})),...taskErrors}}},async req=>success(await tasks.adminDetail(scope(req),(req.params as {taskId:string}).taskId),req.id));
 app.post('/admin/api/v1/tasks/:taskId/retry',{preHandler:[auth,csrf],schema:{params:Type.Object({taskId:Id},Strict),body:Type.Object({reason:Text(500)},Strict),response:{200:Envelope(MutationSchema),...taskErrors}}},async req=>success(await tasks.adminRetry(scope(req),(req.params as {taskId:string}).taskId,idempotencyKey(req,'required')!,(req.body as {reason:string}).reason,req.id),req.id));
 app.get('/admin/api/v1/resources/:resourceId',{preHandler:auth,schema:{params:Type.Object({resourceId:Id},Strict),response:{200:Envelope(Type.Object({resourceId:Id,userId:Id,workspaceId:Id,fileName:Type.String(),mimeType:Type.String(),sizeBytes:Type.Integer(),status:Type.String(),processingStatus:Type.String(),createdAt:Type.String()})),...errors}}},async req=>success(await service.resource(scope(req),(req.params as {resourceId:string}).resourceId,req.id),req.id));
 // Unimplemented admin operations fail closed, including App JWT/Bearer attempts.
 app.all('/admin/*',{preHandler:auth},async()=>{throw new DomainError(404,'NOT_FOUND');});
}
