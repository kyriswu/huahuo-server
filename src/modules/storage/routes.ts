import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { ErrorSchema, success } from '../../contracts/envelope.js';
import { DomainError } from '../identity/store.js';
import type { IdentityService } from '../identity/service.js';
import { idempotencyKey } from '../identity/routes.js';
import { Envelope, Id, Strict } from '../identity/schemas.js';
import { StorageService } from './service.js';
const empty=Type.Object({},Strict),uploadParams=Type.Object({uploadId:Id},Strict),resourceParams=Type.Object({resourceId:Id},Strict);
const errors={400:ErrorSchema,401:ErrorSchema,403:ErrorSchema,404:ErrorSchema,409:ErrorSchema,410:ErrorSchema,413:ErrorSchema,416:ErrorSchema,429:ErrorSchema,503:ErrorSchema};
const resource=Type.Object({resourceId:Id,sourceScene:Type.String(),fileName:Type.String(),mimeType:Type.String(),sizeBytes:Type.Integer(),durationSeconds:Type.Number(),sha256:Type.String()});
export function registerStorageRoutes(app:FastifyInstance,identity:IdentityService,storage:StorageService){
 const auth=async(req:FastifyRequest)=>{req.authScope=await identity.authenticate(req.headers.authorization,req.id);};
 const scope=(req:FastifyRequest)=>{if(!req.authScope)throw new DomainError(401,'UNAUTHORIZED');return req.authScope;};
 const body=Type.Object({sourceScene:Type.String({minLength:2,maxLength:64}),fileName:Type.String({minLength:1,maxLength:120}),mimeType:Type.String({minLength:3,maxLength:128}),sizeBytes:Type.Integer({minimum:1,maximum:storage.config.maxUploadBytes}),durationSeconds:Type.Number({minimum:0,maximum:14400}),sha256:Type.Optional(Type.String({pattern:'^[a-f0-9]{64}$'})),workspaceId:Type.Optional(Id),distillToDigitalTwin:Type.Optional(Type.Boolean())},Strict);
 app.post('/api/v1/media/upload-token',{preHandler:auth,schema:{body,querystring:empty,response:{200:Envelope(Type.Object({uploadId:Id,resourceId:Id,uploadUrl:Type.String(),method:Type.Literal('PUT'),headers:Type.Record(Type.String(),Type.String()),expiresAt:Type.String()})),...errors}}},async req=>{const b=req.body as {sourceScene:string;fileName:string;mimeType:string;sizeBytes:number;durationSeconds:number;sha256?:string;workspaceId?:string;distillToDigitalTwin?:boolean};return success(await storage.createUpload(scope(req),{...b,sizeBytes:BigInt(b.sizeBytes)},idempotencyKey(req,'required')!),req.id);});
 // Encapsulation ensures JSON API parsers and limits are unaffected by object streaming.
 void app.register(async objects=>{
  objects.removeAllContentTypeParsers();objects.addContentTypeParser('*',(_req,payload,done)=>done(null,payload));
  objects.put('/api/v1/media/uploads/:uploadId/object',{bodyLimit:storage.config.maxUploadBytes,onRequest:async req=>storage.authorizeUpload((req.params as {uploadId:string}).uploadId,String(req.headers['x-upload-capability']??'')),schema:{params:uploadParams,querystring:empty,response:{200:Envelope(Type.Object({bytes:Type.Integer(),sha256:Type.String()})),...errors}}},async req=>success(await storage.put((req.params as {uploadId:string}).uploadId,String(req.headers['x-upload-capability']??''),req.body as NodeJS.ReadableStream),req.id));
 });
 app.post('/api/v1/media/uploads/:uploadId/complete',{preHandler:auth,schema:{params:uploadParams,body:Type.Object({workspaceId:Type.Optional(Id)},Strict),querystring:empty,response:{200:Envelope(Type.Object({uploadId:Id,status:Type.Literal('completed'),resource})),...errors}}},async req=>success(await storage.complete(scope(req),(req.params as {uploadId:string}).uploadId,idempotencyKey(req,'required')!,(req.body as {workspaceId?:string}).workspaceId),req.id));
 app.get('/api/v1/media/uploads/:uploadId',{preHandler:auth,schema:{params:uploadParams,querystring:empty,response:{200:Envelope(Type.Object({uploadId:Id,resourceId:Id,status:Type.String(),expiresAt:Type.String(),receivedBytes:Type.Integer(),errorCode:Type.Union([Type.String(),Type.Null()])})),...errors}}},async req=>{idempotencyKey(req,'forbidden');return success(await storage.recover(scope(req),(req.params as {uploadId:string}).uploadId),req.id);});
 app.get('/api/v1/media/resources/:resourceId/playback',{preHandler:auth,schema:{params:resourceParams,querystring:empty,response:{200:Envelope(Type.Object({resourceId:Id,url:Type.String(),mimeType:Type.String(),fileName:Type.String(),expiresAt:Type.String()})),...errors}}},async req=>{idempotencyKey(req,'forbidden');return success(await storage.playback(scope(req),(req.params as {resourceId:string}).resourceId),req.id);});
 app.get('/api/v1/media/resources/:resourceId/object',{schema:{params:resourceParams,querystring:Type.Object({playbackToken:Type.String({maxLength:200})},Strict)}},async(req,reply)=>{
  try{const p=await storage.download((req.params as {resourceId:string}).resourceId,(req.query as {playbackToken:string}).playbackToken,typeof req.headers.range==='string'?req.headers.range:undefined);reply.header('Content-Type',p.mime).header('Content-Length',String(p.end-p.start+1)).header('Accept-Ranges','bytes').header('X-Content-Type-Options','nosniff').header('Content-Disposition',`inline; filename="${p.fileName.replace(/[^A-Za-z0-9._-]/g,'_')}"`);if(req.headers.range)reply.code(206).header('Content-Range',`bytes ${p.start}-${p.end}/${p.size}`);return reply.send(p.stream);
  }catch(e){if(e instanceof DomainError&&e.statusCode===416&&'size' in e)reply.header('Content-Range',`bytes */${e.size}`);throw e;}
 });
 app.delete('/api/v1/workspaces/:workspaceId/media/resources/:resourceId',{preHandler:auth,schema:{params:Type.Object({workspaceId:Id,resourceId:Id},Strict),querystring:empty,response:{200:Envelope(Type.Object({resourceId:Id,workspaceId:Id,status:Type.Union([Type.Literal('deleted'),Type.Literal('delete_pending')])},Strict)),...errors}}},async req=>success(await storage.remove(scope(req),(req.params as {workspaceId:string}).workspaceId,(req.params as {resourceId:string}).resourceId,idempotencyKey(req,'required')!),req.id));
}
