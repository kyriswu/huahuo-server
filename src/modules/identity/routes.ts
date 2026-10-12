import type { FastifyInstance, FastifyRequest, HTTPMethods } from 'fastify';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { ErrorSchema, success } from '../../contracts/envelope.js';
import { IdentityService, type LoginInput } from './service.js';
import { WorkspaceService, type DraftInput, type PositioningInput } from '../workspaces/service.js';
import { DomainError, type Scope } from './store.js';
import * as S from './schemas.js';
declare module 'fastify' { interface FastifyRequest { authScope?:Scope; } }
export function idempotencyKey(req:FastifyRequest,mode:'required'|'optional'|'forbidden') {
 const a=req.headers['x-idempotency-key'], b=req.headers['idempotency-key'];
 if(a!==undefined&&b!==undefined&&a!==b)throw new DomainError(400,'IDEMPOTENCY_HEADER_CONFLICT');
 const key=a??b;
 if(mode==='forbidden'&&key!==undefined)throw new DomainError(400,'IDEMPOTENCY_NOT_ALLOWED');
 if(key===undefined){if(mode==='required')throw new DomainError(400,'IDEMPOTENCY_KEY_REQUIRED');return undefined;}
 if(typeof key!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw new DomainError(400,'IDEMPOTENCY_KEY_INVALID');
 return key;
}
export function registerIdentityRoutes(app:FastifyInstance,identity:IdentityService,workspaces:WorkspaceService) {
 app.decorateRequest('authScope');
 const scope=(r:FastifyRequest)=>{if(!r.authScope)throw new DomainError(401,'UNAUTHORIZED');return r.authScope;};
 const key=(r:FastifyRequest)=>idempotencyKey(r,'required')!;
 const wid=(r:FastifyRequest)=>(r.params as {workspaceId:string}).workspaceId;
 function route(method:HTTPMethods,url:string,body:TSchema|undefined,result:TSchema,handler:(req:FastifyRequest)=>Promise<unknown>,auth=true,idem:'required'|'optional'|'forbidden'=method==='GET'?'forbidden':'required') {
  app.route({method,url,schema:{...(body?{body}:{}),...(url.includes(':workspaceId')?{params:S.obj({workspaceId:S.Id},S.Strict)}:{}),querystring:S.obj({},S.Strict),response:{200:S.Envelope(result),400:ErrorSchema,401:ErrorSchema,403:ErrorSchema,404:ErrorSchema,409:ErrorSchema,412:ErrorSchema,429:ErrorSchema,503:ErrorSchema}},
   preHandler:async req=>{idempotencyKey(req,idem);if(auth)req.authScope=await identity.authenticate(req.headers.authorization,req.id);},
   handler:async(req,reply)=>{const data=await handler(req);if(data&&typeof data==='object'&&'etag' in data)reply.header('ETag',String(data.etag));return success(data,req.id);}});
 }
 route('POST','/api/v1/auth/sms-code',S.SmsBody,S.SmsResult,r=>identity.sendCode(r.body as Static<typeof S.SmsBody>,r.ip,idempotencyKey(r,'optional')),false,'optional');
 route('POST','/api/v1/auth/login',S.LoginBody,S.obj({...S.TokenFields,...S.StatusFields,firstLogin:Type.Boolean()}),r=>identity.login(r.body as LoginInput,r.ip,r.id,idempotencyKey(r,'optional')),false,'optional');
 route('POST','/api/v1/auth/refresh',S.obj({refreshToken:S.Text(128)},S.Strict),S.obj(S.TokenFields),r=>identity.refresh((r.body as {refreshToken:string}).refreshToken,r.id),false,'forbidden');
 route('POST','/api/v1/auth/logout',undefined,S.obj({revoked:Type.Boolean(),scope:Type.String()}),r=>identity.logout(scope(r)),true,'optional');
 route('POST','/api/v1/auth/logout-all',undefined,S.obj({revoked:Type.Boolean(),scope:Type.String()}),r=>identity.logout(scope(r),true),true,'optional');
 route('GET','/api/v1/me/status',undefined,S.obj(S.StatusFields),r=>workspaces.getStatus(scope(r)));
 route('GET','/api/v1/me/profile',undefined,S.Profile,r=>workspaces.getProfile(scope(r)));
 route('PATCH','/api/v1/me/profile',S.ProfileBody,S.Profile,r=>workspaces.updateProfile(scope(r),r.body as {displayName:string;avatarResourceId?:string|null},key(r)));
 route('PUT','/api/v1/me/timezone',S.obj({timeZone:S.Text(64)},S.Strict),S.obj({timeZone:Type.String()}),r=>workspaces.timezone(scope(r),(r.body as {timeZone:string}).timeZone,key(r)));
 route('GET','/api/v1/workspaces',undefined,S.obj({items:Type.Array(S.Summary)}),r=>workspaces.list(scope(r)));
 route('POST','/api/v1/workspaces',S.obj({displayName:S.Text(120),setAsDefault:Type.Boolean()},S.Strict),S.Detail,r=>workspaces.create(scope(r),r.body as {displayName:string;setAsDefault:boolean},key(r)));
 route('GET','/api/v1/workspaces/:workspaceId',undefined,S.Detail,r=>workspaces.detail(scope(r),wid(r)));
 const ifMatch=(r:FastifyRequest)=>{const v=r.headers['if-match'];if(typeof v!=='string'||v.length>128)throw new DomainError(400,'IF_MATCH_REQUIRED');return v;};
 route('PATCH','/api/v1/workspaces/:workspaceId',S.obj({displayName:S.Text(120)},S.Strict),S.Summary,r=>workspaces.update(scope(r),wid(r),'rename',(r.body as {displayName:string}).displayName,ifMatch(r),key(r)));
 for(const action of ['set-default','disable','restore'] as const)route('POST',`/api/v1/workspaces/:workspaceId/${action}`,undefined,S.Summary,r=>workspaces.update(scope(r),wid(r),action,undefined,ifMatch(r),key(r)));
 route('POST','/api/v1/workspace/retry-create',undefined,S.obj({status:Type.Literal('ready'),workspaceId:S.Id}),r=>workspaces.retry(scope(r),key(r)));
 route('GET','/api/v1/workspaces/current/profile',undefined,S.obj({workspaceId:S.Id,overview:Type.String(),selfDescription:Type.String(),positioning:Type.String(),conclusions:Type.Array(S.obj({profileKind:Type.String(),markdown:Type.String()})),creativePositioning:S.Nullable(S.Positioning)}),r=>workspaces.currentProfile(scope(r)));
 route('POST','/api/v1/onboarding/creative-positioning',S.PositioningBody,S.obj({creativePositioning:S.Positioning,onboardingCompleted:Type.Literal(false)}),r=>workspaces.positioning(scope(r),r.body as PositioningInput,key(r)));
 route('GET','/api/v1/creative-positionings',undefined,S.obj({items:Type.Array(S.Positioning)}),r=>workspaces.positionings(scope(r)));
 route('GET','/api/v1/workspaces/:workspaceId/onboarding-draft',undefined,S.Draft,r=>workspaces.draft(scope(r),wid(r)));
 route('PATCH','/api/v1/workspaces/:workspaceId/onboarding-draft',S.DraftBody,S.Draft,r=>workspaces.saveDraft(scope(r),wid(r),r.body as DraftInput,key(r)));
}
