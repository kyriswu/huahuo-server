import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { constantEqual, hashPassword, mac, token, verifyPassword } from '../identity/crypto.js';
import { DomainError, lock, rateLimit, transaction } from '../identity/store.js';
export interface AdminScope { readonly adminId:string;readonly sessionId:string;readonly role:'operator'|'superadmin';readonly username:string; }
export class AdminService {
 private dummy:Promise<string>;
 constructor(private pool:pg.Pool,private secret:string){this.dummy=hashPassword(token('dummy_'));}
 csrf(cookie:string){return mac(this.secret,'csrf:'+cookie);}
 async login(username:string,password:string,ip:string,traceId:string){
  const normalized=username.trim().toLowerCase();
  // Separate transaction: bad passwords and unknown users consume the same budgets.
  await transaction(this.pool,async tx=>{await rateLimit(tx,'ip:'+mac(this.secret,ip),30,900,true);await rateLimit(tx,'user:'+mac(this.secret,normalized),5,900,true);});
  const found=await this.pool.query<{id:string;password_hash:string;disabled:boolean;role:'operator'|'superadmin';username:string}>('SELECT * FROM admin_users WHERE username=$1',[normalized]);
  const user=found.rows[0];const valid=await verifyPassword(password,user?.password_hash??await this.dummy);
  if(!user||!valid||user.disabled){await this.audit(null,'admin.login_failed',null,null,traceId);throw new DomainError(401,'ADMIN_UNAUTHORIZED');}
  const raw=token('admin_'),csrfToken=this.csrf(raw),id=randomUUID();
  await transaction(this.pool,async tx=>{
   const active=await tx.query('SELECT id FROM admin_users WHERE id=$1 AND NOT disabled FOR SHARE',[user.id]);if(!active.rowCount)throw new DomainError(401,'ADMIN_UNAUTHORIZED');
   await tx.query(`INSERT INTO admin_sessions(id,admin_id,session_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '8 hours')`,[id,user.id,mac(this.secret,raw),mac(this.secret,csrfToken)]);
   await tx.query('INSERT INTO admin_audit_events(id,admin_id,action,target_id,trace_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),user.id,'admin.login',id,traceId]);
  });
  return {cookie:raw,csrfToken,admin:{adminId:user.id,username:user.username,role:user.role}};
 }
 async authenticate(raw:string|undefined):Promise<AdminScope>{
  if(!raw||!/^admin_[A-Za-z0-9_-]{43}$/.test(raw))throw new DomainError(401,'ADMIN_UNAUTHORIZED');
  const r=await this.pool.query<{id:string;admin_id:string;role:'operator'|'superadmin';username:string}>(`SELECT s.id,s.admin_id,a.role,a.username FROM admin_sessions s JOIN admin_users a ON a.id=s.admin_id
   WHERE s.session_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND NOT a.disabled`,[mac(this.secret,raw)]);
  const v=r.rows[0];if(!v)throw new DomainError(401,'ADMIN_UNAUTHORIZED');return Object.freeze({adminId:v.admin_id,sessionId:v.id,role:v.role,username:v.username});
 }
 checkCsrf(cookie:string,provided:unknown){if(typeof provided!=='string'||!constantEqual(this.csrf(cookie),provided))throw new DomainError(403,'CSRF_INVALID');}
 async logout(scope:AdminScope,traceId:string){await transaction(this.pool,async tx=>{await tx.query('UPDATE admin_sessions SET revoked_at=now() WHERE id=$1 AND admin_id=$2',[scope.sessionId,scope.adminId]);await this.audit(scope.adminId,'admin.logout',scope.sessionId,null,traceId,tx);});return {revoked:true};}
 async revoke(scope:AdminScope,adminId:string,reason:string,traceId:string){
  if(scope.role!=='superadmin')throw new DomainError(403,'ADMIN_FORBIDDEN');
  return transaction(this.pool,async tx=>{
   const active=await tx.query(`SELECT s.id FROM admin_sessions s JOIN admin_users a ON a.id=s.admin_id WHERE s.id=$1 AND s.admin_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND NOT a.disabled AND a.role='superadmin' FOR SHARE OF s,a`,[scope.sessionId,scope.adminId]);
   if(!active.rowCount)throw new DomainError(401,'ADMIN_UNAUTHORIZED');
   const target=await tx.query('SELECT id FROM admin_users WHERE id=$1',[adminId]);if(!target.rowCount)throw new DomainError(404,'ADMIN_NOT_FOUND');
   const r=await tx.query('UPDATE admin_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE admin_id=$1 AND revoked_at IS NULL',[adminId]);
   await this.audit(scope.adminId,'admin.revoke_sessions',adminId,reason,traceId,tx);return {revokedCount:r.rowCount??0};
  });
 }
 async resource(scope:AdminScope,id:string,trace:string){
  const r=await this.pool.query('SELECT resource_id,user_id,workspace_id,file_name,mime_type,size_bytes,status,processing_status,created_at FROM resources WHERE resource_id=$1',[id]);
  if(!r.rows[0])throw new DomainError(404,'RESOURCE_NOT_FOUND');await this.audit(scope.adminId,'resource.inspect',id,null,trace);
  const x=r.rows[0];return {resourceId:x.resource_id,userId:x.user_id,workspaceId:x.workspace_id,fileName:x.file_name,mimeType:x.mime_type,sizeBytes:Number(x.size_bytes),status:x.status,processingStatus:x.processing_status,createdAt:x.created_at.toISOString()};
 }
 async bootstrap(username:string,password:string){
  if(!/^[a-z][a-z0-9._-]{2,63}$/.test(username)||password.length<16||password.length>128)throw new DomainError(400,'ADMIN_CREDENTIALS_INVALID');
  const hash=await hashPassword(password);
  return transaction(this.pool,async tx=>{
   await lock(tx,'admin-bootstrap');if((await tx.query('SELECT id FROM admin_users LIMIT 1')).rowCount)throw new DomainError(409,'ADMIN_ALREADY_BOOTSTRAPPED');
   const id=randomUUID();await tx.query("INSERT INTO admin_users(id,username,password_hash,role) VALUES($1,$2,$3,'superadmin')",[id,username,hash]);
   await this.audit(id,'admin.bootstrap',id,'CLI bootstrap','cli-bootstrap',tx);return {adminId:id,username,role:'superadmin'};
  });
 }
 async revokeCli(username:string,reason:string){return transaction(this.pool,async tx=>{
  const r=await tx.query<{id:string}>('SELECT id FROM admin_users WHERE username=$1',[username]);if(!r.rows[0])throw new DomainError(404,'ADMIN_NOT_FOUND');
  const u=await tx.query('UPDATE admin_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE admin_id=$1 AND revoked_at IS NULL',[r.rows[0].id]);
  await this.audit(null,'admin.cli_revoke_sessions',r.rows[0].id,reason,'cli-revoke',tx);return {revokedCount:u.rowCount??0};
 });}
 private async audit(adminId:string|null,action:string,target:string|null,reason:string|null,trace:string,tx:pg.PoolClient|pg.Pool=this.pool){await tx.query('INSERT INTO admin_audit_events(id,admin_id,action,target_id,reason,trace_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),adminId,action,target,reason,trace]);}
}
