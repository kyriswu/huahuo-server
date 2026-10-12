import type pg from 'pg';
import { DomainError } from '../identity/store.js';
/** Call in the same transaction as the owning message/profile mutation. Serializes against deletion. */
export async function attachResource(tx:pg.PoolClient,userId:string,resourceId:string,kind:string,externalId:string,workspaceId?:string){
 const r=await tx.query("SELECT * FROM resources WHERE resource_id=$1 AND user_id=$2 AND status='ready' FOR UPDATE",[resourceId,userId]);const resource=r.rows[0];
 if(!resource||(workspaceId&&resource.workspace_id!==workspaceId))throw new DomainError(404,'RESOURCE_NOT_FOUND');
 if(kind==='avatar'&&!resource.mime_type.startsWith('image/'))throw new DomainError(409,'AVATAR_RESOURCE_NOT_IMAGE');
 await tx.query('INSERT INTO resource_refs(resource_id,user_id,workspace_id,ref_kind,ref_id_external) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[resourceId,userId,resource.workspace_id,kind,externalId]);
}
