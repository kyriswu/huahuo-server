import type pg from 'pg';
import type { AssetKind } from '../../contracts/asset-kind.js';
import type { ContentStatus } from '../../contracts/content-status.js';
import type { AppConfig } from '../../config/config.js';
import { DOCUMENT_CANONICAL_MAX_BYTES } from '../../config/document-extraction.js';
import { transaction, DomainError } from '../identity/store.js';
import { tablesForSource, type KbBuild, type KbSnapshot, type KbSource } from './types.js';
import { digest } from '../../lib/crypto.js';
import type { AssetIndexMetadata } from '../../lib/search-index/types.js';
import { storageFor } from '../storage/port.js';

interface ContentAssetIndexRow {
 state: string;
 processing_status: ContentStatus;
 asset_kind: AssetKind;
 created_at: Date;
 updated_at: Date;
 revision: string | null;
 content: string | null;
}
export const uuidFor=(value:string)=>{const h=digest(value);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export async function createBuild(tx:pg.PoolClient,source:KbSource,taskId:string,snapshot:KbSnapshot):Promise<KbBuild>{
 const {builds,chunks}=tablesForSource(source.type);
 const id=uuidFor(JSON.stringify([source.type,source.id,source.revision,snapshot.configHash]));
 const fields = [id,source.type,source.id,source.revision,source.userId,taskId,digest(source.content),snapshot.configHash,JSON.stringify(snapshot)];
 const document = source.type !== 'content_asset';
 if(document&&!source.workspaceId)throw new Error('KB_DOCUMENT_WORKSPACE_REQUIRED');
 const row=(await tx.query<KbBuild>(`INSERT INTO ${builds}(id,source_type,source_id,source_revision,user_id,task_id,content_hash,config_hash,snapshot${document?",workspace_id":""})
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb${document?",$10":""}) ON CONFLICT(id) DO UPDATE SET task_id=EXCLUDED.task_id,updated_at=now() RETURNING *`,
 document?[...fields,source.workspaceId]:fields)).rows[0]!;
 if(!row.published&&(row.status==='deleted'||row.cleanup_status==='ready')){
  await tx.query(`DELETE FROM ${chunks} WHERE build_id=$1`,[row.id]);
  await tx.query(`UPDATE ${builds} SET planned=false,status='pending',cleanup_status='pending',chunk_count=0 WHERE id=$1`,[row.id]);
  row.planned=false;row.status='pending';row.cleanup_status='pending';
 }
 return row;
}
export async function sourceState(tx:pg.PoolClient,build:Pick<KbBuild,'source_type'|'source_id'|'user_id'|'workspace_id'>,lock=false):Promise<{revision:string;content?:string;uri?:string;deleted:boolean;format:'text'|'markdown';assetMetadata?:Omit<AssetIndexMetadata,'buildId'>}>{
 const params=[build.source_id,build.user_id,build.workspace_id];
 if(build.source_type==='content_asset'){
  const row=(await tx.query<ContentAssetIndexRow>(`SELECT asset.state,asset.processing_status,asset.asset_kind,asset.created_at,asset.updated_at,p.part_revision_id::text AS revision,p.content_markdown AS content
   FROM content_assets asset
   JOIN users u ON u.id=asset.user_id AND u.status='active' AND u.deleted_at IS NULL
   LEFT JOIN content_asset_parts p ON p.content_asset_id=asset.content_asset_id AND p.part='raw'
   WHERE asset.content_asset_id=$1 AND asset.user_id=$2 ${lock?'FOR UPDATE OF asset':''}`,params.slice(0,2))).rows[0];
  if(!row)throw new DomainError(404,'CONTENT_ASSET_NOT_FOUND');
  return {revision:row.revision??'',content:row.content??'',deleted:row.state!=='active'||row.processing_status!=='ready'||!String(row.content??'').trim(),format:'markdown',assetMetadata:{assetKind:row.asset_kind,createdAt:row.created_at.getTime(),updatedAt:row.updated_at.getTime()}};
 }
 if(build.source_type==='file'){
  const row=(await tx.query(`SELECT v.content_hash AS revision,v.canonical_content_uri AS uri,v.deleted_at,v.status,v.active
   FROM rag_ingestion_versions v JOIN workspaces w ON w.id=v.workspace_id AND w.user_id=v.user_id AND w.state='ready' JOIN users u ON u.id=w.user_id AND u.status='active' AND u.deleted_at IS NULL
   WHERE v.id=$1 AND v.user_id=$2 AND v.workspace_id=$3 ${lock?'FOR UPDATE OF v':''}`,params)).rows[0];
  if(!row)throw new DomainError(404,'RAG_DOCUMENT_NOT_FOUND');
  return {revision:row.revision??'',uri:row.uri,deleted:!!row.deleted_at||!row.active,format:'markdown'};
 }
 const row=(await tx.query(`SELECT j.content_hash AS revision,j.raw_content AS content FROM text_ingestion_jobs j
 JOIN workspaces w ON w.id=j.workspace_id AND w.user_id=j.created_by AND w.state='ready' JOIN users u ON u.id=w.user_id AND u.status='active' AND u.deleted_at IS NULL
 WHERE j.id=$1 AND j.created_by=$2 AND j.workspace_id=$3 ${lock?'FOR UPDATE OF j':''}`,params)).rows[0];
 if(!row)throw new DomainError(404,'TEXT_INGESTION_NOT_FOUND');
 return {revision:row.revision??'',content:row.content??'',deleted:false,format:'markdown'};
}
export async function sourceContent(pool:pg.Pool,config:AppConfig,build:KbBuild):Promise<KbSource>{
 const state=await transaction(pool,tx=>sourceState(tx,build));
 if(state.deleted||state.revision!==build.source_revision)throw new DomainError(409,'KB_SOURCE_SUPERSEDED');
 const content=await readSourceBody(config,build.content_hash,state);
 return {type:build.source_type,id:build.source_id,revision:build.source_revision,userId:build.user_id,...(build.workspace_id?{workspaceId:build.workspace_id}:{}),content,format:build.snapshot.format,assetMetadata:state.assetMetadata};
}
export async function readSourceBody(config:AppConfig,expectedHash:string,state:{content?:string|null;uri?:string|null}):Promise<string>{
 let content=state.content??undefined;
 if(content===undefined&&state.uri){
  const parts:Buffer[]=[];const stream=await storageFor(config).read(state.uri);
  let bytes=0;try{for await(const p of stream){const b=Buffer.isBuffer(p)?p:Buffer.from(p);bytes+=b.length;if(bytes>DOCUMENT_CANONICAL_MAX_BYTES)throw new Error('KB_BODY_TOO_LARGE');parts.push(b);}}finally{stream.destroy();}
  content=Buffer.concat(parts).toString('utf8');
 }
 if(content===undefined||digest(content)!==expectedHash)throw new Error('KB_BODY_CHANGED');
 return content;
}
