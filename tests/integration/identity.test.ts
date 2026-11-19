import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadTestConfig as loadConfig } from '../sms-fixture.js';
import { migrate } from '../../src/db/migrate.js';
import { createDependencies, poolFor } from '../../src/plugins/dependencies.js';
import { digest } from '../../src/lib/crypto.js';
import { buildApiServer } from '../../src/apps/api-server.js';
import { buildAdminServer } from '../../src/apps/admin.js';
import { AdminService } from '../../src/modules/admin/service.js';
import { hashPassword, mac } from '../../src/modules/identity/crypto.js';
import { IdentityService } from '../../src/modules/identity/service.js';
import { insertFixtureSession, insertFixtureUser } from './jwt-fixture.js';
import { SendSmsResponse, SendSmsResponseBody } from '@alicloud/dysmsapi20170525';
import { AliyunSmsService, type AliyunSmsSdk } from '../../src/integrations/aliyun-sms.js';
import { AliyunSmsProvider } from '../../src/integrations/sms.js';
import { recordingSms } from '../sms-fixture.js';
const migrationUrl=process.env.TEST_DATABASE_MIGRATION_URL;
if(!migrationUrl||!/^huahuo_test_[a-z0-9_]+$/.test(new URL(migrationUrl).pathname.slice(1)))throw new Error('ISOLATED_TEST_DATABASE_REQUIRED');
const secret='test-app-secret-'.repeat(4),adminSecret='test-admin-secret-'.repeat(4);
const common={...process.env,APP_ENV:'test',LOG_LEVEL:'silent',APP_TOKEN_SECRET:secret,ADMIN_SESSION_SECRET:adminSecret,APP_PUBLIC_BASE_URL:'http://localhost:3000',ADMIN_PUBLIC_BASE_URL:'http://localhost:3001'};
const apiConfig=loadConfig('api-server',{...common,DATABASE_URL:process.env.TEST_DATABASE_API_URL,HUAHUO_STUDIO_AUTH_ENABLED:'true'});
const adminConfig=loadConfig('admin',{...common,DATABASE_URL:process.env.TEST_DATABASE_ADMIN_URL});
const root=poolFor(loadConfig('migrate',{DATABASE_URL:migrationUrl}));
const adminPool=poolFor(adminConfig);
let api:FastifyInstance,admin:FastifyInstance;
let dependencies: ReturnType<typeof createDependencies>;
const transport=recordingSms();
let next=100;
interface Session {accessToken:string;refreshToken:string;user:{userId:string};workspace:{workspaceId:string};}
const remote=()=>`127.1.${Math.floor(next/250)}.${next++%250+1}`;
// Simulate gateway admission for client-facing identity scenarios. The backend
// receives only the authenticated scope, while JWT revocation/rotation is tested
// through the actual auth subrequest endpoint on every protected external request.
const send=async(app:FastifyInstance,url:string,payload?:object,headers:Record<string,string>={},method='POST',ip=remote())=>{
 if(app===api && headers.authorization && url.startsWith('/api/v1/') && !['/api/v1/auth/login','/api/v1/auth/refresh','/api/v1/auth/sms-code'].includes(url)){
  const admission=await app.inject({url:'/internal/v1/gateway/auth',headers:{authorization:headers.authorization},remoteAddress:ip});
  if(admission.statusCode!==204)return admission;
  headers={...headers};delete headers.authorization;
  for(const name of ['x-huahuo-user-id','x-huahuo-session-id','x-huahuo-auth-method'])headers[name]=String(admission.headers[name]);
 }
 return app.inject({method:method as 'POST',url,payload,headers,remoteAddress:ip});
};
const auth=(s:Pick<Session, 'accessToken'>)=>({authorization:'Bearer '+s.accessToken});
async function ticket(){const phone='1380000'+String(next++).padStart(4,'0');const r=await send(api,'/api/v1/auth/sms-code',{phone,purpose:'sign_in'});expect(r.statusCode).toBe(200);const data=r.json().data;expect(data).toMatchObject({providerMode:'live'});expect(data).not.toHaveProperty('testCode');return {phone,...data,code:transport.codeFor(data.smsRequestId)};}
function loginBody(t:{phone:string;smsRequestId:string;code:string},device='fixture-device') {return {phone:t.phone,smsRequestId:t.smsRequestId,smsCode:t.code,clientType:'app' as const,clientId:device,agreementAccepted:true,agreementVersion:'2026-08-20',privacyVersion:'2026-08-20',clientVersion:'p02-fixture',timeZone:'Asia/Shanghai'};}
async function login():Promise<Session>{const t=await ticket(),r=await send(api,'/api/v1/auth/login',loginBody(t));expect(r.statusCode).toBe(200);return r.json().data;}
beforeAll(async()=>{await migrate(loadConfig('migrate',{DATABASE_URL:migrationUrl}));dependencies=createDependencies(apiConfig);api=await buildApiServer({config:apiConfig,sms:transport.sms,dependencies});admin=await buildAdminServer({config:adminConfig});},20000);
afterAll(async()=>{await api?.close();await admin?.close();await root.end();await adminPool.end();});
describe('P02 real PG identity and scope',()=>{
 const bearerKey = (access: string) => `${apiConfig.queuePrefix}:auth:bearer:v1:${apiConfig.jwt.keyId}:${digest(access)}`;
 const admit = (session: Pick<Session, 'accessToken'>) => send(api, '/internal/v1/gateway/auth', undefined, auth(session), 'GET');
 it('caches a verified Bearer session in Redis and skips PostgreSQL on the next admission', async () => {
  const session = await login(), redis = dependencies.bearerCache!;
  const key = bearerKey(session.accessToken);
  expect(await redis.get(key)).toBeNull();
  const query = vi.spyOn(dependencies.pool!, 'query');
  try {
   const first = await admit(session), repeated = await admit(session);
   expect([first.statusCode, repeated.statusCode]).toEqual([204, 204]);
   expect(first.headers['x-trace-id']).not.toEqual(repeated.headers['x-trace-id']);
   expect(JSON.parse((await redis.get(key))!)).toEqual({
    userId: session.user.userId, sessionId: first.headers['x-huahuo-session-id'], expiresAt: expect.any(Number),
   });
   expect(await redis.pttl(key)).toBeGreaterThan(0);
   expect(await redis.pttl(key)).toBeLessThanOrEqual(15_000);
   expect(query.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('WITH admitted AS'))).toHaveLength(1);
   await redis.del(key);
   expect((await admit(session)).statusCode).toBe(204);
   expect(query.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('WITH admitted AS'))).toHaveLength(2);
  } finally { query.mockRestore(); }
 });
 it('replaces the cache on refresh and invalidates it before logout completes', async () => {
  const session = await login(), redis = dependencies.bearerCache!;
  expect((await admit(session)).statusCode).toBe(204);
  const response = await send(api, '/api/v1/auth/refresh', { refreshToken: session.refreshToken });
  expect(response.statusCode).toBe(200);
  const pair = response.json().data;
  expect(await redis.get(bearerKey(session.accessToken))).toBe('!');
  expect(JSON.parse((await redis.get(bearerKey(pair.accessToken)))!).userId).toBe(session.user.userId);
  expect((await admit(session)).statusCode).toBe(401);
  expect((await send(api, '/api/v1/auth/logout', undefined, auth(pair))).statusCode).toBe(200);
  expect(await redis.get(bearerKey(pair.accessToken))).toBe('!');
  expect((await admit(pair)).statusCode).toBe(401);
 });
 it('invalidates a populated cache when PostgreSQL commits an account suspension', async () => {
  const session = await login(), redis = dependencies.bearerCache!;
  expect((await admit(session)).statusCode).toBe(204);
  const key = bearerKey(session.accessToken);
  const client = await root.connect();
  try {
   await client.query('BEGIN');
   await client.query("UPDATE users SET status='suspended' WHERE id=$1", [session.user.userId]);
   expect(JSON.parse((await redis.get(key))!).userId).toBe(session.user.userId);
   await client.query('COMMIT');
  } finally { await client.query('ROLLBACK'); client.release(); }
  await vi.waitFor(async () => expect(await redis.get(key)).toBe('!'));
  expect((await admit(session)).statusCode).toBe(401);
 });
 it.each(['access-expired','session-expired','revoked','missing','wrong-user','suspended'] as const)('rejects direct logout with a %s session without revoking other sessions',async state=>{
  const userId=await insertFixtureUser(root),sessionId=randomUUID(),otherSessionId=randomUUID();
  await insertFixtureSession(root,userId,otherSessionId,'other-active-client');
  if(state!=='missing')await insertFixtureSession(root,state==='wrong-user'?await insertFixtureUser(root):userId,sessionId,'invalid-client');
  if(state==='access-expired')await root.query("UPDATE user_sessions SET access_expires_at=now()-interval '1 second' WHERE id=$1",[sessionId]);
  if(state==='session-expired')await root.query("UPDATE user_sessions SET access_expires_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE id=$1",[sessionId]);
  if(state==='revoked')await root.query('UPDATE user_sessions SET revoked_at=now() WHERE id=$1',[sessionId]);
  if(state==='suspended')await root.query("UPDATE users SET status='suspended' WHERE id=$1",[userId]);
  const headers={'x-huahuo-user-id':userId,'x-huahuo-session-id':sessionId,'x-huahuo-auth-method':'bearer'};
  for(const action of ['logout','logout-all']){
   const response=await api.inject({method:'POST',url:`/api/v1/auth/${action}`,headers});
   expect(response.statusCode).toBe(401);
   expect(response.json().error.code).toBe('AUTH_SESSION_EXPIRED');
  }
  expect((await root.query('SELECT revoked_at FROM user_sessions WHERE id=$1',[otherSessionId])).rows[0].revoked_at).toBeNull();
  expect((await root.query("SELECT count(*)::int n FROM user_audit_events WHERE user_id=$1 AND action IN ('auth.logout','auth.logout_all')",[userId])).rows[0].n).toBe(0);
 });
 it('serializes concurrent direct logout-all calls and preserves other users',async()=>{
  const userId=await insertFixtureUser(root),otherUser=await insertFixtureUser(root),sessions=[randomUUID(),randomUUID()];
  for(const sessionId of sessions)await insertFixtureSession(root,userId,sessionId,sessionId);
  const otherSessionId=randomUUID();await insertFixtureSession(root,otherUser,otherSessionId);
  const responses=await Promise.all(sessions.map(sessionId=>api.inject({method:'POST',url:'/api/v1/auth/logout-all',headers:{'x-huahuo-user-id':userId,'x-huahuo-session-id':sessionId,'x-huahuo-auth-method':'bearer'}})));
  expect(responses.map(response=>response.statusCode).sort()).toEqual([200,401]);
  expect((await root.query('SELECT count(*)::int n FROM user_sessions WHERE user_id=$1 AND revoked_at IS NOT NULL',[userId])).rows[0].n).toBe(2);
  expect((await root.query('SELECT revoked_at FROM user_sessions WHERE id=$1',[otherSessionId])).rows[0].revoked_at).toBeNull();
  expect((await root.query("SELECT count(*)::int n FROM user_audit_events WHERE user_id=$1 AND action='auth.logout_all'",[userId])).rows[0].n).toBe(1);
 });
 it('refreshes Studio cookies once under concurrency and honors logout/account suspension on the next admission',async()=>{
  const s=await login();
  await root.query("UPDATE user_sessions SET access_expires_at=now()-interval '1 second' WHERE user_id=$1",[s.user.userId]);
  const headers={'x-forwarded-method':'GET','x-forwarded-uri':'/agent/api/agents/huox',cookie:`huahuo-studio-access=${s.accessToken}; huahuo-studio-refresh=${s.refreshToken}`};
  const admissions=await Promise.all(Array.from({length:4},()=>send(api,'/internal/v1/gateway/auth',undefined,headers,'GET')));
  expect(admissions.map(r=>r.statusCode)).toEqual([204,204,204,204]);
  expect((await root.query('SELECT count(*)::int n FROM refresh_tokens t JOIN user_sessions s ON s.id=t.session_id WHERE s.user_id=$1',[s.user.userId])).rows[0].n).toBe(2);
  const admission=admissions[0]!;
  expect(admission.headers['x-huahuo-auth-method']).toBe('cookie');
  expect(admission.headers['set-cookie']).toBeUndefined();
  const refreshed=['x-huahuo-studio-access-cookie','x-huahuo-studio-refresh-cookie'].map(name=>String(admission.headers[name]).split(';')[0]).join('; ');
  const businessHeaders=Object.fromEntries(['x-huahuo-user-id','x-huahuo-session-id','x-huahuo-auth-method'].map(name=>[name,String(admission.headers[name])]));
  expect((await api.inject({url:'/api/v1/me/status',headers:businessHeaders})).statusCode).toBe(200);
  expect((await send(api,'/internal/v1/gateway/logout',undefined,{origin:apiConfig.gatewayStudio.origin,cookie:refreshed})).statusCode).toBe(200);
  const repeatedLogout=await send(api,'/internal/v1/gateway/logout',undefined,{origin:apiConfig.gatewayStudio.origin,cookie:refreshed});
  expect(repeatedLogout.statusCode).toBe(200);
  expect(repeatedLogout.headers['set-cookie']).toHaveLength(2);
  expect((repeatedLogout.headers['set-cookie'] as string[]).every(cookie=>cookie.includes('Max-Age=0'))).toBe(true);
  expect((await send(api,'/internal/v1/gateway/auth',undefined,headers,'GET')).statusCode).toBe(401);
  expect((await api.inject({url:'/api/v1/me/status',headers:businessHeaders})).statusCode).toBe(401);
  const suspended=await login();
  await root.query("UPDATE users SET status='suspended' WHERE id=$1",[suspended.user.userId]);
  const blocked=await send(api,'/internal/v1/gateway/auth',undefined,{...headers,cookie:`huahuo-studio-access=${suspended.accessToken}; huahuo-studio-refresh=${suspended.refreshToken}`},'GET');
  expect(blocked.statusCode).toBe(401);
 });
 it('authenticates gateway admission with the same JWT and active user/session checks',async()=>{
  const path='/internal/v1/gateway/auth';
  expect((await send(api,path,undefined,{},'GET')).statusCode).toBe(401);
  expect((await send(api,path,undefined,{authorization:'Bearer fake.jwt.signature'},'GET')).statusCode).toBe(401);
  const s=await login();
  const allowed=await send(api,path,undefined,auth(s),'GET');
  expect(allowed.statusCode).toBe(204);expect(allowed.body).toBe('');
  expect(allowed.headers['x-huahuo-user-id']).toBe(s.user.userId);expect(allowed.headers['x-huahuo-auth-method']).toBe('bearer');
  expect(allowed.headers['x-huahuo-session-id']).toMatch(/^[a-f0-9-]{36}$/);
  await send(api,'/api/v1/auth/logout',undefined,auth(s));
  expect((await send(api,path,undefined,auth(s),'GET')).statusCode).toBe(401);
  const suspended=await login();
  await root.query("UPDATE users SET status='suspended' WHERE id=$1",[suspended.user.userId]);
  expect((await send(api,path,undefined,auth(suspended),'GET')).statusCode).toBe(401);
 });
 it('publishes the Server JWT verification key through JWKS',async()=>{
  const r=await send(api,'/.well-known/jwks.json',undefined,{},'GET');
  expect(r.statusCode).toBe(200);
  expect(r.json().keys).toHaveLength(1);
  expect(r.json().keys[0]).toMatchObject({alg:'EdDSA',use:'sig',key_ops:['verify'],crv:'Ed25519'});
 });
 it('App login/status/profile response has real required consumer fields',async()=>{
  const s=await login();expect(s.workspace.workspaceId).toMatch(/^[a-f0-9-]{36}$/);
  const r=await send(api,'/api/v1/me/status',undefined,auth(s),'GET');expect(r.statusCode).toBe(200);
  expect(r.json().data.user.phoneMasked).toMatch(/^\d{3}\*{4}\d{4}$/);expect(r.json().data.workspace.status).toBe('ready');
  expect(r.json().data).not.toHaveProperty('basicPositioningCompleted');
  const p=await send(api,'/api/v1/me/profile',undefined,auth(s),'GET');expect(p.json().data.profile.displayName).toBe('花火用户');
  const tokens=await root.query('SELECT access_hash FROM user_sessions WHERE user_id=$1',[s.user.userId]);expect(tokens.rows[0].access_hash===s.accessToken).toBe(false);
  expect((await root.query('SELECT count(*)::int n FROM user_agreement_acceptances WHERE user_id=$1',[s.user.userId])).rows[0].n).toBe(1);
 });
 it('OTP expiry, wrong phone, wrong purpose, attempt limit and repeat consume are rejected',async()=>{
  const t=await ticket();expect((await send(api,'/api/v1/auth/sms-code',{phone:t.phone,purpose:'reset-password'})).statusCode).toBe(400);
  const wrong={...loginBody(t),smsCode:t.code==='000000'?'111111':'000000'};
  for(let n=0;n<5;n++)expect((await send(api,'/api/v1/auth/login',wrong)).statusCode).toBe(401);
  expect((await send(api,'/api/v1/auth/login',loginBody(t))).statusCode).toBe(429);
  const expired=await ticket();await root.query("UPDATE otp_requests SET created_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE id=$1",[expired.smsRequestId]);
  expect((await send(api,'/api/v1/auth/login',loginBody(expired))).statusCode).toBe(401);
  const valid=await ticket();expect((await send(api,'/api/v1/auth/login',{...loginBody(valid),phone:'13900009999'})).statusCode).toBe(401);
  expect((await send(api,'/api/v1/auth/login',loginBody(valid))).statusCode).toBe(200);
  expect((await send(api,'/api/v1/auth/login',loginBody(valid))).statusCode).toBe(401);
 });
 it('OTP concurrency consumes once; login idempotency replays only its own transaction',async()=>{
  const t=await ticket();const responses=await Promise.all([send(api,'/api/v1/auth/login',loginBody(t)),send(api,'/api/v1/auth/login',loginBody(t))]);
  expect(responses.map(r=>r.statusCode).sort()).toEqual([200,401]);
  const u=await ticket(),key=randomUUID(),headers={'x-idempotency-key':key};
  const first=await send(api,'/api/v1/auth/login',loginBody(u),headers),second=await send(api,'/api/v1/auth/login',loginBody(u),headers);
  expect([first.statusCode,second.statusCode]).toEqual([200,200]);expect(first.json().data.accessToken===second.json().data.accessToken).toBe(true);
  const changed=await send(api,'/api/v1/auth/login',loginBody(u,'different-device'),headers);expect(changed.statusCode).toBe(409);
  const s=first.json().data;expect((await root.query('SELECT count(*)::int n FROM workspaces WHERE user_id=$1',[s.user.userId])).rows[0].n).toBe(1);
  const persisted=await root.query('SELECT response_cipher FROM api_idempotency WHERE key=$1',[key]);expect(persisted.rows[0].response_cipher.includes(s.refreshToken)).toBe(false);
 });
 it('App and Web login share one user and default workspace while current logout preserves the other client',async()=>{
  const t=await ticket(),first=await send(api,'/api/v1/auth/login',loginBody(t,'device-a'));
  await root.query("UPDATE otp_requests SET created_at=now()-interval '61 seconds' WHERE id=$1",[t.smsRequestId]);
  const r=await send(api,'/api/v1/auth/sms-code',{phone:t.phone,purpose:'sign_in'});expect(r.statusCode).toBe(200);
  const secondTicket=r.json().data;
  const second=await send(api,'/api/v1/auth/login',{...loginBody({phone:t.phone,...secondTicket,code:transport.codeFor(secondTicket.smsRequestId)},'browser-b'),clientType:'web'});
  expect(second.statusCode).toBe(200);const a=first.json().data,b=second.json().data;
  expect(a.user.userId).toBe(b.user.userId);
  expect((await root.query('SELECT client_type FROM user_sessions WHERE user_id=$1 ORDER BY client_type',[a.user.userId])).rows.map(row=>row.client_type)).toEqual(['app','web']);
  expect((await root.query('SELECT accepted_via FROM user_agreement_acceptances WHERE user_id=$1 ORDER BY accepted_via',[a.user.userId])).rows.map(row=>row.accepted_via)).toEqual(['app','web']);
  expect(a.workspace.workspaceId).toBe(b.workspace.workspaceId);
  expect((await send(api,'/api/v1/auth/logout',undefined,auth(a))).statusCode).toBe(200);
  expect((await send(api,'/api/v1/me/status',undefined,auth(a),'GET')).statusCode).toBe(401);
  expect((await send(api,'/api/v1/me/status',undefined,auth(b),'GET')).statusCode).toBe(200);
  expect((await send(api,'/api/v1/auth/logout-all',undefined,auth(b))).statusCode).toBe(200);
  expect((await send(api,'/api/v1/auth/refresh',{refreshToken:b.refreshToken})).statusCode).toBe(401);
 });
 it('refresh rotates, rejects old access, and reuse revokes the current family',async()=>{
  const s=await login();const r=await send(api,'/api/v1/auth/refresh',{refreshToken:s.refreshToken});expect(r.statusCode).toBe(200);const pair=r.json().data;
  expect(pair.rotated).toBe(true);expect(pair.refreshToken===s.refreshToken).toBe(false);
  expect((await send(api,'/api/v1/me/status',undefined,auth(s),'GET')).statusCode).toBe(401);
  expect((await send(api,'/api/v1/me/status',undefined,{authorization:'Bearer '+pair.accessToken},'GET')).statusCode).toBe(200);
  expect((await send(api,'/api/v1/auth/refresh',{refreshToken:s.refreshToken})).statusCode).toBe(401);
  expect((await send(api,'/api/v1/auth/refresh',{refreshToken:pair.refreshToken})).statusCode).toBe(401);
  expect((await send(api,'/api/v1/me/status',undefined,{authorization:'Bearer '+pair.accessToken},'GET')).statusCode).toBe(401);
 });
 it('atomically consumes a Refresh Token once under concurrent requests and revokes the reused session',async()=>{
  const s=await login();
  const responses=await Promise.all([
   send(api,'/api/v1/auth/refresh',{refreshToken:s.refreshToken}),
   send(api,'/api/v1/auth/refresh',{refreshToken:s.refreshToken}),
  ]);
  expect(responses.map(response=>response.statusCode).sort()).toEqual([200,401]);
  const pair=responses.find(response=>response.statusCode===200)!.json().data;
  expect((await root.query('SELECT count(*)::int n FROM refresh_tokens t JOIN user_sessions s ON s.id=t.session_id WHERE s.user_id=$1',[s.user.userId])).rows[0].n).toBe(2);
  expect((await root.query('SELECT revoked_at IS NOT NULL AS revoked FROM user_sessions WHERE user_id=$1',[s.user.userId])).rows[0].revoked).toBe(true);
  expect((await root.query("SELECT count(*)::int n FROM user_audit_events WHERE user_id=$1 AND action='auth.refresh_reuse'",[s.user.userId])).rows[0].n).toBe(1);
  expect((await send(api,'/api/v1/me/status',undefined,{authorization:'Bearer '+pair.accessToken},'GET')).statusCode).toBe(401);
  expect((await send(api,'/api/v1/auth/refresh',{refreshToken:pair.refreshToken})).statusCode).toBe(401);
 });
 it('expired access can refresh until absolute refresh expiry; malformed cross-audience tokens rejected',async()=>{
  const s=await login();await root.query("UPDATE user_sessions SET created_at=now()-interval '2 seconds',access_expires_at=now()-interval '1 second' WHERE user_id=$1",[s.user.userId]);
  expect((await send(api,'/api/v1/me/status',undefined,auth(s),'GET')).statusCode).toBe(401);
  expect((await send(api,'/api/v1/auth/refresh',{refreshToken:s.refreshToken})).statusCode).toBe(200);
  const e=await login();await root.query("UPDATE user_sessions SET created_at=now()-interval '3 seconds',access_expires_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE user_id=$1",[e.user.userId]);
  expect((await send(api,'/api/v1/auth/refresh',{refreshToken:e.refreshToken})).statusCode).toBe(401);
  expect((await send(api,'/api/v1/me/status',undefined,{authorization:'Bearer admin_'+s.accessToken.slice(4)},'GET')).statusCode).toBe(401);
 });
 it('rejects valid tokens after their account or session relation disappears',async()=>{
  const account=await login();
  await root.query('DELETE FROM users WHERE id=$1',[account.user.userId]);
  expect((await send(api,'/api/v1/me/status',undefined,auth(account),'GET')).statusCode).toBe(401);
  expect((await send(api,'/api/v1/auth/refresh',{refreshToken:account.refreshToken})).statusCode).toBe(401);
  const session=await login();
  await root.query('DELETE FROM user_sessions WHERE user_id=$1',[session.user.userId]);
  expect((await send(api,'/api/v1/auth/refresh',{refreshToken:session.refreshToken})).statusCode).toBe(401);
 });
 it('two users cannot read or mutate each other; forged identity header/body is ineffective',async()=>{
  const a=await login(),b=await login(),path='/api/v1/workspaces/'+b.workspace.workspaceId;
  expect((await send(api,path,undefined,{...auth(a),'x-user-id':b.user.userId},'GET')).statusCode).toBe(404);
  expect((await send(api,path,{displayName:'tamper'},{...auth(a),'x-idempotency-key':randomUUID(),'if-match':'fake'},'PATCH')).statusCode).toBe(404);
  const draft={mode:'business',stepIndex:1,answers:{productDescription:'fixture'},deferred:true,expectedVersion:0};
  expect((await send(api,path+'/onboarding-draft',draft,{...auth(a),'x-idempotency-key':randomUUID()},'PATCH')).statusCode).toBe(404);
  expect((await send(api,'/api/v1/me/profile',{displayName:'Name',userId:b.user.userId},{...auth(a),'x-idempotency-key':randomUUID()},'PATCH')).statusCode).toBe(400);
  expect((await send(api,'/api/v1/me/profile',{displayName:'Name',avatarResourceId:randomUUID()},{...auth(a),'x-idempotency-key':randomUUID()},'PATCH')).statusCode).toBe(409);
 });
 it('workspaces create/switch/ETag/idempotency; default cannot be disabled',async()=>{
  const s=await login(),key=randomUUID(),h={...auth(s),'x-idempotency-key':key};
  const create=await send(api,'/api/v1/workspaces',{displayName:'第二空间',setAsDefault:false},h);expect(create.statusCode).toBe(200);
  const w=create.json().data;expect(w.contentCursor).toBe('0');expect(w.bootstrapReceiptId).toMatch(/^[a-f0-9-]{36}$/);
  const replay=await send(api,'/api/v1/workspaces',{displayName:'第二空间',setAsDefault:false},h);expect(replay.json().data.workspaceId).toBe(w.workspaceId);
  const path='/api/v1/workspaces/'+w.workspaceId;
  const sw=await send(api,path+'/set-default',undefined,{...auth(s),'x-idempotency-key':randomUUID(),'if-match':w.etag});expect(sw.statusCode).toBe(200);
  expect((await send(api,'/api/v1/me/status',undefined,auth(s),'GET')).json().data.workspace.workspaceId).toBe(w.workspaceId);
  expect((await send(api,path,{displayName:'stale'},{...auth(s),'x-idempotency-key':randomUUID(),'if-match':w.etag},'PATCH')).statusCode).toBe(412);
  expect((await send(api,path+'/disable',undefined,{...auth(s),'x-idempotency-key':randomUUID(),'if-match':sw.json().data.etag})).statusCode).toBe(409);
 });
 it('profile/timezone and draft persist with revisions; positioning does not invent AI completion',async()=>{
  const s=await login(),h=()=>({...auth(s),'x-idempotency-key':randomUUID()});
  expect((await send(api,'/api/v1/me/profile',{displayName:'测试创作者'},h(),'PATCH')).statusCode).toBe(200);
  expect((await send(api,'/api/v1/me/timezone',{timeZone:'Asia/Shanghai'},h(),'PUT')).statusCode).toBe(200);
  expect((await send(api,'/api/v1/me/timezone',{timeZone:'Invalid/Zone'},h(),'PUT')).statusCode).toBe(400);
  const path='/api/v1/workspaces/'+s.workspace.workspaceId+'/onboarding-draft';
  const input={mode:'business',stepIndex:1,answers:{productDescription:'产品'},deferred:true,expectedVersion:0};
  const saved=await send(api,path,input,h(),'PATCH');expect(saved.statusCode).toBe(200);expect(saved.json().data.version).toBe(1);expect(saved.json().data.deferredAt).not.toBeNull();
  expect((await send(api,path,input,h(),'PATCH')).statusCode).toBe(409);
  expect((await send(api,path,undefined,auth(s),'GET')).json().data.answers.productDescription).toBe('产品');
  const p=await send(api,'/api/v1/onboarding/creative-positioning',{name:'科技写作',industry:'科技',accountGoal:'知识分享',commonExpressions:[]},h());expect(p.statusCode).toBe(200);expect(p.json().data.onboardingCompleted).toBe(false);
  expect((await send(api,'/api/v1/creative-positionings',undefined,auth(s),'GET')).json().data.items[0].creativePositioningId).toBe(p.json().data.creativePositioning.creativePositioningId);
  const profile=(await send(api,'/api/v1/workspaces/current/profile',undefined,auth(s),'GET')).json().data;
  expect(profile.creativePositioning.creativePositioningId).toBe(p.json().data.creativePositioning.creativePositioningId);
  expect(Object.keys(profile).sort()).toEqual(['creativePositioning','workspaceId']);
  expect(profile.creativePositioning).not.toHaveProperty('contentLineId');
 });
 it('SMS sending is rate limited atomically and same-key retries reuse a receipt',async()=>{
  const phone='1390000'+String(next++).padStart(4,'0'),key=randomUUID(),h={'x-idempotency-key':key};
  const responses=await Promise.all([send(api,'/api/v1/auth/sms-code',{phone,purpose:'sign_in'},h),send(api,'/api/v1/auth/sms-code',{phone,purpose:'sign_in'},h)]);
  expect(responses.some(r=>r.statusCode===200)).toBe(true);
  const again=await send(api,'/api/v1/auth/sms-code',{phone,purpose:'sign_in'},h);expect(again.statusCode).toBe(200);
  expect((await send(api,'/api/v1/auth/sms-code',{phone,purpose:'sign_in'})).statusCode).toBe(429);
 });
 it('provider failures do not create usable OTP and missing configuration never claims success',async()=>{
  const bad=new IdentityService(poolFor(apiConfig),apiConfig,{sms:{send:async()=>{throw new Error('private-provider-key');}}});
  try{await expect(bad.sendCode({phone:'13999990001',purpose:'sign_in'},remote())).rejects.toMatchObject({code:'SMS_PROVIDER_FAILED'});
   const row=await root.query('SELECT delivery_status FROM otp_requests WHERE subject_hash=$1',[mac(secret,'+8613999990001')]);expect(row.rows[0].delivery_status).toBe('failed');
  }finally{await bad.pool.end();}
  expect(()=>new IdentityService(root,{...apiConfig,smsAliyun:undefined})).toThrow('INVALID_CONFIG:SMS_ALIYUN');
 });
 it('rejects pre-upgrade simulated receipts and codes without resending',async()=>{
  const phone='13999990005',key=randomUUID(),headers={'x-idempotency-key':key};
  const sent=await send(api,'/api/v1/auth/sms-code',{phone,purpose:'sign_in'},headers);
  expect(sent.statusCode).toBe(200);
  const ticket=sent.json().data,code=transport.codeFor(ticket.smsRequestId),count=transport.messages.size;
  await root.query("UPDATE otp_requests SET provider_mode='mock' WHERE id=$1",[ticket.smsRequestId]);
  const replay=await send(api,'/api/v1/auth/sms-code',{phone,purpose:'sign_in'},headers);
  expect(replay.statusCode).toBe(409);expect(replay.json().error.code).toBe('SMS_DELIVERY_NOT_CONFIRMED');
  const login=await send(api,'/api/v1/auth/login',loginBody({phone,smsRequestId:ticket.smsRequestId,code}));
  expect(login.statusCode).toBe(401);expect(login.json().error.code).toBe('SMS_CODE_EXPIRED');
  expect(transport.messages.size).toBe(count);
 });
 it('live OTP acceptance is durable and same-key replay never resends (mock SDK, real PG)',async()=>{
  const config=loadConfig('api-server',{...common,DATABASE_URL:process.env.TEST_DATABASE_API_URL,
   ALIYUN_RAM_ACCESS_KEY_ID:'fixture-id',ALIYUN_RAM_ACCESS_KEY_SECRET:'fixture-secret',SMS_ALIYUN_SIGN_NAME:'花火测试',SMS_ALIYUN_TEMPLATE_CODE:'SMS_123456'});
  const sdkSend=vi.fn<AliyunSmsSdk['sendSmsWithOptions']>().mockResolvedValue(new SendSmsResponse({
   statusCode:200,body:new SendSmsResponseBody({code:'OK',bizId:'123^456',requestId:randomUUID()})}));
  const sms=new AliyunSmsProvider(config.smsAliyun!,new AliyunSmsService(config.smsAliyun!,{
   sendSmsWithOptions:sdkSend,querySendDetailsWithOptions:vi.fn<AliyunSmsSdk['querySendDetailsWithOptions']>()}));
  const service=new IdentityService(poolFor(config),config,{sms});
  const phone='13999990003',key=randomUUID(),ip=remote();
  try{
   const ticket=await service.sendCode({phone,purpose:'sign_in'},ip,key);
   expect(ticket).toMatchObject({providerMode:'live',cooldownSeconds:60});
   expect(ticket).not.toHaveProperty('testCode');
   expect(await service.sendCode({phone,purpose:'sign_in'},ip,key)).toEqual(ticket);
   expect(sdkSend).toHaveBeenCalledTimes(1);
   const code=(JSON.parse(sdkSend.mock.calls[0]![0].templateParam!) as {code:string}).code;
   expect(code).toMatch(/^\d{6}$/);
   const row=await root.query('SELECT delivery_status,code_hash,response_cipher FROM otp_requests WHERE id=$1',[ticket.smsRequestId]);
   expect(row.rows[0].delivery_status).toBe('sent');
   expect(row.rows[0].code_hash).toBe(mac(secret,ticket.smsRequestId+':'+code));
   expect(row.rows[0].response_cipher).not.toContain(code);
   const session=await service.login(loginBody({phone,smsRequestId:ticket.smsRequestId,code}),ip,randomUUID());
   expect(session.user.userId).toMatch(/^[a-f0-9-]{36}$/);
  }finally{await service.pool.end();}
 });
 it('an ambiguous SDK timeout stays pending and cannot be replayed or used to log in (real PG)',async()=>{
  const config=loadConfig('api-server',{...common,DATABASE_URL:process.env.TEST_DATABASE_API_URL,
   ALIYUN_RAM_ACCESS_KEY_ID:'fixture-id',ALIYUN_RAM_ACCESS_KEY_SECRET:'fixture-secret',SMS_ALIYUN_SIGN_NAME:'花火测试',SMS_ALIYUN_TEMPLATE_CODE:'SMS_123456'});
  const sdkSend=vi.fn<AliyunSmsSdk['sendSmsWithOptions']>().mockRejectedValue(Object.assign(new Error('private signed request'),{code:'ETIMEDOUT'}));
  const sms=new AliyunSmsProvider(config.smsAliyun!,new AliyunSmsService(config.smsAliyun!,{
   sendSmsWithOptions:sdkSend,querySendDetailsWithOptions:vi.fn<AliyunSmsSdk['querySendDetailsWithOptions']>()}));
  const service=new IdentityService(poolFor(config),config,{sms});
  const phone='13999990004',key=randomUUID(),ip=remote();
  try{
   await expect(service.sendCode({phone,purpose:'sign_in'},ip,key)).rejects.toMatchObject({code:'SMS_PROVIDER_FAILED'});
   const row=await root.query('SELECT id,delivery_status FROM otp_requests WHERE subject_hash=$1',[mac(secret,'+86'+phone)]);
   expect(row.rows[0].delivery_status).toBe('pending');
   await expect(service.sendCode({phone,purpose:'sign_in'},ip,key)).rejects.toMatchObject({code:'SMS_DELIVERY_NOT_CONFIRMED'});
   await expect(service.sendCode({phone,purpose:'sign_in'},ip)).rejects.toMatchObject({code:'SMS_RATE_LIMITED'});
   const code=(JSON.parse(sdkSend.mock.calls[0]![0].templateParam!) as {code:string}).code;
   await expect(service.login(loginBody({phone,smsRequestId:row.rows[0].id,code}),ip,randomUUID())).rejects.toMatchObject({code:'SMS_CODE_EXPIRED'});
   expect(sdkSend).toHaveBeenCalledTimes(1);
  }finally{await service.pool.end();}
 });
});
describe('independent admin identity, CSRF and RBAC',()=>{
 const password='fixture-random-admin-password-12345';let adminId:string;
 beforeAll(async()=>{const result=await new AdminService(adminPool,adminSecret).bootstrap('p02admin',password);adminId=result.adminId;});
 async function adminLogin(username='p02admin',pw=password){return send(admin,'/admin/api/v1/login',{username,password:pw},{origin:'http://localhost:3001'});}
 function adminHeaders(r:Awaited<ReturnType<typeof adminLogin>>){return {cookie:String(r.headers['set-cookie']).split(';')[0]!,origin:'http://localhost:3001','x-csrf-token':r.json().data.csrfToken};}
 it('bootstrap is one-time; normal App token has no admin authority',async()=>{
  await expect(new AdminService(adminPool,adminSecret).bootstrap('secondadmin',password)).rejects.toMatchObject({code:'ADMIN_ALREADY_BOOTSTRAPPED'});
  const s=await login();expect((await send(admin,'/admin/api/v1/me',undefined,auth(s),'GET')).statusCode).toBe(401);
  expect((await send(api,'/admin/api/v1/me',undefined,auth(s),'GET')).statusCode).toBe(404);
 });
 it('cookie session/CSRF/Origin/logout work and no default password exists',async()=>{
  expect((await send(admin,'/admin/api/v1/login',{username:'p02admin',password})).statusCode).toBe(403);
  const r=await adminLogin();expect(r.statusCode).toBe(200);const h=adminHeaders(r);expect(String(r.headers['set-cookie'])).toContain('HttpOnly; SameSite=Strict; Path=/admin');
  expect((await send(admin,'/admin/api/v1/me',undefined,{cookie:h.cookie},'GET')).statusCode).toBe(200);
  expect((await send(admin,'/admin/api/v1/logout',undefined,{cookie:h.cookie,origin:h.origin})).statusCode).toBe(403);
  expect((await send(admin,'/admin/api/v1/logout',undefined,{...h,origin:'https://evil.invalid'})).statusCode).toBe(403);
  expect((await send(admin,'/admin/api/v1/logout',undefined,h)).statusCode).toBe(200);
  expect((await send(admin,'/admin/api/v1/me',undefined,{cookie:h.cookie},'GET')).statusCode).toBe(401);
 });
 it('operator cannot revoke; superadmin/CLI revoke with append-only audit',async()=>{
  const operatorId=randomUUID();await root.query("INSERT INTO admin_users(id,username,password_hash,role) VALUES($1,'operator',$2,'operator')",[operatorId,await hashPassword(password)]);
  const op=await adminLogin('operator');expect(op.statusCode).toBe(200);
  expect((await send(admin,`/admin/api/v1/sessions/${adminId}/revoke`,{reason:'fixture'},adminHeaders(op))).statusCode).toBe(403);
  const su=await adminLogin();expect(su.statusCode).toBe(200);
  const revoke=await send(admin,`/admin/api/v1/sessions/${operatorId}/revoke`,{reason:'fixture revoke'},adminHeaders(su));expect(revoke.statusCode).toBe(200);
  expect((await send(admin,'/admin/api/v1/me',undefined,{cookie:adminHeaders(op).cookie},'GET')).statusCode).toBe(401);
  await new AdminService(adminPool,adminSecret).revokeCli('p02admin','test CLI revoke');
  expect((await send(admin,'/admin/api/v1/me',undefined,{cookie:adminHeaders(su).cookie},'GET')).statusCode).toBe(401);
  await expect(adminPool.query('DELETE FROM admin_audit_events')).rejects.toThrow();
  const r=await root.query("SELECT count(*)::int n FROM admin_audit_events WHERE action='admin.revoke_sessions'");expect(r.rows[0].n).toBe(1);
 });
 it('unknown account login attempts are bounded too',async()=>{
  for(let i=0;i<5;i++)expect((await adminLogin('missingadmin','wrong-password')).statusCode).toBe(401);
  expect((await adminLogin('missingadmin','wrong-password')).statusCode).toBe(429);
 });
 it('runtime DB grants prevent App role reading admin identities and vice versa',async()=>{
  const apiPool=poolFor(apiConfig);try{await expect(apiPool.query('SELECT * FROM admin_users')).rejects.toThrow();await expect(adminPool.query('SELECT * FROM user_sessions')).rejects.toThrow();}finally{await apiPool.end();}
 });
});
