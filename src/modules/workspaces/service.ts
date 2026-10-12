import type pg from 'pg';
import { attachResource } from '../storage/references.js';
import { randomUUID } from 'node:crypto';
import { transaction, assertScope, audit, idempotent, DomainError, type Scope } from '../identity/store.js';
import { status, validateTimeZone } from '../identity/service.js';
export interface WorkspaceRow { id:string;user_id:string;display_name:string;state:string;is_default:boolean;revision:number;bootstrap_receipt_id:string; }
interface ProfileRow { id:string;name:string;industry:string;account_goal:string;target_audience:string|null;common_expressions:string[];version:number; }
export interface PositioningInput { name:string;industry:string;accountGoal:string;targetAudience?:string;commonExpressions:string[]; }
export interface DraftInput { mode:''|'business'|'no_business';stepIndex:number;answers:Record<string,string|string[]>;deferred:boolean;expectedVersion:number; }
export const workspaceEtag=(row:WorkspaceRow)=>`"workspace-${row.id}-${row.revision}"`;
export const workspaceDto=(row:WorkspaceRow)=>({workspaceId:row.id,displayName:row.display_name,state:row.state,isDefault:row.is_default,etag:workspaceEtag(row)});
function profileDto(p:ProfileRow,isDefault:boolean){return {creativePositioningId:p.id,contentLineId:p.id,name:p.name,industry:p.industry,accountGoal:p.account_goal,targetAudience:p.target_audience,commonExpressions:p.common_expressions,status:'active',version:p.version,isDefault,isPlaceholder:false};}
async function workspace(tx:pg.PoolClient,scope:Scope,id:string) {
 const r=await tx.query<WorkspaceRow>('SELECT * FROM workspaces WHERE id=$1 AND user_id=$2',[id,scope.userId]);
 if(!r.rows[0])throw new DomainError(404,'WORKSPACE_NOT_FOUND');return r.rows[0];
}
export class WorkspaceService {
 constructor(private pool:pg.Pool,private secret:string){}
 private read<T>(scope:Scope,fn:(tx:pg.PoolClient)=>Promise<T>){return transaction(this.pool,async tx=>{await assertScope(tx,scope);return fn(tx);});}
 private write<T>(scope:Scope,operation:string,key:string,input:unknown,fn:(tx:pg.PoolClient)=>Promise<T>){
  return transaction(this.pool,async tx=>{
   await assertScope(tx,scope);
   // Serializes default switches and profile updates for this personal account.
   await tx.query('SELECT id FROM app_users WHERE id=$1 FOR UPDATE',[scope.userId]);
   return idempotent(tx,this.secret,scope.userId,operation,key,input,async()=>{const out=await fn(tx);await audit(tx,scope,operation);return out;});
  });
 }
 getStatus(scope:Scope){return this.read(scope,tx=>status(tx,scope));}
 getProfile(scope:Scope){return this.read(scope,async tx=>{
  const r=await tx.query<{displayName:string;updatedAt:Date;avatarResourceId:string|null}>('SELECT display_name AS "displayName",updated_at AS "updatedAt",avatar_resource_id AS "avatarResourceId" FROM app_users WHERE id=$1',[scope.userId]);
  return {profile:{...r.rows[0]!,updatedAt:r.rows[0]!.updatedAt.toISOString()}};
 });}
 updateProfile(scope:Scope,input:{displayName:string;avatarResourceId?:string|null},key:string){

  return this.write(scope,'profile.update',key,input,async tx=>{
   if(input.avatarResourceId!==undefined){
    if(input.avatarResourceId){try{await attachResource(tx,scope.userId,input.avatarResourceId,'avatar',scope.userId);}catch(e){if(e instanceof DomainError&&e.statusCode===404)throw new DomainError(409,'AVATAR_RESOURCE_NOT_VERIFIED');throw e;}}
    await tx.query("DELETE FROM resource_refs WHERE user_id=$1 AND ref_kind='avatar' AND ref_id_external=$1 AND resource_id IS DISTINCT FROM $2::uuid",[scope.userId,input.avatarResourceId]);
    await tx.query('UPDATE app_users SET avatar_resource_id=$2 WHERE id=$1',[scope.userId,input.avatarResourceId]);
   }
   const r=await tx.query<{displayName:string;updatedAt:Date;avatarResourceId:string|null}>('UPDATE app_users SET display_name=$1,updated_at=now() WHERE id=$2 RETURNING display_name AS "displayName",updated_at AS "updatedAt",avatar_resource_id AS "avatarResourceId"',[input.displayName.trim(),scope.userId]);
   return {profile:{...r.rows[0]!,updatedAt:r.rows[0]!.updatedAt.toISOString()}};
  });
 }
 timezone(scope:Scope,zone:string,key:string){validateTimeZone(zone);return this.write(scope,'profile.timezone',key,{zone},async tx=>{
  await tx.query('UPDATE app_users SET time_zone=$1,updated_at=now() WHERE id=$2',[zone,scope.userId]);return {timeZone:zone};
 });}
 list(scope:Scope){return this.read(scope,async tx=>({items:(await tx.query<WorkspaceRow>('SELECT * FROM workspaces WHERE user_id=$1 ORDER BY created_at,id',[scope.userId])).rows.map(workspaceDto)}));}
 detail(scope:Scope,id:string){return this.read(scope,async tx=>{
  const w=await workspace(tx,scope,id);return {...workspaceDto(w),bootstrapReceiptId:w.bootstrap_receipt_id,bootstrapContentCursor:'0',contentCursor:'0'};
 });}
 create(scope:Scope,input:{displayName:string;setAsDefault:boolean},key:string){return this.write(scope,'workspace.create',key,input,async tx=>{
  if(input.setAsDefault)await tx.query('UPDATE workspaces SET is_default=false,revision=revision+1,updated_at=now() WHERE user_id=$1 AND is_default',[scope.userId]);
  const r=await tx.query<WorkspaceRow>('INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),scope.userId,input.displayName.trim(),input.setAsDefault,randomUUID()]);
  const w=r.rows[0]!;return {...workspaceDto(w),bootstrapReceiptId:w.bootstrap_receipt_id,bootstrapContentCursor:'0',contentCursor:'0'};
 });}
 update(scope:Scope,id:string,action:'rename'|'set-default'|'disable'|'restore',name:string|undefined,etag:string,key:string){
  return this.write(scope,'workspace.'+action,key,{id,name:name??null,etag},async tx=>{
   const w=await workspace(tx,scope,id);
   if(workspaceEtag(w)!==etag)throw new DomainError(412,'WORKSPACE_REVISION_MISMATCH');
   if(action==='disable'&&w.is_default)throw new DomainError(409,'DEFAULT_WORKSPACE_CANNOT_DISABLE');
   if(action==='set-default'&&w.state!=='ready')throw new DomainError(409,'WORKSPACE_DISABLED');
   if(action==='set-default')await tx.query('UPDATE workspaces SET is_default=false,revision=revision+1,updated_at=now() WHERE user_id=$1 AND is_default AND id<>$2',[scope.userId,id]);
   const r=await tx.query<WorkspaceRow>(`UPDATE workspaces SET display_name=$1,state=$2,is_default=$3,revision=revision+1,updated_at=now() WHERE id=$4 AND user_id=$5 RETURNING *`,[
    name?.trim()??w.display_name,action==='disable'?'disabled':action==='restore'?'ready':w.state,action==='set-default'?true:w.is_default,id,scope.userId]);
   return workspaceDto(r.rows[0]!);
  });
 }
 retry(scope:Scope,key:string){return this.write(scope,'workspace.retry',key,{},async tx=>{
  const r=await tx.query<WorkspaceRow>('SELECT * FROM workspaces WHERE user_id=$1 AND is_default',[scope.userId]);
  if(!r.rows[0])throw new DomainError(409,'WORKSPACE_NOT_READY');return {status:'ready',workspaceId:r.rows[0].id};
 });}
 currentProfile(scope:Scope){return this.read(scope,async tx=>{
  const r=await tx.query<{id:string}>('SELECT id FROM workspaces WHERE user_id=$1 AND is_default',[scope.userId]);
  if(!r.rows[0])throw new DomainError(409,'WORKSPACE_NOT_READY');
  const p=await tx.query<ProfileRow>('SELECT * FROM workspace_profiles WHERE workspace_id=$1',[r.rows[0].id]);
  return {workspaceId:r.rows[0].id,overview:'',selfDescription:'',positioning:'',conclusions:[],creativePositioning:p.rows[0]?profileDto(p.rows[0],true):null};
 });}
 positionings(scope:Scope){return this.read(scope,async tx=>{
  const r=await tx.query<ProfileRow & {is_default:boolean}>('SELECT p.*,w.is_default FROM workspace_profiles p JOIN workspaces w ON w.id=p.workspace_id WHERE w.user_id=$1 AND w.state=\'ready\' ORDER BY w.created_at',[scope.userId]);
  return {items:r.rows.map(p=>profileDto(p,p.is_default))};
 });}
 positioning(scope:Scope,input:PositioningInput,key:string){return this.write(scope,'positioning.save',key,input,async tx=>{
  const w=await tx.query<{id:string}>('SELECT id FROM workspaces WHERE user_id=$1 AND is_default',[scope.userId]);
  if(!w.rows[0])throw new DomainError(409,'WORKSPACE_NOT_READY');
  const r=await tx.query<ProfileRow>(`INSERT INTO workspace_profiles(id,workspace_id,name,industry,account_goal,target_audience,common_expressions) VALUES($1,$2,$3,$4,$5,$6,$7)
   ON CONFLICT(workspace_id) DO UPDATE SET name=excluded.name,industry=excluded.industry,account_goal=excluded.account_goal,target_audience=excluded.target_audience,common_expressions=excluded.common_expressions,version=workspace_profiles.version+1,updated_at=now() RETURNING *`,
   [randomUUID(),w.rows[0].id,input.name,input.industry,input.accountGoal,input.targetAudience??null,JSON.stringify(input.commonExpressions)]);
  return {creativePositioning:profileDto(r.rows[0]!,true),onboardingCompleted:false};
 });}
 draft(scope:Scope,id:string){return this.read(scope,async tx=>{await workspace(tx,scope,id);return readDraft(tx,id);});}
 saveDraft(scope:Scope,id:string,input:DraftInput,key:string){return this.write(scope,'onboarding.draft',key,{id,...input},async tx=>{
  const w=await workspace(tx,scope,id);if(w.state!=='ready')throw new DomainError(409,'WORKSPACE_DISABLED');
  const prior=await readDraft(tx,id);if(prior.version!==input.expectedVersion)throw new DomainError(409,'DRAFT_VERSION_CONFLICT');
  await tx.query(`INSERT INTO onboarding_drafts(workspace_id,mode,step_index,answers,deferred_at,version) VALUES($1,$2,$3,$4,CASE WHEN $5 THEN now() ELSE NULL END,1)
   ON CONFLICT(workspace_id) DO UPDATE SET mode=excluded.mode,step_index=excluded.step_index,answers=excluded.answers,deferred_at=excluded.deferred_at,version=onboarding_drafts.version+1,updated_at=now()`,[id,input.mode,input.stepIndex,JSON.stringify(input.answers),input.deferred]);
  return readDraft(tx,id);
 });}
}
async function readDraft(tx:pg.PoolClient,id:string){
 const r=await tx.query<{mode:string;stepIndex:number;answers:Record<string,string|string[]>;deferredAt:Date|null;version:number;updatedAt:Date}>('SELECT mode,step_index AS "stepIndex",answers,deferred_at AS "deferredAt",version,updated_at AS "updatedAt" FROM onboarding_drafts WHERE workspace_id=$1',[id]);
 const v=r.rows[0];return v?{...v,deferredAt:v.deferredAt?.toISOString()??null,updatedAt:v.updatedAt.toISOString()}:{mode:'',stepIndex:0,answers:{},deferredAt:null,version:0,updatedAt:null};
}
