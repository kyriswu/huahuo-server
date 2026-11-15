import { TaskService } from '../tasks/service.js';
import { TaskSchema,MutationSchema,taskErrors } from '../tasks/routes.js';
import { idempotencyKey } from '../identity/routes.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { ErrorSchema, success } from '../../contracts/envelope.js';
import type { AppConfig } from '../../config/config.js';
import { DomainError } from '../identity/store.js';
import { AdminService, type AdminScope } from './service.js';
import { Envelope, Text, Strict, Id } from '../identity/schemas.js';
import { AdminUserList, AdminUserQuery } from './user-schemas.js';
import {NodeSchema,ConfigurationResponse} from './configuration-schemas.js';
import type {ProcessingNodes} from '../processing-nodes/service.js';
import type {ProcessingNode} from '../processing-nodes/model.js';
import type {RuntimeSettings} from '../runtime-settings/service.js';
import type {Category,Values} from '../runtime-settings/registry.js';
import type {AdminDocumentTrials} from './document-trials.js';
declare module 'fastify' { interface FastifyRequest { adminScope?:AdminScope; } }
function sessionCookie(req:FastifyRequest){
 const values=(req.headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith('hh_admin_session='));
 if(values.length!==1)return undefined;return values[0]!.slice('hh_admin_session='.length);
}
export function registerAdminRoutes(
 app: FastifyInstance,
 service: AdminService,
 config: AppConfig,
 tasks: TaskService,
 configuration:{settings:RuntimeSettings;nodes:ProcessingNodes;trials:AdminDocumentTrials},
 renderPage: (reply: FastifyReply) => FastifyReply,
){
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
 const sessionResponse = { 200: Envelope(Type.Object({ admin: adminSchema, csrfToken: Type.String() })), ...errors };
 const currentSession = async (req: FastifyRequest) => {
  const s = scope(req);
  return success({ admin: { adminId: s.adminId, username: s.username, role: s.role }, csrfToken: service.csrf(sessionCookie(req)!) }, req.id);
 };
 app.get('/admin/api/v1/me', { preHandler: auth, schema: { response: sessionResponse } }, currentSession);
 app.get('/admin', { schema: { response: sessionResponse } }, async (req, reply) => {
  reply.header('Vary', 'Accept');
  const acceptsHtml = req.headers.accept?.split(',').some(value => {
   const [mediaType, ...parameters] = value.split(';');
   return mediaType?.trim().toLowerCase() === 'text/html'
    && !parameters.some(parameter => /^q\s*=\s*0(?:\.0*)?$/i.test(parameter.trim()));
  });
  if (acceptsHtml) return renderPage(reply);
  await auth(req);
  return currentSession(req);
 });
 app.post('/admin/api/v1/logout',{preHandler:[auth,csrf],schema:{response:{200:Envelope(Type.Object({revoked:Type.Boolean()})),...errors}}},async(req,reply)=>{
  const out=await service.logout(scope(req),req.id);reply.header('Set-Cookie',cookie('',0));return success(out,req.id);
 });
 app.post('/admin/api/v1/sessions/:adminId/revoke',{preHandler:[auth,csrf],schema:{params:Type.Object({adminId:Id},Strict),body:Type.Object({reason:Text(500)},Strict),response:{200:Envelope(Type.Object({revokedCount:Type.Integer()})),...errors}}},async req=>{
  return success(await service.revoke(scope(req),(req.params as {adminId:string}).adminId,(req.body as {reason:string}).reason,req.id),req.id);
 });
 app.get('/admin/api/v1/users', {
  preHandler: auth,
  schema: { querystring: AdminUserQuery, response: { 200: Envelope(AdminUserList), ...errors } },
 }, async req => success(await service.users(scope(req), req.query as AdminUserQuery, req.id), req.id));
 app.get('/admin/api/v1/tasks/:taskId',{preHandler:auth,schema:{params:Type.Object({taskId:Id},Strict),response:{200:Envelope(Type.Object({task:TaskSchema})),...taskErrors}}},async req=>success(await tasks.adminDetail(scope(req),(req.params as {taskId:string}).taskId),req.id));
 app.post('/admin/api/v1/tasks/:taskId/retry',{preHandler:[auth,csrf],schema:{params:Type.Object({taskId:Id},Strict),body:Type.Object({reason:Text(500)},Strict),response:{200:Envelope(MutationSchema),...taskErrors}}},async req=>success(await tasks.adminRetry(scope(req),(req.params as {taskId:string}).taskId,idempotencyKey(req,'required')!,(req.body as {reason:string}).reason,req.id),req.id));
 app.get('/admin/api/v1/resources/:resourceId',{preHandler:auth,schema:{params:Type.Object({resourceId:Id},Strict),response:{200:Envelope(Type.Object({resourceId:Id,userId:Id,workspaceId:Id,fileName:Type.String(),mimeType:Type.String(),sizeBytes:Type.Integer(),status:Type.String(),processingStatus:Type.String(),createdAt:Type.String()})),...errors}}},async req=>success(await service.resource(scope(req),(req.params as {resourceId:string}).resourceId,req.id),req.id));
 app.get('/admin/api/v1/configuration',{preHandler:auth,schema:{response:{200:Envelope(ConfigurationResponse),...errors}}},async req=>success(await configuration.settings.view(),req.id));
 app.put('/admin/api/v1/configuration/:category',{preHandler:[auth,csrf],bodyLimit:262144,schema:{
  params:Type.Object({category:Type.Union(['document','rag','tasks','storage','billing','features'].map(c=>Type.Literal(c)))},Strict),
  body:Type.Object({revision:Type.Integer({minimum:1}),values:Type.Record(Type.String(),Type.Unknown())},Strict),
  response:{200:Envelope(Type.Object({revision:Type.Integer(),values:Type.Record(Type.String(),Type.Unknown()),updatedAt:Type.String()})),...errors},
 }},async req=>{const b=req.body as {revision:number;values:Values};return success(await configuration.settings.save((req.params as {category:Category}).category,b.values,b.revision,scope(req),req.id),req.id);});
 app.get('/admin/api/v1/processing-nodes',{preHandler:auth,schema:{response:{200:Envelope(Type.Object({items:Type.Array(NodeSchema),enabled:Type.Boolean()})),...errors}}},async req=>success({items:await configuration.nodes.list(),enabled:config.processingNodes.enabled},req.id));
 app.put('/admin/api/v1/processing-nodes/:nodeId',{preHandler:[auth,csrf],schema:{
  params:Type.Object({nodeId:Id},Strict),body:Type.Object({revision:Type.Integer({minimum:0}),node:NodeSchema},Strict),
  response:{200:Envelope(NodeSchema),...errors},
 }},async req=>{const b=req.body as {revision:number;node:ProcessingNode};if(b.node.id!==(req.params as {nodeId:string}).nodeId)throw new DomainError(400,'PROCESSING_NODE_INVALID');return success(await configuration.nodes.upsert(b.node,b.revision,scope(req),req.id),req.id);});
 const trials=configuration.trials;
 const trialAuth=async(req:FastifyRequest)=>{await auth(req);await trials.authorize(scope(req));};
 const trialErrors={...errors,413:ErrorSchema,503:ErrorSchema};
 const trialResponse={200:Envelope(Type.Unknown()),202:Envelope(Type.Unknown()),...trialErrors};
 app.get('/admin/api/v1/document-trials/capabilities',{preHandler:trialAuth,schema:{response:trialResponse}},async req=>success(await trials.capabilities(),req.id));
 app.post('/admin/api/v1/document-trials',{preHandler:[trialAuth,csrf],schema:{body:Type.Object({fileUrl:Text(8192)},Strict),response:trialResponse}},async(req,reply)=>{reply.code(202);return success(await trials.start(scope(req),{url:(req.body as {fileUrl:string}).fileUrl},req.id),req.id);});
 void app.register(async uploads=>{
  uploads.removeAllContentTypeParsers();uploads.addContentTypeParser('application/octet-stream',(_req,payload,done)=>done(null,payload));
  uploads.post('/admin/api/v1/document-trials/upload',{preHandler:[trialAuth,csrf],bodyLimit:32*1024*1024,schema:{querystring:Type.Object({fileName:Text(255),mimeType:Text(128)},Strict),response:trialResponse}},async(req,reply)=>{
   const metadata=req.query as {fileName:string;mimeType:string};const {maxBytes}=await trials.capabilities();const parts:Buffer[]=[];let bytes=0;
   for await(const part of req.body as NodeJS.ReadableStream){const chunk=Buffer.from(part);bytes+=chunk.length;if(bytes>maxBytes)throw new DomainError(413,'ADMIN_TRIAL_FILE_TOO_LARGE');parts.push(chunk);}
   reply.code(202);return success(await trials.start(scope(req),{file:{bytes:Buffer.concat(parts),fileName:metadata.fileName,contentType:metadata.mimeType,finalUrl:''}},req.id),req.id);
  });
 });
 const trialParams=Type.Object({trialId:Id},Strict);
 app.get('/admin/api/v1/document-trials/:trialId',{preHandler:trialAuth,schema:{params:trialParams,response:trialResponse}},async req=>success(trials.status(scope(req),(req.params as {trialId:string}).trialId),req.id));
 app.get('/admin/api/v1/document-trials/:trialId/result',{preHandler:trialAuth,schema:{params:trialParams,response:trialResponse}},async req=>success(trials.result(scope(req),(req.params as {trialId:string}).trialId),req.id));
 app.delete('/admin/api/v1/document-trials/:trialId',{preHandler:[trialAuth,csrf],schema:{params:trialParams,response:trialResponse}},async req=>success(trials.cancel(scope(req),(req.params as {trialId:string}).trialId),req.id));
 // Unimplemented admin operations fail closed, including App JWT/Bearer attempts.
 app.all('/admin/*',{preHandler:auth},async()=>{throw new DomainError(404,'NOT_FOUND');});
}
