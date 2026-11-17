import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import { afterCommit, DomainError, type Scope } from '../identity/store.js';
import type { TemporaryUploadStore } from './temporary-uploads.js';

/** First business use atomically creates user-owned files and permanent occupancy. */
export class ResourceClaims {
 constructor(private readonly config:AppConfig,private readonly uploads:TemporaryUploadStore){}
 async lockAccount(tx:pg.PoolClient,scope:Scope):Promise<void>{
  if(!(await tx.query("SELECT id FROM users WHERE id=$1 AND status='active' AND deleted_at IS NULL FOR UPDATE",[scope.userId])).rowCount)throw new DomainError(401,'UNAUTHORIZED');
 }
 async ensure(tx:pg.PoolClient,scope:Scope,workspaceId:string|undefined,resourceIds:readonly string[]):Promise<void>{
  const ids=[...new Set(resourceIds.map(id=>id.toLowerCase()))].sort();if(!ids.length)return;
  if(ids.length>1000||ids.some(id=>!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/u.test(id)))throw new DomainError(400,'RESOURCE_IDS_INVALID');
  await this.lockAccount(tx,scope);
  if(workspaceId&&!(await tx.query("SELECT id FROM workspaces WHERE id=$1 AND user_id=$2 AND state='ready' FOR SHARE",[workspaceId,scope.userId])).rowCount)throw new DomainError(404,'WORKSPACE_NOT_FOUND');
  await tx.query(`WITH ordered AS MATERIALIZED(SELECT id FROM unnest($1::uuid[])x(id) ORDER BY id)
   SELECT pg_advisory_xact_lock(hashtextextended('storage-upload:'||id::text,0)) FROM ordered`,[ids]);
  const existing=(await tx.query<{resource_id:string;user_id:string;status:string}>('SELECT resource_id,user_id,status FROM resources WHERE resource_id=ANY($1::uuid[]) ORDER BY resource_id FOR UPDATE',[ids])).rows;
  if(existing.some(row=>row.user_id!==scope.userId||row.status!=='ready'))throw new DomainError(404,'RESOURCE_NOT_FOUND');
  const found=new Set(existing.map(row=>row.resource_id)),missing=ids.filter(id=>!found.has(id));if(!missing.length)return;
  const receipts=await Promise.all(missing.map(id=>this.uploads.get(id)));
  for(const [index,receipt]of receipts.entries()){
   if(!receipt||receipt.id!==missing[index]||receipt.userId!==scope.userId||receipt.status!=='completed'||receipt.expiresAt<=Date.now()
    ||!receipt.object||receipt.object.uploadSessionId!==receipt.id||receipt.object.bytes!==receipt.sizeBytes||!receipt.object.version
    ||receipt.object.contentType.split(';',1)[0]!.trim().toLowerCase()!==receipt.mimeType.toLowerCase())throw new DomainError(404,'RESOURCE_NOT_FOUND');
   if(receipt.storageDriver!=='aliyun-oss'||this.config.storageDriver!=='aliyun-oss'||receipt.storageBucket!==this.config.storageAliyunOss?.bucket)throw new DomainError(409,'RESOURCE_STORAGE_MISMATCH');
  }
  const completed=receipts.filter(receipt=>receipt!==undefined),added=completed.reduce((sum,r)=>sum+BigInt(r.sizeBytes),0n);
  if(!(await tx.query(`UPDATE users SET storage_used_bytes=storage_used_bytes+$2::bigint
   WHERE id=$1 AND storage_used_bytes+storage_reserved_bytes+$2::bigint<=$3::bigint RETURNING id`,[scope.userId,added,this.config.storageQuotaBytes])).rowCount)throw new DomainError(409,'STORAGE_QUOTA_EXCEEDED');
  for(const r of completed){
   await tx.query(`INSERT INTO resources(resource_id,user_id,file_name,mime_type,size_bytes,sha256,object_key,object_version,storage_driver,storage_bucket,status)
    VALUES($1,$2,$3,$4,$5,NULL,$1,$6,$7,$8,'ready')`,[r.id,r.userId,r.fileName,r.mimeType,r.sizeBytes,r.object!.version,r.storageDriver,r.storageBucket]);
   await tx.query(`INSERT INTO storage_reservations(reservation_id,user_id,resource_key,requested_bytes,confirmed_bytes,status,expires_at)
    VALUES($1,$2,$3,$4,$4,'confirmed',$5)`,[randomUUID(),r.userId,`resource:${r.id}`,r.sizeBytes,new Date(r.expiresAt)]);
   afterCommit(tx,()=>this.uploads.forget(r.id));
  }
 }
}
