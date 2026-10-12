import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { ErrorSchema, success } from '../../contracts/envelope.js';
import { DomainError } from '../identity/store.js';
import type { IdentityService } from '../identity/service.js';
import { BillingService } from './service.js';

const empty = Type.Object({}, { additionalProperties: false });
const any = Type.Any();
export function registerBillingRoutes(app: FastifyInstance, identity: IdentityService, billing: BillingService) {
 const auth=async(req:FastifyRequest)=>{req.authScope=await identity.authenticate(req.headers.authorization,req.id);};
 const scope=(req:FastifyRequest)=>{if(!req.authScope)throw new DomainError(401,'UNAUTHORIZED');return req.authScope;};
 const errors={400:ErrorSchema,401:ErrorSchema,404:ErrorSchema,409:ErrorSchema,503:ErrorSchema};
 app.get('/api/v1/membership',{preHandler:auth,schema:{querystring:empty,response:{200:Type.Object({success:Type.Literal(true),data:any,traceId:Type.String()}),...errors}}},async req=>success(await billing.membership(scope(req)),req.id));
 app.get('/api/v1/account/credits',{preHandler:auth,schema:{querystring:Type.Object({cursor:Type.Optional(Type.String()),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))},{additionalProperties:false}),response:{200:Type.Object({success:Type.Literal(true),data:any,traceId:Type.String()}),...errors}}},async req=>success(await billing.creditSummary(scope(req)),req.id));
 app.get('/api/v1/home',{preHandler:auth,schema:{querystring:empty,response:{200:Type.Object({success:Type.Literal(true),data:any,traceId:Type.String()}),...errors}}},async req=>{const q=await billing.quotaSummary(scope(req));return success({primaryAction:{kind:'none'},hotspotSuggestion:{},runningTasks:[],fileSummary:{total:0,unread:0},quotaSummary:{balances:q.items},redDots:[],serverTime:new Date().toISOString()},req.id);});
 app.get('/api/v1/runs/:runId/usage',{preHandler:auth,schema:{params:Type.Object({runId:Type.String({format:'uuid'})},{additionalProperties:false}),querystring:empty,response:{200:Type.Object({success:Type.Literal(true),data:any,traceId:Type.String()}),...errors}}},async req=>success(await billing.runUsage(scope(req),(req.params as {runId:string}).runId),req.id));
}
