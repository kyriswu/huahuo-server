import type pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import { transaction, DomainError } from '../identity/store.js';
import { tablesFor, type KbBuild, type KbSnapshot, type KbSource, type KbSourceType } from './types.js';
import { digest } from './split.js';
import { storageFor } from '../storage/port.js';
export const uuidFor=(value:string)=>{const h=digest(value);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export async function createBuild(tx:pg.PoolClient,source:KbSource,taskId:string,snapshot:KbSnapshot):Promise<KbBuild>{
 const {builds,chunks}=tablesFor(snapshot.mode);
 const id=uuidFor(JSON.stringify([source.type,source.id,source.revision,snapshot.configHash]));
 const row=(await tx.query<KbBuild>(`INSERT INTO ${builds}(id,source_type,source_id,source_revision,user_id,workspace_id,task_id,content_hash,config_hash,snapshot)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(id) DO UPDATE SET task_id=EXCLUDED.task_id,updated_at=now() RETURNING *`,
 [id,source.type,source.id,source.revision,source.userId,source.workspaceId,taskId,digest(source.content),snapshot.configHash,JSON.stringify(snapshot)])).rows[0]!;
 if(!row.published&&(row.status==='deleted'||row.cleanup_status==='ready')){
  await tx.query(`DELETE FROM ${chunks} WHERE build_id=$1`,[row.id]);
  await tx.query(`UPDATE ${builds} SET planned=false,status='pending',cleanup_status='pending',chunk_count=0 WHERE id=$1`,[row.id]);
  row.planned=false;row.status='pending';row.cleanup_status='pending';
 }
 return row;
}
export async function sourceState(tx:pg.PoolClient,build:Pick<KbBuild,'source_type'|'source_id'|'user_id'|'workspace_id'>,lock=false):Promise<{revision:string;content?:string;uri?:string;deleted:boolean;format:'text'|'markdown'}>{
 const params=[build.source_id,build.user_id,build.workspace_id];
 if(build.source_type==='note'){
  const row=(await tx.query(`SELECT n.state,n.processing_status,p.part_revision_id::text AS revision,p.content_markdown AS content
   FROM notes n JOIN workspaces w ON w.id=n.workspace_id AND w.user_id=$2 AND w.state='ready' JOIN users u ON u.id=w.user_id AND u.status='active' AND u.deleted_at IS NULL
   LEFT JOIN LATERAL(SELECT part_revision_id,content_markdown FROM note_part_revisions WHERE note_id=n.note_id AND part='raw' ORDER BY revision DESC LIMIT 1)p ON true
   WHERE n.note_id=$1 AND n.workspace_id=$3 ${lock?'FOR UPDATE OF n':''}`,params)).rows[0];
  if(!row)throw new DomainError(404,'NOTE_NOT_FOUND');
  return {revision:row.revision??'',content:row.content??'',deleted:row.state!=='active'||row.processing_status!=='ready'||!String(row.content??'').trim(),format:'markdown'};
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
 let content=state.content;
 if(content===undefined&&state.uri){
  const parts:Buffer[]=[];const stream=await storageFor(config).read(state.uri);
  let bytes=0;try{for await(const p of stream){const b=Buffer.from(p);bytes+=b.length;if(bytes>config.rag.maxSourceBytes*5)throw new Error('KB_BODY_TOO_LARGE');parts.push(b);}}finally{stream.destroy();}
  content=Buffer.concat(parts).toString('utf8');
 }
 if(content===undefined||digest(content)!==build.content_hash)throw new Error('KB_BODY_CHANGED');
 return {type:build.source_type,id:build.source_id,revision:build.source_revision,userId:build.user_id,workspaceId:build.workspace_id,content,format:build.snapshot.format};
}
export const modeForSource=(type:KbSourceType)=>type==='note'?'note-hybrid':'document-keyword';
