import { readTrustedScope } from '../identity/trusted-scope.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { ErrorSchema, success } from '../../contracts/envelope.js';
import { DomainError } from '../identity/store.js';
import { idempotencyKey } from '../identity/routes.js';
import { Envelope, Id, Strict } from '../identity/schemas.js';
import { StorageService } from './service.js';
const empty=Type.Object({},Strict),uploadParams=Type.Object({uploadId:Id},Strict),resourceParams=Type.Object({resourceId:Id},Strict);
const errors={400:ErrorSchema,401:ErrorSchema,403:ErrorSchema,404:ErrorSchema,409:ErrorSchema,410:ErrorSchema,413:ErrorSchema,429:ErrorSchema,503:ErrorSchema};
const resource=Type.Object({resourceId:Id,fileName:Type.String(),mimeType:Type.String(),sizeBytes:Type.Integer(),sha256:Type.Union([Type.String(),Type.Null()])});
export function registerStorageRoutes(app:FastifyInstance,storage:StorageService){
 const auth=async(req:FastifyRequest)=>{req.authScope=readTrustedScope(req.headers,req.id);};
 const scope=(req:FastifyRequest)=>{if(!req.authScope)throw new DomainError(401,'UNAUTHORIZED');return req.authScope;};
 const body=Type.Object({fileName:Type.String({minLength:1,maxLength:120}),mimeType:Type.String({minLength:3,maxLength:128}),sizeBytes:Type.Integer({minimum:1,maximum:storage.config.uploadHardMaxBytes}),workspaceId:Type.Optional(Id)},Strict);
 app.post('/api/v1/media/upload-token',{preHandler:auth,schema:{body,querystring:empty,response:{200:Envelope(Type.Object({uploadId:Id,resourceId:Id,uploadUrl:Type.String(),method:Type.Literal('PUT'),headers:Type.Record(Type.String(),Type.String()),expiresAt:Type.String(),retentionExpiresAt:Type.String()})),...errors}}},async (req,reply)=>{reply.header('Cache-Control','no-store');const b=req.body as {fileName:string;mimeType:string;sizeBytes:number;workspaceId?:string;};return success(await storage.createUpload(scope(req),{...b,sizeBytes:BigInt(b.sizeBytes)},idempotencyKey(req,'required')!),req.id);});
 app.post('/api/v1/media/uploads/:uploadId/complete',{preHandler:auth,schema:{params:uploadParams,body:Type.Object({workspaceId:Type.Optional(Id)},Strict),querystring:empty,response:{200:Envelope(Type.Object({uploadId:Id,status:Type.Literal('completed'),resource})),...errors}}},async req=>success(await storage.complete(scope(req),(req.params as {uploadId:string}).uploadId,idempotencyKey(req,'required')!,(req.body as {workspaceId?:string}).workspaceId),req.id));
 app.post('/api/v1/media/uploads/:uploadId/cancel',{preHandler:auth,schema:{params:uploadParams,body:empty,querystring:empty,response:{200:Envelope(Type.Object({uploadId:Id,status:Type.Literal('cancel_pending')})),...errors}}},async req=>success(await storage.cancel(scope(req),(req.params as {uploadId:string}).uploadId,idempotencyKey(req,'required')!),req.id));
 app.get('/api/v1/media/uploads/:uploadId',{preHandler:auth,schema:{params:uploadParams,querystring:empty,response:{200:Envelope(Type.Object({uploadId:Id,resourceId:Id,status:Type.String(),expiresAt:Type.Union([Type.String(),Type.Null()]),receivedBytes:Type.Integer(),errorCode:Type.Union([Type.String(),Type.Null()])})),...errors}}},async req=>{idempotencyKey(req,'forbidden');return success(await storage.recover(scope(req),(req.params as {uploadId:string}).uploadId),req.id);});
 app.get('/api/v1/media/resources/:resourceId/playback',{preHandler:auth,schema:{params:resourceParams,querystring:empty,response:{200:Envelope(Type.Object({resourceId:Id,url:Type.String(),mimeType:Type.String(),fileName:Type.String(),expiresAt:Type.String()})),...errors}}},async(req,reply)=>{reply.header('Cache-Control','no-store');idempotencyKey(req,'forbidden');return success(await storage.playback(scope(req),(req.params as {resourceId:string}).resourceId),req.id);});
 app.delete('/api/v1/workspaces/:workspaceId/media/resources/:resourceId',{preHandler:auth,schema:{params:Type.Object({workspaceId:Id,resourceId:Id},Strict),querystring:empty,response:{200:Envelope(Type.Object({resourceId:Id,workspaceId:Id,status:Type.Union([Type.Literal('deleted'),Type.Literal('delete_pending')])},Strict)),...errors}}},async req=>success(await storage.remove(scope(req),(req.params as {workspaceId:string}).workspaceId,(req.params as {resourceId:string}).resourceId,idempotencyKey(req,'required')!),req.id));
}
