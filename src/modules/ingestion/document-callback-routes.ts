import type {FastifyInstance} from 'fastify';
import {Type} from '@sinclair/typebox';
import {Id,Strict,Envelope} from '../identity/schemas.js';
import {success,ErrorSchema} from '../../contracts/envelope.js';
import type {DocumentCallbacks} from './document-callbacks.js';
import {validUuid} from '../../integrations/document-extraction.js';
import {DomainError} from '../identity/store.js';
export function registerDocumentCallbacks(app:FastifyInstance,service:DocumentCallbacks){
 app.post('/document-parser/callbacks/:id/:token',{
  bodyLimit:64*1024*1024,
  config:{internalApi:{auth:'parser-capability',authorize:async req=>{const p=req.params as {id:string;token:string};if(!validUuid(p.id))throw new DomainError(404,'DOCUMENT_CALLBACK_NOT_FOUND');await service.authorize(p.id,p.token);}}},
  schema:{params:Type.Object({id:Id,token:Type.String({pattern:'^[A-Za-z0-9_-]{43}$'})},Strict),body:Type.Unknown(),response:{200:Envelope(Type.Object({accepted:Type.Boolean(),duplicate:Type.Boolean()})),400:ErrorSchema,404:ErrorSchema,409:ErrorSchema,413:ErrorSchema}},
 },async(req)=>{const p=req.params as {id:string;token:string};return success(await service.receive(p.id,p.token,req.body),req.id);});
}
