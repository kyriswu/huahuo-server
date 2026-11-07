import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe,expect,it } from 'vitest';
import { IdentityService,type LoginInput } from '../../src/modules/identity/service.js';
import { mac,normalizePhone } from '../../src/modules/identity/crypto.js';
import { config } from '../helpers.js';

interface SessionFixture {id:string;user_id:string;accessJti:string;accessHash:string;revoked:boolean;}
function fixture(existing=false){
 const cfg=config();cfg.smsProvider='mock';cfg.showTestOtp=true;
 const state:{userId:string;identityId:string;existing:boolean;status:string;deleted:boolean;sessionExpiresAt:Date}={userId:randomUUID(),identityId:randomUUID(),existing,status:'active',deleted:false,sessionExpiresAt:new Date(Date.now()+30*86400*1000)};
 const calls:Array<{sql:string;values:unknown[]}>=[];
 const refreshes=new Map<string,{session_id:string;consumed_at:Date|null;valid:boolean}>();
 let otpHash='',session:SessionFixture|undefined;
 const result=(rows:unknown[]=[])=>({rows,rowCount:rows.length});
 const client={
  async query(sql:string,values:unknown[]=[]){
   calls.push({sql,values});
   if(/^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory)/.test(sql))return result();
   if(sql.startsWith('INSERT INTO auth_rate_limits'))return result([{hits:1}]);
   if(sql.startsWith('SELECT id FROM otp_requests'))return result();
   if(sql.startsWith('INSERT INTO otp_requests')){otpHash=String(values[2]);return result();}
   if(sql.startsWith('SELECT code_hash'))return result([{code_hash:otpHash,attempts:0,valid:true,consumed_at:null,delivery_status:'sent'}]);
   if(sql.startsWith('UPDATE otp_requests'))return result();
   if(sql.startsWith('SELECT id,user_id FROM user_identities'))return result(state.existing?[{id:state.identityId,user_id:state.userId}]:[]);
   if(sql.startsWith('INSERT INTO users')){state.userId=String(values[0]);return result();}
   if(sql.startsWith('INSERT INTO user_identities')){state.existing=true;state.identityId=String(values[0]);return result();}
   if(sql.startsWith('UPDATE user_identities'))return result();
   if(sql.startsWith('SELECT id FROM users'))return result(state.status==='active'&&!state.deleted?[{id:state.userId}]:[]);
   if(sql.startsWith('SELECT id FROM workspaces'))return result([{id:'11111111-1111-4111-8111-111111111111'}]);
   if(sql.startsWith('INSERT INTO user_sessions')){session={id:String(values[0]),user_id:String(values[1]),accessJti:String(values[4]),accessHash:String(values[5]),revoked:false};state.sessionExpiresAt=values[7] as Date;return result();}
   if(sql.startsWith('INSERT INTO refresh_tokens')){refreshes.set(String(values[0]),{session_id:String(values[1]),consumed_at:null,valid:true});return result();}
   if(sql.startsWith('INSERT INTO user_agreement_acceptances')||sql.startsWith('INSERT INTO user_audit_events'))return result();
   if(sql.startsWith('SELECT u.id,u.display_name'))return result([{id:state.userId,display_name:'测试用户',time_zone:'UTC',phoneMasked:'138****0001'}]);
   if(sql.startsWith('SELECT id,updated_at FROM workspaces'))return result([{id:'11111111-1111-4111-8111-111111111111',updated_at:new Date()}]);
   if(sql.startsWith('SELECT p.id,p.name'))return result();
   if(sql.startsWith('SELECT s.id FROM user_sessions'))return result(session&&state.status==='active'&&!state.deleted&&!session.revoked?[{id:session.id}]:[]);
   if(sql.startsWith('UPDATE user_sessions s SET last_seen_at'))return result(session&&state.status==='active'&&!state.deleted&&!session.revoked&&session.accessJti===values[0]&&session.accessHash===values[2]?[session]:[]);
   if(sql.startsWith('SELECT session_id,consumed_at')){const item=refreshes.get(String(values[0]));return result(item?[item]:[]);}
   if(sql.startsWith('SELECT s.id,s.user_id'))return result(session&&state.status==='active'&&!state.deleted?[{...session,expires_at:state.sessionExpiresAt,valid:true,revoked_at:session.revoked?new Date():null}]:[]);
   if(sql.startsWith('UPDATE refresh_tokens')){const item=refreshes.get(String(values[0]));if(item)item.consumed_at=new Date();return result();}
   if(sql.startsWith('UPDATE user_sessions SET access_jti')){if(session){session.accessJti=String(values[0]);session.accessHash=String(values[1]);}return result();}
   if(sql.startsWith('UPDATE user_sessions SET revoked_at')){if(session)session.revoked=true;return result();}
   throw new Error(`Unexpected identity fixture query: ${sql}`);
  },release(){},
 };
 const pool={query:client.query,async connect(){return client;}} as unknown as pg.Pool;
 const service=new IdentityService(pool,cfg);
 async function signIn(clientType:LoginInput['clientType']='app'){
  const phone='13800000001',ticket=await service.sendCode({phone,purpose:'sign_in'},'127.0.0.1');
  if(!ticket.testCode)throw new Error('EXPLICIT_MOCK_OTP_REQUIRED');
  return service.login({phone,smsRequestId:ticket.smsRequestId,smsCode:ticket.testCode,clientType,clientId:'unit-client',agreementAccepted:true,agreementVersion:cfg.agreementVersion,privacyVersion:cfg.privacyVersion,clientVersion:'unit'},'127.0.0.1','trace');
 }
 return {cfg,state,calls,service,signIn};
}

