import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import type {AppConfig} from '../../config/config.js';
import {transaction,assertScope,DomainError,type Scope} from '../identity/store.js';
import {enqueueIntent,event} from '../tasks/model.js';
import {kbSnapshot} from '../kb/profile.js';
import {createBuild,sourceState} from '../kb/repository.js';
import {digest} from '../kb/split.js';
import type {KbBuild} from '../kb/types.js';
import {requireTocSection,sectionResult} from './sections.js';
export class NoteIndexService {
 constructor(readonly pool:pg.Pool,readonly config:AppConfig){}
 async schedule(tx:pg.PoolClient,scope:Scope,workspaceId:string,noteId:string){
  await assertScope(tx,scope);
  const state=await sourceState(tx,{source_type:'note',source_id:noteId,user_id:scope.userId,workspace_id:workspaceId},true);
  if(state.deleted||!state.revision){await this.scheduleCleanup(tx,scope,workspaceId,noteId);return;}
  if(Array.from(state.content!).length>this.config.rag.plainTextMaxChars)throw new DomainError(413,'RAG_PLAIN_TEXT_TOO_LARGE');
  const snapshot=kbSnapshot(this.config,'note-hybrid','markdown');
  const old=(await tx.query<KbBuild>('SELECT * FROM kb_note_hybrid_builds WHERE source_id=$1 AND source_revision=$2 AND config_hash=$3',[noteId,state.revision,snapshot.configHash])).rows[0];
  if(old&&old.status!=='deleted'&&old.status!=='failed')return old;
  const taskId=randomUUID(),inputId=randomUUID();
  const build=await createBuild(tx,{type:'note',id:noteId,revision:state.revision,userId:scope.userId,workspaceId,content:state.content!,format:'markdown'},taskId,snapshot);
  await tx.query('INSERT INTO task_inputs(id,user_id,workspace_id,body) VALUES($1,$2,$3,$4)',[inputId,scope.userId,workspaceId,JSON.stringify({buildId:build.id})]);
  await tx.query("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,input_id,state) VALUES($1,$2,$3,'kb.note-index','content',$4,'queued')",[taskId,scope.userId,workspaceId,inputId]);
  await enqueueIntent(tx,taskId);await event(tx,taskId);return build;
 }
 async scheduleCleanup(tx:pg.PoolClient,scope:Scope,wid:string,noteId:string){
  if(!(await tx.query('SELECT 1 FROM kb_note_hybrid_builds WHERE source_id=$1 AND user_id=$2 AND workspace_id=$3 LIMIT 1',[noteId,scope.userId,wid])).rowCount)return;
  const taskId=randomUUID(),inputId=randomUUID();await tx.query('INSERT INTO task_inputs(id,user_id,workspace_id,body) VALUES($1,$2,$3,$4)',[inputId,scope.userId,wid,JSON.stringify({noteId})]);
  await tx.query("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,input_id,state) VALUES($1,$2,$3,'kb.note-cleanup','content',$4,'queued')",[taskId,scope.userId,wid,inputId]);await enqueueIntent(tx,taskId);await event(tx,taskId);
 }
 async listNoteJobs(scope:Scope,wid:string,noteId:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);await sourceState(tx,{source_type:'note',source_id:noteId,user_id:scope.userId,workspace_id:wid});const rows=await tx.query<KbBuild>('SELECT * FROM kb_note_hybrid_builds WHERE source_id=$1 AND user_id=$2 AND workspace_id=$3 ORDER BY created_at DESC LIMIT 50',[noteId,scope.userId,wid]);return {items:rows.rows.map(b=>({buildId:b.id,jobId:b.task_id,sourceRevision:b.source_revision,status:b.status,chunkCount:b.chunk_count,tocStatus:b.toc_status}))};});}
 async noteJob(scope:Scope,wid:string,noteId:string,jobId:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);const row=(await tx.query<KbBuild>('SELECT * FROM kb_note_hybrid_builds WHERE source_id=$1 AND user_id=$2 AND workspace_id=$3 AND task_id=$4',[noteId,scope.userId,wid,jobId])).rows[0];if(!row)throw new DomainError(404,'INGEST_JOB_NOT_FOUND');const source=await sourceState(tx,row);if(source.deleted||source.revision!==row.source_revision)throw new DomainError(409,'KB_SOURCE_SUPERSEDED');return row;});}
 async noteSection(scope:Scope,wid:string,noteId:string,jobId:string,sectionId:string){const b=await this.noteJob(scope,wid,noteId,jobId);const section=requireTocSection(b.toc_status,b.toc,sectionId);const state=await transaction(this.pool,tx=>sourceState(tx,b));if(state.revision!==b.source_revision||digest(state.content!)!==b.content_hash)throw new DomainError(409,'KB_SOURCE_SUPERSEDED');return sectionResult(section,b.source_revision,'markdown',state.content!.slice(section.sourceStart,section.sourceEnd));}
}
