import type pg from 'pg';
import { DomainError } from '../identity/store.js';
import { storageJob } from './jobs.js';

async function workspace(tx:pg.PoolClient,userId:string,id?:string){
 if(id&&!(await tx.query("SELECT id FROM workspaces WHERE id=$1 AND user_id=$2 AND state='ready' FOR SHARE",[id,userId])).rowCount)throw new DomainError(404,'WORKSPACE_NOT_FOUND');
}
async function count(tx:pg.PoolClient,userId:string,ids:string[],delta:number){
 if(!ids.length)return;
 const changed=await tx.query<{resource_id:string;reference_count:string}>('UPDATE resources SET reference_count=reference_count+$3 WHERE user_id=$1 AND resource_id=ANY($2::uuid[]) AND reference_count+$3>=0 RETURNING resource_id,reference_count',[userId,ids,delta]);
 if(changed.rowCount!==ids.length)throw new DomainError(409,'RESOURCE_REFERENCE_COUNT_INCONSISTENT');
 if(delta<0){
  const empty=changed.rows.filter(row=>row.reference_count==='0').map(row=>row.resource_id);
  if(empty.length){
   const deleting=await tx.query<{resource_id:string}>(`UPDATE resources r SET status='deleting'
    WHERE user_id=$1 AND resource_id=ANY($2::uuid[]) AND status='ready'
     AND NOT EXISTS(SELECT 1 FROM resource_refs rr WHERE rr.resource_id=r.resource_id) RETURNING resource_id`,[userId,empty]);
   if(deleting.rowCount!==empty.length)throw new DomainError(409,'RESOURCE_REFERENCE_COUNT_INCONSISTENT');
   for(const row of deleting.rows)await storageJob(tx,userId,null,'delete',row.resource_id);
  }
 }
}
/** The business record, relation and count always share one transaction. */
export async function attachResource(tx:pg.PoolClient,userId:string,resourceId:string,kind:string,externalId:string,workspaceId?:string){
 await workspace(tx,userId,workspaceId);
 const resource=(await tx.query("SELECT * FROM resources WHERE resource_id=$1 AND user_id=$2 AND status='ready' FOR UPDATE",[resourceId,userId])).rows[0];
 if(!resource)throw new DomainError(404,'RESOURCE_NOT_FOUND');
 if(kind==='avatar'&&!resource.mime_type.startsWith('image/'))throw new DomainError(409,'AVATAR_RESOURCE_NOT_IMAGE');
 const inserted=await tx.query<{resource_id:string}>('INSERT INTO resource_refs(resource_id,user_id,workspace_id,ref_kind,ref_id_external) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING resource_id',[resourceId,userId,workspaceId??null,kind,externalId]);
 await count(tx,userId,inserted.rows.map(row=>row.resource_id),1);
}

/** Replace one business object's complete reference set, including removals. */
export async function replaceResourceRefs(tx:pg.PoolClient,userId:string,kind:string,externalId:string,ids:readonly string[],workspaceId?:string){
 await workspace(tx,userId,workspaceId);
 const wanted=[...new Set(ids.map(id=>id.toLowerCase()))].sort();
 const previous=(await tx.query<{resource_id:string}>('SELECT resource_id FROM resource_refs WHERE user_id=$1 AND ref_kind=$2 AND ref_id_external=$3 AND workspace_id IS NOT DISTINCT FROM $4::uuid',[userId,kind,externalId,workspaceId??null])).rows.map(row=>row.resource_id);
 const all=[...new Set([...previous,...wanted])].sort();
 if(all.length){
  const resources=(await tx.query<{resource_id:string;status:string;mime_type:string}>('SELECT resource_id,status,mime_type FROM resources WHERE user_id=$1 AND resource_id=ANY($2::uuid[]) ORDER BY resource_id FOR UPDATE',[userId,all])).rows;
  if(resources.length!==all.length||resources.some(row=>wanted.includes(row.resource_id)&&row.status!=='ready'))throw new DomainError(404,'RESOURCE_NOT_FOUND');
  if(kind==='avatar'&&resources.some(row=>wanted.includes(row.resource_id)&&!row.mime_type.startsWith('image/')))throw new DomainError(409,'AVATAR_RESOURCE_NOT_IMAGE');
 }
 const removed=await tx.query<{resource_id:string}>('DELETE FROM resource_refs WHERE user_id=$1 AND ref_kind=$2 AND ref_id_external=$3 AND workspace_id IS NOT DISTINCT FROM $4::uuid AND NOT(resource_id=ANY($5::uuid[])) RETURNING resource_id',[userId,kind,externalId,workspaceId??null,wanted]);
 await count(tx,userId,removed.rows.map(row=>row.resource_id),-1);
 if(wanted.length){
  const added=await tx.query<{resource_id:string}>(`INSERT INTO resource_refs(resource_id,user_id,workspace_id,ref_kind,ref_id_external)
   SELECT id,$2,$3,$4,$5 FROM unnest($1::uuid[]) x(id) ON CONFLICT DO NOTHING RETURNING resource_id`,[wanted,userId,workspaceId??null,kind,externalId]);
  await count(tx,userId,added.rows.map(row=>row.resource_id),1);
 }
}
