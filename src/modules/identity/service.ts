import { digest, seal, unseal, canonical } from '../../lib/crypto.js';
import { idempotent } from '../../lib/idempotency.js';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/config.js';
import { createSmsProvider, type SmsProvider } from '../../integrations/sms.js';
import { SmsProviderError } from '../../integrations/aliyun-sms.js';
import { constantEqual, mac, maskedPhone, normalizePhone, otpCode, token } from './crypto.js';
import { loadEd25519Keys, publicJwks, signAccessToken, verifyAccessToken, type JwtSettings } from './jwt.js';
import { DomainError, transaction, lock, audit, assertScope, type Scope, rateLimit } from './store.js';
export type ClientType='app'|'web';
export interface LoginInput { phone:string; smsRequestId:string; smsCode:string; clientType:ClientType; clientId:string; agreementAccepted:boolean; agreementVersion:string; privacyVersion:string; clientVersion:string; timeZone?:string; }
export interface TokenPair { tokenType:'Bearer'; accessToken:string; refreshToken:string; accessTokenExpiresAt:string; expiresIn:number; rotated:boolean; }
export interface IdentityOptions { sms?: SmsProvider; }
export class IdentityService {
  private readonly secret: string;
  private readonly jwtSettings: JwtSettings;
  private readonly jwtKeys: ReturnType<typeof loadEd25519Keys>;
  readonly sms: SmsProvider;
  constructor(readonly pool: pg.Pool, readonly config: AppConfig, options: IdentityOptions = {}) {
    if (!config.appTokenSecret) throw new Error('APP_TOKEN_SECRET_REQUIRED');
    this.secret=config.appTokenSecret;
    this.jwtSettings={issuer:config.jwt.issuer,audience:config.jwt.audience,serverAudience:config.jwt.serverAudience,keyId:config.jwt.keyId,accessTtlSeconds:config.jwt.accessTtlSeconds,refreshTtlSeconds:config.jwt.refreshTtlSeconds,privateKeyPem:config.jwt.privateKeyPem,publicKeyPem:config.jwt.publicKeyPem,previousPublicKeyPem:config.jwt.previousPublicKeyPem,previousKeyId:config.jwt.previousKeyId};
    this.jwtKeys=loadEd25519Keys(this.jwtSettings);
    this.sms=options.sms ?? createSmsProvider(config);
  }
  async sendCode(input:{phone:string;purpose:'sign_in'}, ip:string, key?:string) {
    const phone=normalizePhone(input.phone), subjectHash=mac(this.secret,phone);
    if(input.purpose!=='sign_in')throw new DomainError(400,'SMS_PURPOSE_INVALID');
    const code=otpCode(), id=randomUUID(), hash=mac(this.secret,canonical({phone,purpose:input.purpose}));
    const data={smsRequestId:id,cooldownSeconds:60,providerMode:'live' as const};
    const existing=await transaction(this.pool,async tx=>{
      await lock(tx,'phone:'+subjectHash);
      if(key){
        const r=await tx.query<{request_hash:string;response_cipher:string;delivery_status:string;provider_mode:string;valid:boolean}>("SELECT request_hash,response_cipher,delivery_status,provider_mode,expires_at>now() valid FROM otp_requests WHERE provider='phone' AND subject_hash=$1 AND request_key=$2",[subjectHash,key]);
        if(r.rows[0]){
          if(r.rows[0].request_hash!==hash)throw new DomainError(409,'IDEMPOTENCY_CONFLICT');
          if(!r.rows[0].valid)throw new DomainError(409,'IDEMPOTENCY_KEY_EXPIRED');
          if(r.rows[0].delivery_status!=='sent'||r.rows[0].provider_mode!=='live')throw new DomainError(409,'SMS_DELIVERY_NOT_CONFIRMED');
          const receipt=unseal<typeof data>(r.rows[0].response_cipher,this.secret);
          return {smsRequestId:receipt.smsRequestId,cooldownSeconds:receipt.cooldownSeconds,providerMode:'live' as const};
        }
      }
      await rateLimit(tx,'sms-ip:'+mac(this.secret,ip),20,3600);
      await rateLimit(tx,'sms-day:'+subjectHash,10,86400);
      const recent=await tx.query("SELECT id FROM otp_requests WHERE provider='phone' AND subject_hash=$1 AND created_at>now()-interval '60 seconds' LIMIT 1",[subjectHash]);
      if(recent.rowCount)throw new DomainError(429,'SMS_RATE_LIMITED',true);
      await tx.query(`INSERT INTO otp_requests(id,provider,subject_hash,purpose,code_hash,delivery_status,provider_mode,request_key,request_hash,response_cipher,expires_at)
       VALUES($1,'phone',$2,'sign_in',$3,'pending',$4,$5,$6,$7,now()+interval '5 minutes')`,[id,subjectHash,mac(this.secret,`${id}:${code}`),'live',key??null,hash,seal(data,this.secret)]);
      return null;
    });
    if(existing)return existing;
    try { await this.sms.send({phone,code,purpose:'sign_in',requestId:id}); }
    catch (error) {
      // A timeout may follow gateway acceptance. Keep pending and forbid same-key resends.
      if (!(error instanceof SmsProviderError && error.outcome === 'unknown'))
        await this.pool.query("UPDATE otp_requests SET delivery_status='failed' WHERE id=$1",[id]);
      throw new DomainError(503,'SMS_PROVIDER_FAILED',false,{cause:error});
    }
    await this.pool.query("UPDATE otp_requests SET delivery_status='sent' WHERE id=$1",[id]);
    return data;
  }
  async login(input:LoginInput,ip:string,traceId:string,key?:string) {
    const phone=normalizePhone(input.phone), subjectHash=mac(this.secret,phone);
    if(!this.config.agreementVersion||!this.config.privacyVersion)throw new DomainError(503,'LEGAL_VERSIONS_NOT_CONFIGURED');
    if(!input.agreementAccepted || input.agreementVersion!==this.config.agreementVersion || input.privacyVersion!==this.config.privacyVersion)throw new DomainError(400,'AGREEMENT_REQUIRED');
    if(!['app','web'].includes(input.clientType)||!input.clientId?.trim()||input.clientId.length>128)throw new DomainError(400,'CLIENT_INVALID');
    const zone=validateTimeZone(input.timeZone??'UTC');
    await transaction(this.pool,async tx=>rateLimit(tx,'login:'+mac(this.secret,ip),60,600));
    return transaction(this.pool,async tx=>{
      await lock(tx,'phone:'+subjectHash);
      const result=await idempotent(tx,this.secret,'login:'+subjectHash,'auth.sign-in',key,mac(this.secret,canonical(input)),async()=>{
        const r=await tx.query<{code_hash:string;attempts:number;valid:boolean;consumed_at:Date|null;delivery_status:string;provider_mode:string}>("SELECT code_hash,attempts,expires_at>now() valid,consumed_at,delivery_status,provider_mode FROM otp_requests WHERE id=$1 AND provider='phone' AND subject_hash=$2 AND purpose='sign_in' FOR UPDATE",[input.smsRequestId,subjectHash]);
        const otp=r.rows[0];
        if(!otp||!otp.valid||otp.consumed_at||otp.delivery_status!=='sent'||otp.provider_mode!=='live')throw new DomainError(401,'SMS_CODE_EXPIRED');
        if(otp.attempts>=5)throw new DomainError(429,'SMS_CODE_ATTEMPTS_EXCEEDED');
        if(!constantEqual(otp.code_hash,mac(this.secret,`${input.smsRequestId}:${input.smsCode}`))){
          await tx.query('UPDATE otp_requests SET attempts=attempts+1 WHERE id=$1',[input.smsRequestId]);
          throw new DomainError(401,'SMS_CODE_INVALID',true);
        }
        await tx.query('UPDATE otp_requests SET consumed_at=now() WHERE id=$1',[input.smsRequestId]);
        const prior=await tx.query<{id:string;user_id:string}>("SELECT id,user_id FROM user_identities WHERE provider='phone' AND subject_hash=$1",[subjectHash]);
        const identity=prior.rows[0],firstLogin=!identity,userId=identity?.user_id??randomUUID();
        if(firstLogin){
          await tx.query('INSERT INTO users(id,time_zone) VALUES($1,$2)',[userId,zone]);
          await tx.query("INSERT INTO user_identities(id,user_id,provider,subject_hash,subject_masked,verified_at) VALUES($1,$2,'phone',$3,$4,now())",[randomUUID(),userId,subjectHash,maskedPhone(phone)]);
        }
        // An existing suspended/deleted identity is not a new account.
        const user=await tx.query("SELECT id FROM users WHERE id=$1 AND status='active' AND deleted_at IS NULL FOR UPDATE",[userId]);
        if(!user.rowCount)throw new DomainError(403,'AUTH_ACCOUNT_DISABLED');
        if(identity)await tx.query('UPDATE user_identities SET verified_at=coalesce(verified_at,now()),updated_at=now() WHERE id=$1',[identity.id]);
        await ensureDefault(tx,userId);
        const sessionId=randomUUID(),accessJti=randomUUID(),sessionExpiresAt=new Date(Date.now()+this.jwtSettings.refreshTtlSeconds*1000),pair=await this.makePair(userId,accessJti,false,sessionExpiresAt);
        await tx.query(`INSERT INTO user_sessions(id,user_id,client_id,client_type,access_jti,access_hash,access_expires_at,expires_at,last_seen_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())`,[sessionId,userId,input.clientId,input.clientType,accessJti,digest(pair.accessToken),pair.accessTokenExpiresAt,sessionExpiresAt]);
        await tx.query('INSERT INTO refresh_tokens(token_hash,session_id,expires_at,last_used_at) VALUES($1,$2,$3,now())',[digest(pair.refreshToken),sessionId,sessionExpiresAt]);
        await tx.query(`INSERT INTO user_agreement_acceptances(id,user_id,session_id,agreement_version,privacy_version,accepted_via) VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),userId,sessionId,input.agreementVersion,input.privacyVersion,input.clientType]);
        await audit(tx,{userId,sessionId,traceId},'auth.login',sessionId);
        const state=await status(tx,{userId,sessionId,traceId});
        return {...pair,...state,firstLogin};
      },300);
      // Never replay a cached login result after refresh/logout/revocation.
      const active=await tx.query("SELECT s.id FROM user_sessions s JOIN users u ON u.id=s.user_id AND u.status='active' AND u.deleted_at IS NULL WHERE s.access_hash=$1 AND s.revoked_at IS NULL AND s.access_expires_at>now() AND s.expires_at>now()",[digest(result.accessToken)]);
      if(!active.rowCount)throw new DomainError(409,'LOGIN_REPLAY_EXPIRED');
      return result;
    });
  }
  async authenticate(authorization: string | undefined, traceId:string):Promise<Scope> {
    const access=authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1];
    if(!access)throw new DomainError(401,'UNAUTHORIZED');
    let claims;
    try { claims=await verifyAccessToken(await this.jwtKeys,this.jwtSettings,access); }
    catch { throw new DomainError(401,'AUTH_TOKEN_INVALID'); }
    // Admission is always a fresh read. Activity is approximate metadata: update
    // at most once a minute, and never wait for a business transaction's row lock.
    // A data-modifying CTE runs even when its RETURNING rows are not consumed.
    const r=await this.pool.query<{id:string;user_id:string}>(`WITH admitted AS MATERIALIZED (
      SELECT s.id,s.user_id FROM user_sessions s JOIN users u ON u.id=s.user_id
      WHERE u.status='active' AND u.deleted_at IS NULL AND s.access_jti=$1 AND s.user_id=$2 AND s.access_hash=$3
        AND s.revoked_at IS NULL AND s.access_expires_at>statement_timestamp() AND s.expires_at>statement_timestamp()
    ), activity AS (
      UPDATE user_sessions s SET last_seen_at=statement_timestamp()
      WHERE s.last_seen_at<=statement_timestamp()-interval '60 seconds' AND s.id IN (
        SELECT candidate.id FROM user_sessions candidate JOIN admitted a ON a.id=candidate.id
        WHERE candidate.last_seen_at<=statement_timestamp()-interval '60 seconds'
        FOR NO KEY UPDATE OF candidate SKIP LOCKED
      )
      RETURNING s.id
    ) SELECT id,user_id FROM admitted`,[claims.jti,claims.sub,digest(access)]);
    if(!r.rows[0])throw new DomainError(401,'AUTH_SESSION_EXPIRED');
    return Object.freeze({userId:r.rows[0].user_id,sessionId:r.rows[0].id,traceId});
  }
  async jwks() { return publicJwks(await this.jwtKeys); }
  async refresh(refresh:string,traceId:string) {
    if(!/^refresh_[A-Za-z0-9_-]{43}$/.test(refresh))throw new DomainError(401,'AUTH_SESSION_EXPIRED');
    return transaction(this.pool,async tx=>{
      const found=await tx.query<{session_id:string;consumed_at:Date|null;valid:boolean}>('SELECT session_id,consumed_at,expires_at>now() valid FROM refresh_tokens WHERE token_hash=$1 FOR UPDATE',[digest(refresh)]);
      if(!found.rows[0] || !found.rows[0].valid)throw new DomainError(401,'AUTH_SESSION_EXPIRED');
      const r=await tx.query<{id:string;user_id:string;valid:boolean;revoked_at:Date|null;expires_at:Date}>("SELECT s.id,s.user_id,s.expires_at,s.expires_at>now() valid,s.revoked_at FROM user_sessions s JOIN users u ON u.id=s.user_id AND u.status='active' AND u.deleted_at IS NULL WHERE s.id=$1 FOR UPDATE OF s",[found.rows[0].session_id]);
      const s=r.rows[0];
      if(!s)throw new DomainError(401,'AUTH_SESSION_EXPIRED');
      if(found.rows[0].consumed_at){
        await tx.query('UPDATE user_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1',[s.id]);
        await audit(tx,{userId:s.user_id,sessionId:s.id,traceId},'auth.refresh_reuse',s.id);
        throw new DomainError(401,'AUTH_SESSION_EXPIRED',true);
      }
      if(s.revoked_at||!s.valid)throw new DomainError(401,'AUTH_SESSION_EXPIRED');
      const accessJti=randomUUID(), pair=await this.makePair(s.user_id,accessJti,true,s.expires_at);
      await tx.query('UPDATE refresh_tokens SET consumed_at=now(),last_used_at=now() WHERE token_hash=$1',[digest(refresh)]);
      await tx.query('INSERT INTO refresh_tokens(token_hash,session_id,expires_at,last_used_at) VALUES($1,$2,$3,now())',[digest(pair.refreshToken),s.id,s.expires_at]);
      await tx.query('UPDATE user_sessions SET access_jti=$1,access_hash=$2,access_expires_at=$3,last_seen_at=now() WHERE id=$4',[accessJti,digest(pair.accessToken),pair.accessTokenExpiresAt,s.id]);
      return pair;
    });
  }
  async logout(scope:Scope,all=false){
    await transaction(this.pool,async tx=>{
      // Serialize account-wide revocation before taking session share locks;
      // concurrent logout calls must not deadlock while upgrading those locks.
      await lock(tx,`auth.logout:${scope.userId}`);
      await assertScope(tx,scope);
      await tx.query(`UPDATE user_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1 ${all?'':'AND id=$2'}`,all?[scope.userId]:[scope.userId,scope.sessionId]);
      await audit(tx,scope,all?'auth.logout_all':'auth.logout',scope.sessionId);
    });return {revoked:true,scope:all?'all':'current'};
  }
  private async makePair(userId:string,accessJti:string,rotated:boolean,sessionExpiresAt:Date):Promise<TokenPair> {
    const keys=await this.jwtKeys;
    const expiresIn=Math.min(this.jwtSettings.accessTtlSeconds,Math.floor((sessionExpiresAt.getTime()-Date.now())/1000));
    if(expiresIn<1)throw new DomainError(401,'AUTH_SESSION_EXPIRED');
    const access=await signAccessToken(keys.privateKey,{...this.jwtSettings,accessTtlSeconds:expiresIn},userId,accessJti);
    if(new Date(access.expiresAt).getTime()>sessionExpiresAt.getTime())throw new DomainError(401,'AUTH_SESSION_EXPIRED');
    return {tokenType:'Bearer',accessToken:access.token,refreshToken:token('refresh_'),accessTokenExpiresAt:access.expiresAt,expiresIn,rotated};
  }
}
export function validateTimeZone(zone:string) {
  if(zone!=='UTC'&&!/^[A-Za-z][A-Za-z0-9_+-]*\/[A-Za-z0-9_+/-]+$/.test(zone))throw new DomainError(400,'TIME_ZONE_INVALID');
  try { new Intl.DateTimeFormat('en',{timeZone:zone}); } catch { throw new DomainError(400,'TIME_ZONE_INVALID'); }
  return zone;
}
export async function ensureDefault(tx:pg.PoolClient,userId:string) {
  const existing=await tx.query<{id:string}>('SELECT id FROM workspaces WHERE user_id=$1 AND is_default',[userId]);
  if(existing.rows[0])return existing.rows[0].id;
  const id=randomUUID();
  await tx.query('INSERT INTO workspaces(id,user_id,display_name,is_default,is_initial,bootstrap_receipt_id) VALUES($1,$2,$3,true,true,$4)',[id,userId,'个人工作区',randomUUID()]);
  return id;
}
export async function status(tx:pg.PoolClient,scope:Scope) {
  const user=await tx.query<{id:string;display_name:string;phoneMasked:string;time_zone:string}>(`SELECT u.id,u.display_name,u.time_zone,
   coalesce((SELECT i.subject_masked FROM user_identities i WHERE i.user_id=u.id AND i.provider='phone' AND i.verified_at IS NOT NULL ORDER BY i.created_at,i.id LIMIT 1),'') AS "phoneMasked"
   FROM users u WHERE u.id=$1 AND u.status='active' AND u.deleted_at IS NULL`,[scope.userId]);
  const w=await tx.query<{id:string;updated_at:Date}>('SELECT id,updated_at FROM workspaces WHERE user_id=$1 AND is_default',[scope.userId]);
  const p=await tx.query<{id:string;name:string}>('SELECT p.id,p.name FROM workspace_profiles p JOIN workspaces w ON w.id=p.workspace_id WHERE w.user_id=$1 AND w.is_default',[scope.userId]);
  if(!user.rows[0]||!w.rows[0])throw new DomainError(409,'WORKSPACE_NOT_READY');
  return {user:{userId:scope.userId,displayName:user.rows[0].display_name,phoneMasked:user.rows[0].phoneMasked},
    workspace:{status:'ready',workspaceId:w.rows[0].id,defaultContentLineId:p.rows[0]?.id??null,lastSyncedAt:w.rows[0].updated_at.toISOString()},
    defaultContentLine:p.rows[0]?{contentLineId:p.rows[0].id,name:p.rows[0].name,isPlaceholder:false}:null,
    onboardingRequired:true,basicPositioningCompleted:false,positioningStatus:'not_started',runningTaskCount:0,timeZone:user.rows[0].time_zone};
}
