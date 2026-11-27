import { assertRecordingKey } from '../recorder-sync/source.js';
import { requireActiveRecorderBinding } from '../recorder-bindings/service.js';
import { idempotent } from '../../lib/idempotency.js';
import type pg from 'pg';
import { storageJob } from './jobs.js';
import { transaction, assertScope, DomainError, type Scope } from '../identity/store.js';
import type { AppConfig } from '../../config/config.js';
import { storageFor, type ObjectMetadata, type StoragePort } from './port.js';
import { RedisTemporaryUploads, type TemporaryUpload, type TemporaryUploadStore } from './temporary-uploads.js';
import { findUploadedObject, validateUploadedObject, withUploadLock } from './upload-session.js';

const uuid=(value:string)=>/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(value);
const dto=(r:Record<string,unknown>)=>({resourceId:String(r.resource_id),fileName:String(r.file_name),mimeType:String(r.mime_type),sizeBytes:Number(r.size_bytes),sha256:typeof r.sha256==='string'?r.sha256:null});
const temporaryDto=(r:TemporaryUpload)=>({resourceId:r.id,fileName:r.fileName,mimeType:r.mimeType,sizeBytes:r.sizeBytes,sha256:null});
export interface UploadInput {fileName:string;mimeType:string;sizeBytes:bigint;workspaceId?:string;bindingId?:string;recordingKey?:string;}

