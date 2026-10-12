import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/config.js';
import { MockSmsProvider, DisabledSmsProvider, type SmsProvider } from '../../integrations/sms.js';
import { constantEqual, digest, mac, maskedPhone, normalizePhone, otpCode, seal, token, unseal, canonical } from './crypto.js';
import { DomainError, transaction, lock, idempotent, audit, type Scope, rateLimit } from './store.js';
export interface LoginInput { phone:string; smsRequestId:string; smsCode:string; deviceId:string; agreementAccepted:boolean; agreementVersion:string; privacyVersion:string; clientVersion:string; timeZone?:string; }
export interface TokenPair { tokenType:'Bearer'; accessToken:string; refreshToken:string; accessTokenExpiresAt:string; expiresIn:number; rotated:boolean; }
export interface IdentityOptions { sms?: SmsProvider; }
export class IdentityService {
  private readonly secret: string;
  readonly sms: SmsProvider;
  constructor(readonly pool: pg.Pool, readonly config: AppConfig, options: IdentityOptions = {}) {
    if (!config.appTokenSecret) throw new Error('APP_TOKEN_SECRET_REQUIRED');
    this.secret=config.appTokenSecret;
    this.sms=options.sms ?? (config.smsProvider === 'mock' ? new MockSmsProvider() : new DisabledSmsProvider());
    if (config.appEnv === 'production' && this.sms.mode === 'mock') throw new Error('PRODUCTION_MOCK_FORBIDDEN');
  }
  async sendCode(input:{phone:string;scene:string}, ip:string, key?:string) {
    const phone=normalizePhone(input.phone), phoneHash=mac(this.secret,phone);
    if(input.scene!=='login')throw new DomainError(400,'SMS_PURPOSE_INVALID');
    if(this.sms.mode==='disabled')throw new DomainError(503,'SMS_NOT_CONFIGURED');
    const code=otpCode(), id=randomUUID(), hash=mac(this.secret,canonical({phone,scene:input.scene}));
    const data={smsRequestId:id,cooldownSeconds:60,providerMode:this.sms.mode,...(this.config.showTestOtp&&this.sms.mode==='mock'?{testCode:code}:{})};
    const existing=await transaction(this.pool,async tx=>{
      await lock(tx,'phone:'+phoneHash);
      if(key){
        const r=await tx.query<{request_hash:string;response_cipher:string;delivery:string;valid:boolean}>('SELECT request_hash,response_cipher,delivery,expires_at>now() valid FROM otp_requests WHERE phone_hash=$1 AND request_key=$2',[phoneHash,key]);
        if(r.rows[0]){
          if(r.rows[0].request_hash!==hash)throw new DomainError(409,'IDEMPOTENCY_CONFLICT');
          if(!r.rows[0].valid)throw new DomainError(409,'IDEMPOTENCY_KEY_EXPIRED');
          if(r.rows[0].delivery!=='sent')throw new DomainError(409,'SMS_DELIVERY_NOT_CONFIRMED');
          return unseal<typeof data>(r.rows[0].response_cipher,this.secret);
        }
      }
      await rateLimit(tx,'sms-ip:'+mac(this.secret,ip),20,3600);
      await rateLimit(tx,'sms-day:'+phoneHash,10,86400);
      const recent=await tx.query('SELECT id FROM otp_requests WHERE phone_hash=$1 AND created_at>now()-interval \'60 seconds\' LIMIT 1',[phoneHash]);
      if(recent.rowCount)throw new DomainError(429,'SMS_RATE_LIMITED',true);
      await tx.query(`INSERT INTO otp_requests(id,phone_hash,purpose,code_hash,delivery,provider_mode,request_key,request_hash,response_cipher,expires_at)
       VALUES($1,$2,'login',$3,'pending',$4,$5,$6,$7,now()+interval '5 minutes')`,[id,phoneHash,mac(this.secret,`${id}:${code}`),this.sms.mode,key??null,hash,seal(data,this.secret)]);
      return null;
    });
    if(existing)return existing;
    try { await this.sms.send({phone,code,purpose:'login',requestId:id}); }
    catch { await this.pool.query("UPDATE otp_requests SET delivery='failed' WHERE id=$1",[id]);throw new DomainError(503,'SMS_PROVIDER_FAILED'); }
    await this.pool.query("UPDATE otp_requests SET delivery='sent' WHERE id=$1",[id]);
    return data;
  }
  async login(input:LoginInput,ip:string,traceId:string,key?:string) {
    const phone=normalizePhone(input.phone), phoneHash=mac(this.secret,phone);
    if(!this.config.agreementVersion||!this.config.privacyVersion)throw new DomainError(503,'LEGAL_VERSIONS_NOT_CONFIGURED');
    if(!input.agreementAccepted || input.agreementVersion!==this.config.agreementVersion || input.privacyVersion!==this.config.privacyVersion)throw new DomainError(400,'AGREEMENT_REQUIRED');
    const zone=validateTimeZone(input.timeZone??'UTC');
    await transaction(this.pool,async tx=>rateLimit(tx,'login:'+mac(this.secret,ip),60,600));
    return transaction(this.pool,async tx=>{
      await lock(tx,'phone:'+phoneHash);
      const result=await idempotent(tx,this.secret,'login:'+phoneHash,'login',key,mac(this.secret,canonical(input)),async()=>{
        const r=await tx.query<{code_hash:string;attempts:number;valid:boolean;consumed_at:Date|null;delivery:string}>("SELECT code_hash,attempts,expires_at>now() valid,consumed_at,delivery FROM otp_requests WHERE id=$1 AND phone_hash=$2 AND purpose='login' FOR UPDATE",[input.smsRequestId,phoneHash]);
        const otp=r.rows[0];
        if(!otp||!otp.valid||otp.consumed_at||otp.delivery!=='sent')throw new DomainError(401,'SMS_CODE_EXPIRED');
        if(otp.attempts>=5)throw new DomainError(429,'SMS_CODE_ATTEMPTS_EXCEEDED');
        if(!constantEqual(otp.code_hash,mac(this.secret,`${input.smsRequestId}:${input.smsCode}`))){
          await tx.query('UPDATE otp_requests SET attempts=attempts+1 WHERE id=$1',[input.smsRequestId]);
          throw new DomainError(401,'SMS_CODE_INVALID',true);
        }
        await tx.query('UPDATE otp_requests SET consumed_at=now() WHERE id=$1',[input.smsRequestId]);
        const prior=await tx.query<{id:string}>('SELECT id FROM app_users WHERE phone_hash=$1',[phoneHash]);
        const firstLogin=!prior.rows[0], userId=prior.rows[0]?.id??randomUUID();
        if(firstLogin)await tx.query('INSERT INTO app_users(id,phone_hash,phone_masked,time_zone) VALUES($1,$2,$3,$4)',[userId,phoneHash,maskedPhone(phone),zone]);
        await tx.query('SELECT id FROM app_users WHERE id=$1 FOR UPDATE',[userId]);
        await ensureDefault(tx,userId);
        const sessionId=randomUUID(), pair=makePair();
        await tx.query(`INSERT INTO user_sessions(id,user_id,device_id,access_hash,access_expires_at,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '30 days')`,[sessionId,userId,input.deviceId,digest(pair.accessToken),pair.accessTokenExpiresAt]);
        await tx.query('INSERT INTO refresh_tokens(token_hash,session_id) VALUES($1,$2)',[digest(pair.refreshToken),sessionId]);
        await tx.query(`INSERT INTO agreement_acceptances(id,user_id,session_id,agreement_version,privacy_version,action) VALUES($1,$2,$3,$4,$5,'sms_login')`,[randomUUID(),userId,sessionId,input.agreementVersion,input.privacyVersion]);
        await audit(tx,{userId,sessionId,traceId},'auth.login',sessionId);
        const state=await status(tx,{userId,sessionId,traceId});
        return {...pair,...state,firstLogin};
      },300);
      // Never replay a cached login result after refresh/logout/revocation.
      const active=await tx.query('SELECT id FROM user_sessions WHERE access_hash=$1 AND revoked_at IS NULL AND access_expires_at>now() AND expires_at>now()',[digest(result.accessToken)]);
      if(!active.rowCount)throw new DomainError(409,'LOGIN_REPLAY_EXPIRED');
      return result;
    });
  }
  async authenticate(authorization: string | undefined, traceId:string):Promise<Scope> {
    const access=authorization?.match(/^Bearer (app_[A-Za-z0-9_-]{43})$/)?.[1];
    if(!access)throw new DomainError(401,'UNAUTHORIZED');
    const r=await this.pool.query<{id:string;user_id:string}>('SELECT id,user_id FROM user_sessions WHERE access_hash=$1 AND revoked_at IS NULL AND access_expires_at>now() AND expires_at>now()',[digest(access)]);
    if(!r.rows[0])throw new DomainError(401,'AUTH_SESSION_EXPIRED');
    return Object.freeze({userId:r.rows[0].user_id,sessionId:r.rows[0].id,traceId});
  }
  async refresh(refresh:string,traceId:string) {
    if(!/^refresh_[A-Za-z0-9_-]{43}$/.test(refresh))throw new DomainError(401,'AUTH_SESSION_EXPIRED');
    return transaction(this.pool,async tx=>{
      const found=await tx.query<{session_id:string}>('SELECT session_id FROM refresh_tokens WHERE token_hash=$1',[digest(refresh)]);
      if(!found.rows[0])throw new DomainError(401,'AUTH_SESSION_EXPIRED');
      const r=await tx.query<{id:string;user_id:string;valid:boolean;revoked_at:Date|null}>('SELECT id,user_id,expires_at>now() valid,revoked_at FROM user_sessions WHERE id=$1 FOR UPDATE',[found.rows[0].session_id]);
      const s=r.rows[0]!;
      const previous=await tx.query<{consumed_at:Date|null}>('SELECT consumed_at FROM refresh_tokens WHERE token_hash=$1',[digest(refresh)]);
      if(previous.rows[0]?.consumed_at){
        await tx.query('UPDATE user_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1',[s.id]);
        await audit(tx,{userId:s.user_id,sessionId:s.id,traceId},'auth.refresh_reuse',s.id);
        throw new DomainError(401,'AUTH_SESSION_EXPIRED',true);
      }
      if(s.revoked_at||!s.valid)throw new DomainError(401,'AUTH_SESSION_EXPIRED');
      const pair=makePair(true);
      await tx.query('UPDATE refresh_tokens SET consumed_at=now() WHERE token_hash=$1',[digest(refresh)]);
      await tx.query('INSERT INTO refresh_tokens(token_hash,session_id) VALUES($1,$2)',[digest(pair.refreshToken),s.id]);
      await tx.query('UPDATE user_sessions SET access_hash=$1,access_expires_at=$2 WHERE id=$3',[digest(pair.accessToken),pair.accessTokenExpiresAt,s.id]);
      return pair;
    });
  }
  async logout(scope:Scope,all=false){
    await transaction(this.pool,async tx=>{
      await tx.query(`UPDATE user_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1 ${all?'':'AND id=$2'}`,all?[scope.userId]:[scope.userId,scope.sessionId]);
      await audit(tx,scope,all?'auth.logout_all':'auth.logout',scope.sessionId);
    });return {revoked:true,scope:all?'all':'current'};
  }
}
export function validateTimeZone(zone:string) {
  if(zone!=='UTC'&&!/^[A-Za-z][A-Za-z0-9_+-]*\/[A-Za-z0-9_+/-]+$/.test(zone))throw new DomainError(400,'TIME_ZONE_INVALID');
  try { new Intl.DateTimeFormat('en',{timeZone:zone}); } catch { throw new DomainError(400,'TIME_ZONE_INVALID'); }
  return zone;
}
function makePair(rotated=false):TokenPair { return {tokenType:'Bearer',accessToken:token('app_'),refreshToken:token('refresh_'),accessTokenExpiresAt:new Date(Date.now()+900000).toISOString(),expiresIn:900,rotated}; }
export async function ensureDefault(tx:pg.PoolClient,userId:string) {
  const existing=await tx.query<{id:string}>('SELECT id FROM workspaces WHERE user_id=$1 AND is_default',[userId]);
  if(existing.rows[0])return existing.rows[0].id;
  const id=randomUUID();
  await tx.query('INSERT INTO workspaces(id,user_id,display_name,is_default,is_initial,bootstrap_receipt_id) VALUES($1,$2,$3,true,true,$4)',[id,userId,'个人工作区',randomUUID()]);
  return id;
}
export async function status(tx:pg.PoolClient,scope:Scope) {
  const user=await tx.query<{id:string;display_name:string;phone_masked:string;time_zone:string}>('SELECT id,display_name,phone_masked,time_zone FROM app_users WHERE id=$1',[scope.userId]);
  const w=await tx.query<{id:string;updated_at:Date}>('SELECT id,updated_at FROM workspaces WHERE user_id=$1 AND is_default',[scope.userId]);
  const p=await tx.query<{id:string;name:string}>('SELECT p.id,p.name FROM workspace_profiles p JOIN workspaces w ON w.id=p.workspace_id WHERE w.user_id=$1 AND w.is_default',[scope.userId]);
  if(!user.rows[0]||!w.rows[0])throw new DomainError(409,'WORKSPACE_NOT_READY');
  return {user:{userId:scope.userId,displayName:user.rows[0].display_name,phoneMasked:user.rows[0].phone_masked},
    workspace:{status:'ready',workspaceId:w.rows[0].id,defaultContentLineId:p.rows[0]?.id??null,lastSyncedAt:w.rows[0].updated_at.toISOString()},
    defaultContentLine:p.rows[0]?{contentLineId:p.rows[0].id,name:p.rows[0].name,isPlaceholder:false}:null,
    onboardingRequired:true,basicPositioningCompleted:false,positioningStatus:'not_started',runningTaskCount:0,timeZone:user.rows[0].time_zone};
}