describe('canonical users and phone identities',()=>{
 it('creates a user and verified phone identity without persisting the raw phone',async()=>{
  const f=fixture(),signed=await f.signIn('web');
  expect(signed.firstLogin).toBe(true);expect(signed.user.phoneMasked).toBe('138****0001');
  const identity=f.calls.find(call=>call.sql.startsWith('INSERT INTO user_identities'))!;
  expect(identity.values[2]).toBe(mac(f.cfg.appTokenSecret!,normalizePhone('13800000001')));
  expect(identity.values[2]).toMatch(/^[a-f0-9]{64}$/);expect(identity.values[3]).toBe('138****0001');
  const user=f.calls.find(call=>call.sql.startsWith('INSERT INTO users'))!;expect(user.values).toEqual([f.state.userId,'UTC']);
  const session=f.calls.find(call=>call.sql.startsWith('INSERT INTO user_sessions'))!;expect(session.values.slice(1,4)).toEqual([f.state.userId,'unit-client','web']);
  expect(f.calls.find(call=>call.sql.startsWith('INSERT INTO user_agreement_acceptances'))?.values.at(-1)).toBe('web');
  expect(f.calls.every(call=>!call.values.includes('+8613800000001')&&!call.values.includes('13800000001'))).toBe(true);
  const otp=f.calls.find(call=>call.sql.startsWith('INSERT INTO otp_requests'))!;
  expect(otp.sql).toContain("'phone'");expect(otp.sql).toContain("'sign_in'");expect(otp.sql).toContain('delivery_status');
 });
 it('reuses an existing phone identity and its stable user ID',async()=>{
  const f=fixture(true),id=f.state.userId,signed=await f.signIn();
  expect(signed.firstLogin).toBe(false);expect(signed.user.userId).toBe(id);
  expect(f.calls.some(call=>call.sql.startsWith('INSERT INTO users')||call.sql.startsWith('INSERT INTO user_identities'))).toBe(false);
 });
 it.each(['suspended','deleted'])('does not create a replacement account for an existing %s identity',async status=>{
  const f=fixture(true);f.state.status=status;
  await expect(f.signIn()).rejects.toMatchObject({statusCode:403,code:'AUTH_ACCOUNT_DISABLED'});
  expect(f.calls.some(call=>call.sql.startsWith('INSERT INTO users')||call.sql.startsWith('INSERT INTO user_sessions'))).toBe(false);
 });
 it.each(['suspended','deleted_at'])('blocks access and refresh after account becomes %s',async blocked=>{
  const f=fixture(),signed=await f.signIn();
  await expect(f.service.authenticate(`Bearer ${signed.accessToken}`,'trace')).resolves.toMatchObject({userId:f.state.userId});
  if(blocked==='deleted_at')f.state.deleted=true;else f.state.status=blocked;
  await expect(f.service.authenticate(`Bearer ${signed.accessToken}`,'trace')).rejects.toMatchObject({code:'AUTH_SESSION_EXPIRED'});
  await expect(f.service.refresh(signed.refreshToken,'trace')).rejects.toMatchObject({code:'AUTH_SESSION_EXPIRED'});
 });
 it('bounds refreshed tokens by the remaining absolute session lifetime',async()=>{
  const f=fixture(),signed=await f.signIn();f.state.sessionExpiresAt=new Date(Date.now()+5000);
  const rotated=await f.service.refresh(signed.refreshToken,'trace');
  expect(rotated.expiresIn).toBeGreaterThan(0);expect(rotated.expiresIn).toBeLessThanOrEqual(5);
  expect(new Date(rotated.accessTokenExpiresAt).getTime()).toBeLessThanOrEqual(f.state.sessionExpiresAt.getTime());
  const refresh=f.calls.filter(call=>call.sql.startsWith('INSERT INTO refresh_tokens')).at(-1)!;
  expect(refresh.values[2]).toEqual(f.state.sessionExpiresAt);
 });
 it('rejects refresh when less than one second remains without writing another token',async()=>{
  const f=fixture(),signed=await f.signIn(),count=f.calls.filter(call=>call.sql.startsWith('INSERT INTO refresh_tokens')).length;
  f.state.sessionExpiresAt=new Date(Date.now()+500);
  await expect(f.service.refresh(signed.refreshToken,'trace')).rejects.toMatchObject({code:'AUTH_SESSION_EXPIRED'});
  expect(f.calls.filter(call=>call.sql.startsWith('INSERT INTO refresh_tokens'))).toHaveLength(count);
 });
 it('rotates refresh tokens and revokes the session after token reuse',async()=>{
  const f=fixture(),signed=await f.signIn(),rotated=await f.service.refresh(signed.refreshToken,'trace');
  expect(rotated.rotated).toBe(true);expect(rotated.refreshToken).not.toBe(signed.refreshToken);
  await expect(f.service.authenticate(`Bearer ${signed.accessToken}`,'trace')).rejects.toMatchObject({code:'AUTH_SESSION_EXPIRED'});
  await expect(f.service.authenticate(`Bearer ${rotated.accessToken}`,'trace')).resolves.toMatchObject({userId:f.state.userId});
  await expect(f.service.refresh(signed.refreshToken,'trace')).rejects.toMatchObject({code:'AUTH_SESSION_EXPIRED'});
  await expect(f.service.authenticate(`Bearer ${rotated.accessToken}`,'trace')).rejects.toMatchObject({code:'AUTH_SESSION_EXPIRED'});
 });
});