/** Uploads are temporary Redis receipts. Only a later business transaction claims a resource. */
export class StorageService {
 readonly storage:StoragePort;
 readonly uploads:TemporaryUploadStore;
 private readonly ownsUploads:boolean;
 constructor(readonly pool:pg.Pool,readonly config:AppConfig,storage?:StoragePort,uploads?:TemporaryUploadStore){
  this.storage=storage??storageFor(config);
  this.uploads=uploads??new RedisTemporaryUploads(config);
  this.ownsUploads=!uploads;
 }
 async close(){if(this.ownsUploads)await this.uploads.close();}
 private validate(input:UploadInput){
  if(!input.fileName||input.fileName.length>120||/[\\/\0]/.test(input.fileName)||
   !/^[-\w!#$&^.+]+\/[-\w!#$&^.+]+$/u.test(input.mimeType)||input.mimeType.length>128||
   input.sizeBytes<=0n||input.sizeBytes>BigInt(Math.min(this.config.maxUploadBytes,this.config.uploadHardMaxBytes)))
   throw new DomainError(400,'UPLOAD_METADATA_INVALID');
 }
 private direct(){
  const storage=this.storage;
  if(this.config.storageDriver!=='aliyun-oss'||!this.config.storageAliyunOss||!storage.beginUpload||!storage.signUploadPart||
   !storage.inspectUploadPart||!storage.completeUpload||!storage.abortUpload||!storage.head)
   throw new DomainError(503,'DIRECT_UPLOAD_NOT_CONFIGURED');
  return {
   begin:storage.beginUpload.bind(storage),sign:storage.signUploadPart.bind(storage),
   inspect:storage.inspectUploadPart.bind(storage),complete:storage.completeUpload.bind(storage),
  };
 }
 private async authorize(client:pg.PoolClient,scope:Scope,workspaceId?:string){
  await assertScope(client,scope);
  if(workspaceId&&!(await client.query("SELECT 1 FROM workspaces WHERE id=$1 AND user_id=$2 AND state='ready'",[workspaceId,scope.userId])).rowCount)
   throw new DomainError(404,'WORKSPACE_NOT_FOUND');
 }
 private async owned(client:pg.PoolClient,scope:Scope,id:string,workspaceId?:string,requireBinding=true){
  if(!uuid(id))throw new DomainError(400,'UPLOAD_ID_INVALID');
  await this.authorize(client,scope,workspaceId);
  const upload=await this.uploads.get(id);
  if(!upload||upload.userId!==scope.userId)throw new DomainError(404,'UPLOAD_NOT_FOUND');

  if(requireBinding && upload.bindingId)await requireActiveRecorderBinding(client,scope.userId,upload.bindingId);
  if(upload.storageDriver!==this.config.storageDriver||upload.storageBucket!==this.config.storageAliyunOss?.bucket)
   throw new DomainError(503,'DIRECT_UPLOAD_NOT_CONFIGURED');
  return upload;
 }
 private active(upload:TemporaryUpload){
  if(upload.expiresAt<=Date.now())throw new DomainError(410,'UPLOAD_TOKEN_EXPIRED');
  if(upload.status==='cancelled')throw new DomainError(409,'UPLOAD_CANCELLED');
 }
 private reusedResource(resource:Record<string,unknown>){
  if(resource.storage_driver!==this.config.storageDriver||resource.storage_bucket!==this.config.storageAliyunOss?.bucket)
   throw new DomainError(409,'RESOURCE_STORAGE_MISMATCH');
  if(resource.status!=='ready')throw new DomainError(409,'RESOURCE_NOT_READY');
  return {uploadId:String(resource.resource_id),resourceId:String(resource.resource_id),uploadRequired:false,uploadUrl:null,method:null,headers:{},expiresAt:null,retentionExpiresAt:null,resource:dto(resource)};
 }
 async createUpload(scope:Scope,input:UploadInput,key:string){
  if(!key)throw new DomainError(400,'IDEMPOTENCY_KEY_REQUIRED');
  this.validate(input);
  let recording: { bindingId: string; recordingKey: string } | undefined;
  if (input.bindingId !== undefined || input.recordingKey !== undefined) {
   if (!input.fileName.trim() || !input.bindingId || !uuid(input.bindingId) || !input.recordingKey || !input.mimeType.toLowerCase().startsWith('audio/')) {
    throw new DomainError(400,'RECORDING_UPLOAD_INVALID');
   }
   assertRecordingKey(input.recordingKey);
   recording = { bindingId: input.bindingId.toLowerCase(), recordingKey: input.recordingKey };
  }
  const direct=this.direct();
  // Temporary files have no account-space charge or reservation. A later
  // business claim checks permanent capacity and records usage in its transaction.
  const admitted=await transaction(this.pool,async tx=>{
   await assertScope(tx,scope);
   if (recording) await requireActiveRecorderBinding(tx,scope.userId,recording.bindingId,true);
   if(!(await tx.query("SELECT id FROM users WHERE id=$1 AND status='active' AND deleted_at IS NULL FOR SHARE",[scope.userId])).rowCount)
    throw new DomainError(401,'UNAUTHORIZED');
   await this.authorize(tx,scope,input.workspaceId);
   return this.uploads.admit({...recording,userId:scope.userId,fileName:input.fileName,mimeType:input.mimeType.toLowerCase(),sizeBytes:Number(input.sizeBytes),storageDriver:'aliyun-oss',storageBucket:this.config.storageAliyunOss!.bucket},key);
  });
  return withUploadLock(this.pool,admitted.id,async client=>{
   // A business claim may have committed and removed the receipt after admission.
   const registered=(await client.query('SELECT * FROM resources WHERE resource_id=$1 AND user_id=$2',[admitted.id,scope.userId])).rows[0];
   if(registered)return this.reusedResource(registered);
   const upload=await this.owned(client,scope,admitted.id);
   this.active(upload);
   if(upload.status==='completed')return {uploadId:upload.id,resourceId:upload.id,uploadRequired:false,uploadUrl:null,method:null,headers:{},expiresAt:null,retentionExpiresAt:new Date(upload.expiresAt).toISOString(),resource:temporaryDto(upload)};
   if(!upload.remoteUploadId){
    try{
     upload.remoteUploadId=await direct.begin(upload.id,upload.mimeType,upload.id);
     await this.uploads.save(upload);
    }catch(error){throw new DomainError(503,'UPLOAD_INITIALIZATION_UNAVAILABLE',false,{cause:error});}
   }
   await this.authorize(client,scope,input.workspaceId);
   if(upload.bindingId)await requireActiveRecorderBinding(client,scope.userId,upload.bindingId);
   const seconds=Math.max(1,Math.min(3600,Math.floor((upload.expiresAt-Date.now())/1000)));
   const signed=await direct.sign(upload.id,upload.remoteUploadId,upload.mimeType,upload.sizeBytes,seconds);
   return {uploadId:upload.id,resourceId:upload.id,uploadRequired:true,uploadUrl:signed.url,method:'PUT' as const,headers:signed.headers,
    expiresAt:new Date(Date.now()+seconds*1000).toISOString(),retentionExpiresAt:new Date(upload.expiresAt).toISOString()};
  });
 }
 async recover(scope:Scope,id:string){return transaction(this.pool,async tx=>{
  if(!uuid(id))throw new DomainError(400,'UPLOAD_ID_INVALID');
  await this.authorize(tx,scope);
  const resource=(await tx.query("SELECT r.* FROM resources r WHERE r.resource_id=$1 AND r.user_id=$2",[id,scope.userId])).rows[0];
  if(resource)return {uploadId:id,resourceId:resource.resource_id,status:'claimed',expiresAt:null,receivedBytes:Number(resource.size_bytes),errorCode:null};
  const upload=await this.owned(tx,scope,id);
  return {uploadId:id,resourceId:id,status:upload.expiresAt<=Date.now()?'expired':upload.status,expiresAt:new Date(upload.expiresAt).toISOString(),receivedBytes:upload.object?.bytes??0,errorCode:null};
 });}
 async complete(scope:Scope,id:string,key:string,workspaceId?:string){
  if(!key)throw new DomainError(400,'IDEMPOTENCY_KEY_REQUIRED');
  const direct=this.direct();
  if(!uuid(id))throw new DomainError(400,'UPLOAD_ID_INVALID');
  return withUploadLock(this.pool,id,async client=>{
   await this.authorize(client,scope,workspaceId);
   const resource=(await client.query("SELECT r.* FROM resources r WHERE r.resource_id=$1 AND r.user_id=$2",[id,scope.userId])).rows[0];
   if(resource){
    if(resource.status!=='ready')throw new DomainError(409,'RESOURCE_NOT_READY');
    return {uploadId:id,status:'completed' as const,resource:dto(resource)};
   }
   const upload=await this.owned(client,scope,id,workspaceId);this.active(upload);
   if(upload.status==='completed')return {uploadId:id,status:'completed' as const,resource:temporaryDto(upload)};
   if(!upload.remoteUploadId)throw new DomainError(409,'UPLOAD_NOT_READY');
   let object:ObjectMetadata|undefined;
   try{
    // A previous Complete may have succeeded while its response was lost.
    if(upload.completionStartedAt)object=await findUploadedObject(this.storage,id);
    if(!object){
     const part=await direct.inspect(id,upload.remoteUploadId);
     if(part.bytes!==upload.sizeBytes)throw new DomainError(400,'UPLOAD_SIZE_MISMATCH');
     upload.completionStartedAt=Date.now();await this.uploads.save(upload);
     try{await direct.complete(id,upload.remoteUploadId,part.etag);}
     catch(error){
      object=await findUploadedObject(this.storage,id);
      if(!object)throw error;
     }
     object??=await findUploadedObject(this.storage,id);
    }
    if(!object)throw new DomainError(409,'UPLOAD_NOT_READY');
    validateUploadedObject(upload,object);
    await this.authorize(client,scope,workspaceId);
    if(upload.bindingId)await requireActiveRecorderBinding(client,scope.userId,upload.bindingId);
    this.active(upload);
    upload.object=object;upload.status='completed';await this.uploads.save(upload);
   }catch(error){
    if(error instanceof DomainError)throw error;
    if((error as {code?:string})?.code==='UPLOAD_PARTS_INVALID')throw new DomainError(409,'UPLOAD_PARTS_INVALID',false,{cause:error});
    throw new DomainError(409,'UPLOAD_NOT_READY',false,{cause:error});
   }
   return {uploadId:id,status:'completed' as const,resource:temporaryDto(upload)};
  });
 }
 async cancel(scope:Scope,id:string,key:string){
  if(!key)throw new DomainError(400,'IDEMPOTENCY_KEY_REQUIRED');
  if(!uuid(id))throw new DomainError(400,'UPLOAD_ID_INVALID');
  return withUploadLock(this.pool,id,async client=>{
   await this.authorize(client,scope);
   if((await client.query('SELECT 1 FROM resources WHERE resource_id=$1 AND user_id=$2',[id,scope.userId])).rowCount)throw new DomainError(409,'UPLOAD_ALREADY_CLAIMED');
   const upload=await this.owned(client,scope,id,undefined,false);
   upload.status='cancelled';await this.uploads.save(upload);
   return {uploadId:id,status:'cancel_pending' as const};
  });
 }
 async playbacks(scope:Scope,ids:string[],workspaceId?:string){
  const unique=[...new Set(ids)];
  if(unique.some(id=>!uuid(id))||unique.length>1000)throw new DomainError(400,'RESOURCE_IDS_INVALID');
  if(!unique.length)return [];
  if(this.config.storageDriver!=='aliyun-oss'||!this.config.storageAliyunOss||!this.storage.signUrl)throw new DomainError(503,'DIRECT_READ_NOT_CONFIGURED');
  const signUrl=this.storage.signUrl.bind(this.storage),bucket=this.config.storageAliyunOss.bucket;
  const {rows,permanent}=await transaction(this.pool,async tx=>{
   await this.authorize(tx,scope,workspaceId);
   const rows=(await tx.query<{resource_id:string;mime_type:string;file_name:string;size_bytes:string|number;object_key:string;object_version:string}>(`SELECT r.resource_id,r.mime_type,r.file_name,r.size_bytes,r.object_key,r.object_version FROM resources r
    WHERE r.resource_id=ANY($1::uuid[]) AND r.user_id=$2 AND r.status='ready' AND r.storage_driver='aliyun-oss' AND r.storage_bucket=$3`,[unique,scope.userId,bucket])).rows;
   // A deleting/deleted resource must never become readable through an old Redis receipt.
   const permanent=(await tx.query<{resource_id:string}>('SELECT resource_id FROM resources WHERE resource_id=ANY($1::uuid[])',[unique])).rows.map(row=>row.resource_id);
   return {rows,permanent};
  });
  const registered=new Set(permanent);
  const pending=(await Promise.all(unique.filter(id=>!registered.has(id)).map(id=>this.uploads.get(id))))
   .filter((upload):upload is TemporaryUpload=>Boolean(upload&&upload.userId===scope.userId&&upload.status==='completed'&&upload.object&&upload.expiresAt>Date.now()
    &&upload.storageDriver==='aliyun-oss'&&upload.storageBucket===bucket));
  // A scoped receipt can preview its temporary object only during the issuing binding.
  // Permanent account-owned resources remain playable after the card is unbound.
  const bindingIds=[...new Set(pending.flatMap(upload=>upload.bindingId?[upload.bindingId]:[]))];
  const activeBindings=new Set<string>();
  if(bindingIds.length){
   const bindings=await transaction(this.pool,async tx=>{
    await this.authorize(tx,scope,workspaceId);
    return tx.query<{binding_id:string}>(`SELECT binding_id FROM recorder_bindings
     WHERE user_id=$1 AND binding_id=ANY($2::uuid[]) AND unbound_at IS NULL`,[scope.userId,bindingIds]);
   });
   for(const row of bindings.rows)activeBindings.add(row.binding_id);
  }
  for(const upload of pending.filter(item=>!item.bindingId || activeBindings.has(item.bindingId)))rows.push({resource_id:upload.id,mime_type:upload.mimeType,file_name:upload.fileName,size_bytes:upload.object!.bytes,object_key:upload.id,object_version:upload.object!.version});
  const exp=Date.now()+15*60_000;
  return Promise.all(rows.map(async row=>({resourceId:row.resource_id,url:await signUrl(row.object_key,900,{contentDisposition:`inline; filename="${row.file_name.replace(/[^A-Za-z0-9._-]/gu,'_')}"`,contentEncoding:'identity',version:row.object_version}),mimeType:row.mime_type,fileName:row.file_name,sizeBytes:Number(row.size_bytes),expiresAt:new Date(exp).toISOString()})));
 }
 async playback(scope:Scope,id:string){
  if(!uuid(id))throw new DomainError(404,'RESOURCE_NOT_FOUND');
  const result=(await this.playbacks(scope,[id]))[0];
  if(!result)throw new DomainError(404,'RESOURCE_NOT_FOUND');
  return result;
 }
 async remove(scope:Scope,workspaceId:string,id:string,key:string){return transaction(this.pool,async tx=>{await this.authorize(tx,scope,workspaceId);return idempotent(tx,this.config.appTokenSecret!,scope.userId,'media.delete',key,{workspaceId,id},async()=>{const r=await tx.query("SELECT * FROM resources WHERE resource_id=$1 AND user_id=$2 FOR UPDATE",[id,scope.userId]);if(!r.rows[0])throw new DomainError(404,'RESOURCE_NOT_FOUND');if(r.rows[0].status==='deleting')return {resourceId:id,workspaceId,status:'delete_pending'};if(BigInt(r.rows[0].reference_count)>0n||(await tx.query('SELECT 1 FROM resource_refs WHERE resource_id=$1 LIMIT 1',[id])).rowCount)throw new DomainError(409,'RESOURCE_REFERENCED');await tx.query("UPDATE resources SET status='deleting' WHERE resource_id=$1",[id]);await storageJob(tx,scope.userId,workspaceId,'delete',id);return {resourceId:id,workspaceId,status:'delete_pending'};});});}
}
