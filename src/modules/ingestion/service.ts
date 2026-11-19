import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import type {AppConfig} from '../../config/config.js';
import {transaction,assertScope,DomainError,type Scope} from '../identity/store.js';
import {enqueueIntent,event,newTaskMaxAttempts} from '../tasks/model.js';
import {kbSnapshot} from '../kb/profile.js';
import {createBuild,sourceState} from '../kb/repository.js';
import {digest} from '../../lib/crypto.js';
import type {KbBuild} from '../kb/types.js';
import {requireTocSection,sectionResult} from './sections.js';
import {resolveTraceId} from '../../lib/trace.js';
export class ContentAssetIndexService {
 constructor(readonly pool:pg.Pool,readonly config:AppConfig){}
 async schedule(tx:pg.PoolClient,scope:Scope,workspaceId:string,contentAssetId:string){
  await assertScope(tx,scope);
  const state=await sourceState(tx,{source_type:'content_asset',source_id:contentAssetId,user_id:scope.userId,workspace_id:workspaceId},true);
  if(state.deleted||!state.revision){await this.scheduleCleanup(tx,scope,workspaceId,contentAssetId);return;}
  if(Array.from(state.content!).length>this.config.rag.plainTextMaxChars)throw new DomainError(413,'RAG_PLAIN_TEXT_TOO_LARGE');
  const snapshot=kbSnapshot(this.config,'content-asset-hybrid','markdown');
  const old=(await tx.query<KbBuild>('SELECT * FROM kb_content_asset_hybrid_builds WHERE source_id=$1 AND source_revision=$2 AND config_hash=$3',[contentAssetId,state.revision,snapshot.configHash])).rows[0];
  if(old&&old.status!=='deleted'&&old.status!=='failed')return old;
  const taskId=randomUUID(),inputId=randomUUID();
  const build=await createBuild(tx,{type:'content_asset',id:contentAssetId,revision:state.revision,userId:scope.userId,workspaceId,content:state.content!,format:'markdown'},taskId,snapshot);
  await tx.query('INSERT INTO task_inputs(id,user_id,workspace_id,body) VALUES($1,$2,$3,$4)',[inputId,scope.userId,workspaceId,JSON.stringify({buildId:build.id})]);
  await tx.query("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,input_id,state,trace_id,max_attempts) VALUES($1,$2,$3,'kb.content-asset-index','content',$4,'queued',$5,$6)",[taskId,scope.userId,workspaceId,inputId,resolveTraceId(scope.traceId),newTaskMaxAttempts()]);
  await enqueueIntent(tx,taskId);await event(tx,taskId);return build;
 }
 async scheduleCleanup(tx:pg.PoolClient,scope:Scope,wid:string,contentAssetId:string){
  if(!(await tx.query('SELECT 1 FROM kb_content_asset_hybrid_builds WHERE source_id=$1 AND user_id=$2 AND workspace_id=$3 LIMIT 1',[contentAssetId,scope.userId,wid])).rowCount)return;
  const taskId=randomUUID(),inputId=randomUUID();await tx.query('INSERT INTO task_inputs(id,user_id,workspace_id,body) VALUES($1,$2,$3,$4)',[inputId,scope.userId,wid,JSON.stringify({contentAssetId})]);
  await tx.query("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,input_id,state,trace_id,max_attempts) VALUES($1,$2,$3,'kb.content-asset-cleanup','content',$4,'queued',$5,$6)",[taskId,scope.userId,wid,inputId,resolveTraceId(scope.traceId),newTaskMaxAttempts()]);await enqueueIntent(tx,taskId);await event(tx,taskId);
 }
 async listContentAssetJobs(scope:Scope,wid:string,contentAssetId:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);await sourceState(tx,{source_type:'content_asset',source_id:contentAssetId,user_id:scope.userId,workspace_id:wid});const rows=await tx.query<KbBuild>('SELECT * FROM kb_content_asset_hybrid_builds WHERE source_id=$1 AND user_id=$2 AND workspace_id=$3 ORDER BY created_at DESC LIMIT 50',[contentAssetId,scope.userId,wid]);return {items:rows.rows.map(b=>({buildId:b.id,jobId:b.task_id,sourceRevision:b.source_revision,status:b.status,chunkCount:b.chunk_count,tocStatus:b.toc_status}))};});}
 async contentAssetJob(scope:Scope,wid:string,contentAssetId:string,jobId:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);const row=(await tx.query<KbBuild>('SELECT * FROM kb_content_asset_hybrid_builds WHERE source_id=$1 AND user_id=$2 AND workspace_id=$3 AND task_id=$4',[contentAssetId,scope.userId,wid,jobId])).rows[0];if(!row)throw new DomainError(404,'INGEST_JOB_NOT_FOUND');const source=await sourceState(tx,row);if(source.deleted||source.revision!==row.source_revision)throw new DomainError(409,'KB_SOURCE_SUPERSEDED');return row;});}
 async contentAssetSection(scope:Scope,wid:string,contentAssetId:string,jobId:string,sectionId:string){const b=await this.contentAssetJob(scope,wid,contentAssetId,jobId);const section=requireTocSection(b.toc_status,b.toc,sectionId);const state=await transaction(this.pool,tx=>sourceState(tx,b));if(state.revision!==b.source_revision||digest(state.content!)!==b.content_hash)throw new DomainError(409,'KB_SOURCE_SUPERSEDED');return sectionResult(section,b.source_revision,'markdown',state.content!.slice(section.sourceStart,section.sourceEnd));}
}
