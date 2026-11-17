import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorSchema, success } from '../../contracts/envelope.js';
import { DomainError } from '../identity/store.js';
import { idempotencyKey } from '../identity/routes.js';
import { Envelope, Strict, Text } from '../identity/schemas.js';
import type { RagQueryService } from './query-service.js';
import { NoteQueryTiming } from './query-timing.js';
import { currentTelemetryFields, tracedOperation } from '../../observability/telemetry.js';
const queryBody=Type.Object({query:Text(2000),sourceType:Type.Optional(Type.Union([Type.Literal('file'),Type.Literal('note'),Type.Literal('text')])),assetMode:Type.Optional(Type.Union([Type.Literal('ids'),Type.Literal('links')])),mode:Type.Optional(Type.Union([Type.Literal('dense'),Type.Literal('keyword'),Type.Literal('hybrid')])),topK:Type.Optional(Type.Integer({minimum:1,maximum:50})),documentKey:Type.Optional(Text(128)),},Strict);
const queryResult=Type.Object({mode:Type.Union([Type.Literal('dense'),Type.Literal('keyword'),Type.Literal('hybrid')]),query:Type.String(),results:Type.Array(Type.Any())},Strict);

/** Public and service callers use identical query validation, execution and timing. */
export function createRagQueryRoute(queryService: RagQueryService, authorize: (request: FastifyRequest) => Promise<void>) {
  const timings = new WeakMap<FastifyRequest, NoteQueryTiming>();
  const sourceType=(request:FastifyRequest)=>{
    const value=(request.body as {sourceType?:unknown}|undefined)?.sourceType??'note';
    return value==='note'||value==='file'||value==='text'?value:'other';
  };
  const handler = async (request: FastifyRequest) => {
    if (!request.authScope) throw new DomainError(401,'UNAUTHORIZED');
    const scope=request.authScope;
    const body=request.body as Parameters<RagQueryService['query']>[1];
    return tracedOperation('rag.query',{'rag.source_type':sourceType(request),'rag.mode':body.mode??(sourceType(request)==='note'?'hybrid':'keyword')},async()=>
      success(await queryService.query(scope,body,timings.get(request)),request.id));
  };
  const route = {
    onRequest: async (request: FastifyRequest) => { timings.set(request, new NoteQueryTiming()); },
    preHandler: async (request: FastifyRequest) => {
      idempotencyKey(request,'optional');
      await timings.get(request)!.measure('auth',()=>authorize(request));
    },
    onSend: async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control','no-store');
      if (sourceType(request)==='note') reply.header('Server-Timing',timings.get(request)?.serverTiming()??'');
    },
    onResponse: async (request: FastifyRequest, reply: FastifyReply) => {
      const timing=timings.get(request);timings.delete(request);
      if(!timing||!reply.raw.writableFinished)return;
      timing.record(request.server.metrics,sourceType(request),reply.statusCode);
      request.log.info({event:'rag.query.finished',sourceType:sourceType(request),statusCode:reply.statusCode,...currentTelemetryFields(),...timing.snapshot()},'RAG query finished');
    },
    schema: {body:queryBody,querystring:Type.Object({},Strict),response:{200:Envelope(queryResult),400:ErrorSchema,401:ErrorSchema,404:ErrorSchema,409:ErrorSchema,413:ErrorSchema,429:ErrorSchema,503:ErrorSchema}},
  };
  return {route,handler};
}
