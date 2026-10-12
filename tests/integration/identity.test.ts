import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/config/config.js';
import { migrate } from '../../src/db/migrate.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { buildApiServer } from '../../src/apps/api-server.js';
import { buildAdminServer } from '../../src/apps/admin.js';
import { AdminService } from '../../src/modules/admin/service.js';
import { hashPassword, mac } from '../../src/modules/identity/crypto.js';
import { IdentityService } from '../../src/modules/identity/service.js';
const migrationUrl=process.env.TEST_DATABASE_MIGRATION_URL;
if(!migrationUrl||!/^huahuo_test_[a-z0-9_]+$/.test(new URL(migrationUrl).pathname.slice(1)))throw new Error('ISOLATED_TEST_DATABASE_REQUIRED');
const secret='test-app-secret-'.repeat(4),adminSecret='test-admin-secret-'.repeat(4);
const common={...process.env,APP_ENV:'test',LOG_LEVEL:'silent',APP_TOKEN_SECRET:secret,ADMIN_SESSION_SECRET:adminSecret,APP_PUBLIC_BASE_URL:'http://localhost:3000',ADMIN_PUBLIC_BASE_URL:'http://localhost:3001',SMS_PROVIDER:'mock',ALLOW_MOCK_PROVIDERS:'true',SHOW_TEST_OTP:'true'};
const apiConfig=loadConfig('api-server',{...common,DATABASE_URL:process.env.TEST_DATABASE_API_URL});
const adminConfig=loadConfig('admin',{...common,SMS_PROVIDER:'disabled',SHOW_TEST_OTP:'false',DATABASE_URL:process.env.TEST_DATABASE_ADMIN_URL});
const root=poolFor(loadConfig('migrate',{DATABASE_URL:migrationUrl}));
const adminPool=poolFor(adminConfig);
let api:FastifyInstance,admin:FastifyInstance;
let next=100;
interface Session {accessToken:string;refreshToken:string;user:{userId:string};workspace:{workspaceId:string};}
const remote=()=>`127.1.${Math.floor(next/250)}.${next++%250+1}`;
const send=(app:FastifyInstance,url:string,payload?:object,headers:Record<string,string>={},method='POST',ip=remote())=>app.inject({method:method as 'POST',url,payload,headers,remoteAddress:ip});
const auth=(s:Session)=>({authorization:'Bearer '+s.accessToken});
async function ticket(){const phone='1380000'+String(next++).padStart(4,'0');const r=await send(api,'/api/v1/auth/sms-code',{phone,scene:'login'});expect(r.statusCode).toBe(200);return {phone,...r.json().data};}
function loginBody(t:{phone:string;smsRequestId:string;testCode:string},device='fixture-device') {return {phone:t.phone,smsRequestId:t.smsRequestId,smsCode:t.testCode,deviceId:device,agreementAccepted:true,agreementVersion:'2026-08-20',privacyVersion:'2026-08-20',clientVersion:'p02-fixture',timeZone:'Asia/Shanghai'};}
async function login():Promise<Session>{const t=await ticket(),r=await send(api,'/api/v1/auth/login',loginBody(t));expect(r.statusCode).toBe(200);return r.json().data;}
beforeAll(async()=>{await migrate(loadConfig('migrate',{DATABASE_URL:migrationUrl}));api=await buildApiServer({config:apiConfig});admin=await buildAdminServer({config:adminConfig});},20000);
afterAll(async()=>{await api?.close();await admin?.close();await root.end();await adminPool.end();});
describe('P02 real PG identity and scope',()=>{
 it('App login/status/profile response has real required consumer fields',async()=>{
  const s=await login();expect(s.workspace.workspaceId).toMatch(/^[a-f0-9-]{36}$/);
  const r=await send(api,'/api/v1/me/status',undefined,auth(s),'GET');expect(r.statusCode).toBe(200);
  expect(r.json().data.user.phoneMasked).toMatch(/^\d{3}\*{4}\d{4}$/);expect(r.json().data.workspace.status).toBe('ready');
  expect(r.json().data.basicPositioningCompleted).toBe(false);
  const p=await send(api,'/api/v1/me/profile',undefined,auth(s),'GET');expect(p.json().data.profile.displayName).toBe('花火用户');
  const tokens=await root.query('SELECT access_hash FROM user_sessions WHERE user_id=$1',[s.user.userId]);expect(tokens.rows[0].access_hash===s.accessToken).toBe(false);
  expect((await root.query('SELECT count(*)::int n FROM agreement_acceptances WHERE user_id=$1',[s.user.userId])).rows[0].n).toBe(1);
 });
 it('OTP expiry, wrong phone, wrong purpose, attempt limit and repeat consume are rejected',async()=>{
  const t=await ticket();expect((await send(api,'/api/v1/auth/sms-code',{phone:t.phone,scene:'reset-password'})).statusCode).toBe(400);
  const wrong={...loginBody(t),smsCode:t.testCode==='000000'?'111111':'000000'};
  for(let n=0;n<5;n++)expect((await send(api,'/api/v1/auth/login',wrong)).statusCode).toBe(401);
  expect((await send(api,'/api/v1/auth/login',loginBody(t))).statusCode).toBe(429);
  const expired=await ticket();await root.query("UPDATE otp_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.smsRequestId]);
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
 it('repeated login creates one default workspace and current logout preserves other devices',async()=>{
  const t=await ticket(),first=await send(api,'/api/v1/auth/login',loginBody(t,'device-a'));
  await root.query("UPDATE otp_requests SET created_at=now()-interval '61 seconds' WHERE id=$1",[t.smsRequestId]);
  const r=await send(api,'/api/v1/auth/sms-code',{phone:t.phone,scene:'login'});expect(r.statusCode).toBe(200);
  const second=await send(api,'/api/v1/auth/login',loginBody({phone:t.phone,...r.json().data},'device-b'));
  expect(second.statusCode).toBe(200);const a=first.json().data,b=second.json().data;
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
 it('expired access can refresh until absolute refresh expiry; malformed cross-audience tokens rejected',async()=>{
  const s=await login();await root.query("UPDATE user_sessions SET access_expires_at=now()-interval '1 second' WHERE user_id=$1",[s.user.userId]);
  expect((await send(api,'/api/v1/me/status',undefined,auth(s),'GET')).statusCode).toBe(401);
  expect((await send(api,'/api/v1/auth/refresh',{refreshToken:s.refreshToken})).statusCode).toBe(200);
  const e=await login();await root.query("UPDATE user_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",[e.user.userId]);
  expect((await send(api,'/api/v1/auth/refresh',{refreshToken:e.refreshToken})).statusCode).toBe(401);
  expect((await send(api,'/api/v1/me/status',undefined,{authorization:'Bearer admin_'+s.accessToken.slice(4)},'GET')).statusCode).toBe(401);
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
  expect((await send(api,'/api/v1/workspaces/current/profile',undefined,auth(s),'GET')).json().data.conclusions).toEqual([]);
 });
 it('SMS sending is rate limited atomically and same-key retries reuse a receipt',async()=>{
  const phone='1390000'+String(next++).padStart(4,'0'),key=randomUUID(),h={'x-idempotency-key':key};
  const responses=await Promise.all([send(api,'/api/v1/auth/sms-code',{phone,scene:'login'},h),send(api,'/api/v1/auth/sms-code',{phone,scene:'login'},h)]);
  expect(responses.some(r=>r.statusCode===200)).toBe(true);
  const again=await send(api,'/api/v1/auth/sms-code',{phone,scene:'login'},h);expect(again.statusCode).toBe(200);
  expect((await send(api,'/api/v1/auth/sms-code',{phone,scene:'login'})).statusCode).toBe(429);
 });
 it('provider failures do not create usable OTP and disabled SMS never claims success',async()=>{
  const bad=new IdentityService(poolFor(apiConfig),apiConfig,{sms:{mode:'live',send:async()=>{throw new Error('private-provider-key');}}});
  try{await expect(bad.sendCode({phone:'13999990001',scene:'login'},remote())).rejects.toMatchObject({code:'SMS_PROVIDER_FAILED'});
   const row=await root.query('SELECT delivery FROM otp_requests WHERE phone_hash=$1',[mac(secret,'+8613999990001')]);expect(row.rows[0].delivery).toBe('failed');
  }finally{await bad.pool.end();}
  const disabled=new IdentityService(poolFor(apiConfig),{...apiConfig,smsProvider:'disabled'});
  try{await expect(disabled.sendCode({phone:'13999990002',scene:'login'},remote())).rejects.toMatchObject({code:'SMS_NOT_CONFIGURED'});}finally{await disabled.pool.end();}
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
