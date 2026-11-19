import { idempotent } from '../../lib/idempotency.js';
import {resolveTraceId} from '../../lib/trace.js';
import {tagGraph,type GraphQuery} from './tag-graph.js';
import type pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, assertScope, transaction, type Scope } from '../identity/store.js';
import { enqueueIntent, event, newTaskMaxAttempts } from '../tasks/model.js';
import type { AppConfig } from '../../config/config.js';
import { RagQueryService } from '../rag/query-service.js';
import { NoteIndexService } from '../ingestion/service.js';
import { normalizeOwnedImageParts, restoreOwnedImageParts } from '../storage/image-content.js';
import { syncNoteRefs, type NoteResourceRef } from './note-images.js';
import { EDITABLE_MARKDOWN_MAX_CHARS } from '../../lib/kb-image-markdown.js';
import { listNotePage } from './note-list.js';
import type { ResourceClaims } from '../storage/resource-claims.js';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const normalize=(v:string)=>v.trim().normalize('NFKC').toLocaleLowerCase();
const etag=(id:string,version:number)=>`"note-${id}-${version}"`;
const folderEtag=(id:string,version:number)=>`"folder-${id}-${version}"`;
interface NoteStateRow {note_id:string;note_revision:number;note_revision_id:string;etag:string;state:'active'|'deleted';folder_id:string|null;}
interface FolderStateRow {folder_id:string;parent_folder_id:string|null;revision:number;current_revision_id:string;state:'active'|'deleted';deleted_by_folder_id:string|null;}
const parts=['raw','outline','germination'] as const; type Part=typeof parts[number];
function checkPart(part:string):asserts part is Part{if(!parts.includes(part as Part))throw new DomainError(400,'NOTE_PART_INVALID');}
function checkNoteParts(values:Record<string,string>,mode:'create'|'update'|'input'='update'):void{
 for(const [part,text] of Object.entries(values)){
  checkPart(part);const limit=mode==='input'?EDITABLE_MARKDOWN_MAX_CHARS:mode==='create'&&part!=='raw'?200000:500000;
  if(text.length<=limit)continue;
  let chars=0;
  for(let offset=0;offset<text.length;offset+=text.codePointAt(offset)!>0xffff?2:1)
   if(++chars>limit)throw new DomainError(400,'NOTE_CONTENT_TOO_LARGE');
 }
}
export class AssetService {
 constructor(readonly pool:pg.Pool,readonly secret:string,readonly config?:AppConfig,private readonly ragQuery?:RagQueryService,private readonly resourceClaims?:ResourceClaims){}
 private async indexNote(tx:pg.PoolClient,scope:Scope,wid:string,noteId:string){if(this.config?.kb.noteEnabled)await new NoteIndexService(this.pool,this.config).schedule(tx,scope,wid,noteId);}
 private async workspace(tx:pg.PoolClient,scope:Scope,id:string){const r=await tx.query("SELECT id FROM workspaces WHERE id=$1 AND user_id=$2 AND state='ready'",[id,scope.userId]);if(!r.rowCount)throw new DomainError(404,'WORKSPACE_NOT_FOUND');}
 // Ordinary Note mutations share the tree fence so independent account/resource
 // and Note row locks retain their ordering; folder cascades need exclusive access.
 private async lockTree(tx:pg.PoolClient,wid:string,shared=false){await tx.query(`SELECT ${shared?'pg_advisory_xact_lock_shared':'pg_advisory_xact_lock'}(hashtextextended($1,0))`,[`asset-tree:${wid}`]);}
 private async cursor(tx:pg.PoolClient,workspaceId:string,kind:string,id:string,change:string,tombstone:boolean,revisionId:string|null,version:number|null,previousRevisionId:string|null,previousVersion:number|null){await tx.query('INSERT INTO workspace_content_state(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',[workspaceId]);const c=await tx.query<{next_cursor:string}>("UPDATE workspace_content_state SET next_cursor=next_cursor+1,updated_at=now() WHERE workspace_id=$1 RETURNING next_cursor",[workspaceId]);const cursor=String(c.rows[0]!.next_cursor),eventId=randomUUID(),operationId=randomUUID();await tx.query('INSERT INTO content_events(event_id,workspace_id,cursor,operation_id,object_kind,object_id,change_type,tombstone,revision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[eventId,workspaceId,cursor,operationId,kind,id,change,tombstone,revisionId]);return {eventId,workspaceId,cursor,operationId,occurredAt:new Date().toISOString(),objectKind:kind,objectId:id,changeType:change,tombstone,resourcePinDelta:{added:[],released:[]},...(revisionId?{revisionId}:{}) ,...(previousRevisionId?{previousRevisionId}:{}),...(version!==null?{version}:{}) ,...(previousVersion!==null?{previousVersion}:{})};}
 private async noteDto(tx:pg.PoolClient,workspaceId:string,noteId:string){const n=(await tx.query('SELECT * FROM notes WHERE workspace_id=$1 AND note_id=$2',[workspaceId,noteId])).rows[0];if(!n)throw new DomainError(404,'NOTE_NOT_FOUND');const p=await tx.query('SELECT part,part_revision_id,content_markdown,content_sha256 FROM note_parts WHERE note_id=$1',[noteId]);const map=new Map(p.rows.map(x=>[x.part,x]));const refs=await tx.query(`SELECT r.resource_id,r.sha256,r.mime_type,n.ref_order,n.usage,n.anchor,n.alt FROM note_resource_refs n JOIN resources r ON r.resource_id=n.resource_id WHERE n.note_id=$1 ORDER BY n.ref_order`,[noteId]);return {noteId:n.note_id,workspaceId,folderId:n.folder_id,title:n.title,state:n.state,noteRevisionId:n.note_revision_id,parts:Object.fromEntries(parts.map(part=>{const x=map.get(part);return [part,x?{partRevisionId:x.part_revision_id,contentMarkdown:x.content_markdown,contentSha256:x.content_sha256}:{partRevisionId:'absent-'+noteId+'-'+part,contentMarkdown:'',contentSha256:sha('')}];})),resourceRefs:refs.rows.map(x=>({resourceId:x.resource_id,order:x.ref_order,usage:x.usage,anchor:x.anchor,alt:x.alt,sha256:x.sha256,mimeType:x.mime_type})),etag:n.etag,contentCursor:String((await tx.query('SELECT coalesce(next_cursor,0) c FROM workspace_content_state WHERE workspace_id=$1',[workspaceId])).rows[0]?.c??0),sourceKind:n.source_kind,sourceRef:n.source_id?{kind:n.source_kind,id:n.source_id}:null,createdAt:n.created_at.toISOString(),updatedAt:n.updated_at.toISOString()};}
 private async folderDto(tx:pg.PoolClient,id:string){const f=(await tx.query('SELECT * FROM asset_folders WHERE folder_id=$1',[id])).rows[0];if(!f)throw new DomainError(404,'FOLDER_NOT_FOUND');return {folderId:f.folder_id,workspaceId:f.workspace_id,parentFolderId:f.parent_folder_id,displayName:f.display_name,normalizedName:f.normalized_name,state:f.state,currentRevisionId:f.current_revision_id,etag:folderEtag(f.folder_id,Number(f.revision)),contentCursor:String((await tx.query('SELECT coalesce(next_cursor,0) c FROM workspace_content_state WHERE workspace_id=$1',[f.workspace_id])).rows[0]?.c??0)};}
 async getFolder(scope:Scope,wid:string,id:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);await this.workspace(tx,scope,wid);const f=await tx.query('SELECT 1 FROM asset_folders WHERE folder_id=$1 AND workspace_id=$2',[id,wid]);if(!f.rowCount)throw new DomainError(404,'FOLDER_NOT_FOUND');return this.folderDto(tx,id);});}
 async listFolders(scope:Scope,wid:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);await this.workspace(tx,scope,wid);const r=await tx.query('SELECT * FROM asset_folders WHERE workspace_id=$1 ORDER BY parent_folder_id NULLS FIRST,normalized_name,folder_id',[wid]);return {folders:await Promise.all(r.rows.map(x=>this.folderDto(tx,x.folder_id)))};});}
 async createFolder(scope:Scope,wid:string,input:{displayName:string;parentFolderId?:string|null},key:string){if(!input.displayName.trim())throw new DomainError(400,'FOLDER_NAME_INVALID');return transaction(this.pool,async tx=>{await assertScope(tx,scope);await this.workspace(tx,scope,wid);await this.lockTree(tx,wid);return idempotent(tx,this.secret,`${scope.userId}:${wid}`,'folder.create',key,input,async()=>{if(input.parentFolderId){const p=await tx.query("SELECT 1 FROM asset_folders WHERE folder_id=$1 AND workspace_id=$2 AND state='active'",[input.parentFolderId,wid]);if(!p.rowCount)throw new DomainError(404,'PARENT_FOLDER_NOT_FOUND');}const id=randomUUID(),rev=randomUUID();try{await tx.query('INSERT INTO asset_folders(folder_id,workspace_id,parent_folder_id,display_name,normalized_name,current_revision_id) VALUES($1,$2,$3,$4,$5,$6)',[id,wid,input.parentFolderId??null,input.displayName.trim(),normalize(input.displayName),rev]);}catch(e){if((e as {code?:string}).code==='23505')throw new DomainError(409,'FOLDER_NAME_CONFLICT');throw e;}await this.cursor(tx,wid,'folder',id,'created',false,rev,1,null,null);return this.folderDto(tx,id);});});}
 async updateFolder(scope:Scope,wid:string,id:string,displayName:string,ifMatch:string,key:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);await this.workspace(tx,scope,wid);await this.lockTree(tx,wid);return idempotent(tx,this.secret,`${scope.userId}:${wid}`,'folder.update',key,{id,displayName,ifMatch},async()=>{const f=(await tx.query('SELECT * FROM asset_folders WHERE folder_id=$1 AND workspace_id=$2 AND state=\'active\' FOR UPDATE',[id,wid])).rows[0];if(!f)throw new DomainError(404,'FOLDER_NOT_FOUND');if(folderEtag(id,Number(f.revision))!==ifMatch)throw new DomainError(412,'FOLDER_REVISION_MISMATCH');const rev=randomUUID(),v=Number(f.revision)+1;await tx.query('UPDATE asset_folders SET display_name=$2,normalized_name=$3,current_revision_id=$4,revision=$5,updated_at=now() WHERE folder_id=$1',[id,displayName.trim(),normalize(displayName),rev,v]);await this.cursor(tx,wid,'folder',id,'updated',false,rev,v,f.current_revision_id,Number(f.revision));return this.folderDto(tx,id);});});}
 private async assertNoCycle(tx:pg.PoolClient,wid:string,id:string,parent:string|null){if(!parent)return;const r=await tx.query(`WITH RECURSIVE chain(id) AS (SELECT $1::uuid UNION ALL SELECT parent_folder_id FROM asset_folders f JOIN chain c ON f.folder_id=c.id WHERE f.parent_folder_id IS NOT NULL) SELECT 1 FROM chain WHERE id=$2 LIMIT 1`,[parent,id]);if(r.rowCount)throw new DomainError(409,'FOLDER_CYCLE');const p=await tx.query("SELECT 1 FROM asset_folders WHERE folder_id=$1 AND workspace_id=$2 AND state='active'",[parent,wid]);if(!p.rowCount)throw new DomainError(404,'PARENT_FOLDER_NOT_FOUND');}
 async moveFolder(scope:Scope,wid:string,id:string,parent:string|null,ifMatch:string,key:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);await this.workspace(tx,scope,wid);await this.lockTree(tx,wid);return idempotent(tx,this.secret,`${scope.userId}:${wid}`,'folder.move',key,{id,parent,ifMatch},async()=>{const f=(await tx.query('SELECT * FROM asset_folders WHERE folder_id=$1 AND workspace_id=$2 AND state=\'active\' FOR UPDATE',[id,wid])).rows[0];if(!f)throw new DomainError(404,'FOLDER_NOT_FOUND');if(folderEtag(id,Number(f.revision))!==ifMatch)throw new DomainError(412,'FOLDER_REVISION_MISMATCH');await this.assertNoCycle(tx,wid,id,parent);const rev=randomUUID(),v=Number(f.revision)+1;await tx.query('UPDATE asset_folders SET parent_folder_id=$2,current_revision_id=$3,revision=$4,updated_at=now() WHERE folder_id=$1',[id,parent,rev,v]);return this.cursor(tx,wid,'folder',id,'moved',false,rev,v,f.current_revision_id,Number(f.revision));});});}
 async deleteFolder(scope:Scope,wid:string,id:string,ifMatch:string,key:string,restore=false){
  return transaction(this.pool,async tx=>{
   await assertScope(tx,scope);await this.workspace(tx,scope,wid);await this.lockTree(tx,wid);
   return idempotent(tx,this.secret,`${scope.userId}:${wid}`,restore?'folder.restore':'folder.delete',key,{id,ifMatch},async()=>{
    const root=(await tx.query<FolderStateRow>('SELECT * FROM asset_folders WHERE folder_id=$1 AND workspace_id=$2 FOR UPDATE',[id,wid])).rows[0];
    if(!root)throw new DomainError(404,'FOLDER_NOT_FOUND');
    if(folderEtag(id,Number(root.revision))!==ifMatch)throw new DomainError(412,'FOLDER_REVISION_MISMATCH');
    if(root.state!==(restore?'deleted':'active'))throw new DomainError(409,'FOLDER_STATE_CONFLICT');
    if(restore&&root.parent_folder_id&&!(await tx.query("SELECT 1 FROM asset_folders WHERE folder_id=$1 AND workspace_id=$2 AND state='active' FOR SHARE",[root.parent_folder_id,wid])).rowCount)throw new DomainError(409,'PARENT_FOLDER_DELETED');
    const folders=(await tx.query<FolderStateRow>(restore?
     `SELECT * FROM asset_folders WHERE workspace_id=$2 AND state='deleted' AND (folder_id=$1 OR deleted_by_folder_id=$1) ORDER BY folder_id FOR UPDATE`:
     `WITH RECURSIVE tree(id) AS (SELECT $1::uuid UNION SELECT f.folder_id FROM asset_folders f JOIN tree t ON f.parent_folder_id=t.id WHERE f.workspace_id=$2)
      SELECT f.* FROM asset_folders f JOIN tree t ON t.id=f.folder_id WHERE f.workspace_id=$2 AND f.state='active' ORDER BY f.folder_id FOR UPDATE OF f`,[id,wid])).rows;
    const folderIds=folders.map(f=>f.folder_id),state=restore?'active':'deleted';
    const notes=(await tx.query<NoteStateRow>(`SELECT * FROM notes WHERE workspace_id=$1 AND folder_id=ANY($2::uuid[]) AND state=$3
     ${restore?'AND deleted_by_folder_id=$4':''} ORDER BY note_id FOR UPDATE`,restore?[wid,folderIds,'deleted',id]:[wid,folderIds,'active'])).rows;
    const receipts=[];
    for(const folder of folders){
     const revision=Number(folder.revision)+1,revisionId=randomUUID();
     await tx.query('UPDATE asset_folders SET state=$2,deleted_by_folder_id=$3,revision=$4,current_revision_id=$5,updated_at=now() WHERE folder_id=$1',[folder.folder_id,state,restore?null:id,revision,revisionId]);
     receipts.push(await this.cursor(tx,wid,'folder',folder.folder_id,restore?'restored':'deleted',!restore,revisionId,revision,folder.current_revision_id,Number(folder.revision)));
    }
    for(const note of notes)receipts.push(await this.transitionNote(tx,scope,wid,note,restore,restore?null:id));
    return {affectedObjectCount:receipts.length,firstContentCursor:receipts[0]!.cursor,contentCursor:receipts.at(-1)!.cursor};
   });
  });
 }

 async listNotes(scope:Scope,wid:string,cursor?:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);await this.workspace(tx,scope,wid);return listNotePage(tx,wid,cursor);});}
 async getNote(scope:Scope,wid:string,id:string,revisionId?:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);await this.workspace(tx,scope,wid);const row=(await tx.query('SELECT note_revision_id,state FROM notes WHERE note_id=$1 AND workspace_id=$2 FOR SHARE',[id,wid])).rows[0];if(!row)throw new DomainError(404,'NOTE_NOT_FOUND');if(revisionId&&(row.note_revision_id!==revisionId||row.state!=='active'))throw new DomainError(409,'NOTE_REVISION_MISMATCH');return this.noteDto(tx,wid,id);});}
 private async task(tx:pg.PoolClient,scope:Scope,wid:string,noteId:string,revisionId:string){
  const tagSetVersion=Number((await tx.query('SELECT tag_set_version FROM notes WHERE note_id=$1 AND workspace_id=$2',[noteId,wid])).rows[0]?.tag_set_version??0);
  // task_inputs also contains plain text. Materialize the scoped tag jobs before
  // parsing their JSON so the planner cannot cast an unrelated task's body.
  const existing=(await tx.query(`WITH eligible AS MATERIALIZED (
    SELECT c.task_id,i.body FROM content_jobs c JOIN tasks t ON t.id=c.task_id JOIN task_inputs i ON i.id=t.input_id
    WHERE c.note_id=$1 AND c.note_revision_id=$2 AND c.operation='tag_extract' AND t.kind='asset.tag-extract'
      AND t.state IN ('queued','running','retry_scheduled') AND t.user_id=$4 AND t.workspace_id=$5
  ) SELECT task_id FROM eligible WHERE (body::jsonb->>'tagSetVersion')::bigint=$3 LIMIT 1`,[noteId,revisionId,tagSetVersion,scope.userId,wid])).rows[0];
  if(existing)return existing.task_id as string;
  const inputId=randomUUID(),taskId=randomUUID();
  await tx.query('INSERT INTO task_inputs(id,user_id,workspace_id,body) VALUES($1,$2,$3,$4)',[inputId,scope.userId,wid,JSON.stringify({noteId,revisionId,tagSetVersion})]);
  await tx.query("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,state,input_id,trace_id,max_attempts) VALUES($1,$2,$3,'asset.tag-extract','content','queued',$4,$5,$6)",[taskId,scope.userId,wid,inputId,resolveTraceId(scope.traceId),newTaskMaxAttempts()]);
  await tx.query("INSERT INTO content_jobs(task_id,note_id,note_revision_id,operation) VALUES($1,$2,$3,'tag_extract')",[taskId,noteId,revisionId]);
  await enqueueIntent(tx,taskId);await event(tx,taskId);return taskId;
 }
 private normalizeTagNames(names:string[]){
  const result:string[]=[];const seen=new Set<string>();
  for(const raw of names){
   if(typeof raw!=='string')throw new DomainError(400,'TAG_INVALID');
   const displayName=raw.normalize('NFKC').trim(),normalized=displayName.toLowerCase();
   if(!displayName||[...displayName].length>24||[...normalized].length>24||[...displayName].some(ch=>(ch.codePointAt(0)??0)<32||(ch.codePointAt(0)??0)===127))throw new DomainError(400,'TAG_INVALID');
   if(!seen.has(normalized)){seen.add(normalized);result.push(displayName);}
  }
  if(result.length>20)throw new DomainError(400,'TAG_LIMIT_EXCEEDED');
  return result;
 }
 private async tagDto(tx:pg.PoolClient,wid:string,noteId:string){
  const n=(await tx.query('SELECT * FROM notes WHERE note_id=$1 AND workspace_id=$2',[noteId,wid])).rows[0];
  if(!n)throw new DomainError(404,'NOTE_NOT_FOUND');
  const tags=await tx.query(`SELECT t.tag_id,t.display_name,t.normalized_name,nt.source FROM note_tags nt JOIN asset_tags t ON t.tag_id=nt.tag_id AND t.workspace_id=$2 WHERE nt.note_id=$1 ORDER BY t.normalized_name,t.tag_id`,[noteId,wid]);
  const suggestions=await tx.query(`SELECT suggestion_id,note_revision_id,labels,provider,status,created_at FROM note_tag_suggestions WHERE note_id=$1 AND workspace_id=$2 AND status='pending' AND note_revision_id=$3 AND expected_tag_set_version=$4 ORDER BY created_at DESC LIMIT 10`,[noteId,wid,n.note_revision_id,n.tag_set_version]);
  const job=(await tx.query(`SELECT c.task_id,c.outcome,c.provider,t.state,t.error_code FROM content_jobs c JOIN tasks t ON t.id=c.task_id WHERE c.note_id=$1 ORDER BY t.created_at DESC,t.id DESC LIMIT 1`,[noteId])).rows[0];
  return {noteId,tags:tags.rows.map(x=>({tagId:x.tag_id,displayName:x.display_name,normalizedName:x.normalized_name,source:x.source})),tagSetVersion:Number(n.tag_set_version),tagEtag:`"tags-${noteId}-${n.tag_set_version}"`,manualOverride:n.tag_manual_override,suggestions:suggestions.rows.map(x=>({suggestionId:x.suggestion_id,noteRevisionId:x.note_revision_id,labels:x.labels as string[],provider:x.provider,status:x.status,createdAt:x.created_at.toISOString()})),noteEtag:n.etag,processingStatus:n.processing_status as string,extraction:job?{taskId:job.task_id as string,status:job.state as string,outcome:job.outcome as string|null,provider:job.provider as string|null,errorCode:job.error_code as string|null}:null};
 }
 private async applyTagSetTx(tx:pg.PoolClient,wid:string,noteId:string,names:string[]){
  const normalized=this.normalizeTagNames(names);
  const ids:string[]=[];
  // Stable lock ordering for shared workspace labels.
  for(const displayName of normalized.sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()))){
   const row=(await tx.query(`INSERT INTO asset_tags(tag_id,workspace_id,normalized_name,display_name,source) VALUES($1,$2,$3,$4,'manual') ON CONFLICT(workspace_id,normalized_name) DO UPDATE SET display_name=asset_tags.display_name RETURNING tag_id`,[randomUUID(),wid,displayName.toLowerCase(),displayName])).rows[0];ids.push(row.tag_id);
  }
  await tx.query('DELETE FROM note_tags WHERE note_id=$1',[noteId]);
  for(const tagId of ids)await tx.query("INSERT INTO note_tags(note_id,tag_id,source) VALUES($1,$2,'manual')",[noteId,tagId]);
  const updated=(await tx.query('UPDATE notes SET tag_set_version=tag_set_version+1,tag_manual_override=true WHERE note_id=$1 RETURNING tag_set_version',[noteId])).rows[0];
  await tx.query("UPDATE note_tag_suggestions SET status='stale' WHERE note_id=$1 AND status='pending'",[noteId]);
  await this.cursor(tx,wid,'hnote',noteId,'updated',false,null,Number(updated.tag_set_version),null,null);
 }
 async noteTags(scope:Scope,wid:string,noteId:string){return transaction(this.pool,async tx=>{
  await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await assertScope(tx,scope);await this.workspace(tx,scope,wid);return this.tagDto(tx,wid,noteId);
 });}
 private async mutateTags(scope:Scope,wid:string,noteId:string,change:{replace?:string[];add?:string;remove?:string;rename?:{tagId:string;name:string};suggestionId?:string},ifMatch:string,key:string){
  return transaction(this.pool,async tx=>{
   await assertScope(tx,scope);await this.workspace(tx,scope,wid);
   return idempotent(tx,this.secret,`${scope.userId}:${wid}`,'note.tags.mutate',key,{noteId,change,ifMatch},async()=>{
    const n=(await tx.query("SELECT * FROM notes WHERE note_id=$1 AND workspace_id=$2 AND state='active' FOR UPDATE",[noteId,wid])).rows[0];
    if(!n)throw new DomainError(404,'NOTE_NOT_FOUND');
    if(ifMatch!==`"tags-${noteId}-${n.tag_set_version}"`)throw new DomainError(412,'TAG_REVISION_MISMATCH');
    const view=await this.tagDto(tx,wid,noteId);let names=view.tags.map(t=>t.displayName as string);
    if(change.replace)names=change.replace;
    if(change.add!==undefined)names.push(change.add);
    if(change.remove||change.rename){
     const id=change.remove??change.rename!.tagId;
     if(!view.tags.some(t=>t.tagId===id))throw new DomainError(404,'TAG_NOT_FOUND');
     names=view.tags.flatMap(t=>t.tagId!==id?[t.displayName as string]:change.rename?[change.rename.name]:[]);
    }
    if(change.suggestionId){
     const suggestion=(await tx.query("SELECT * FROM note_tag_suggestions WHERE suggestion_id=$1 AND note_id=$2 AND workspace_id=$3 FOR UPDATE",[change.suggestionId,noteId,wid])).rows[0];
     if(!suggestion)throw new DomainError(404,'TAG_SUGGESTION_NOT_FOUND');
     if(suggestion.status!=='pending'||suggestion.note_revision_id!==n.note_revision_id||Number(suggestion.expected_tag_set_version)!==Number(n.tag_set_version))throw new DomainError(409,'TAG_SUGGESTION_STALE');
     names=suggestion.labels;
    }
    await this.applyTagSetTx(tx,wid,noteId,names);
    if(change.suggestionId)await tx.query("UPDATE note_tag_suggestions SET status='applied',applied_at=now() WHERE suggestion_id=$1",[change.suggestionId]);
    return this.tagDto(tx,wid,noteId);
   });
  });
 }
 async replaceNoteTags(scope:Scope,wid:string,noteId:string,names:string[],ifMatch:string,key:string){return this.mutateTags(scope,wid,noteId,{replace:names},ifMatch,key);}
 async addNoteTag(scope:Scope,wid:string,noteId:string,name:string,ifMatch:string,key:string){return this.mutateTags(scope,wid,noteId,{add:name},ifMatch,key);}
 async removeNoteTag(scope:Scope,wid:string,noteId:string,tagId:string,ifMatch:string,key:string){return this.mutateTags(scope,wid,noteId,{remove:tagId},ifMatch,key);}
 async renameNoteTag(scope:Scope,wid:string,noteId:string,tagId:string,name:string,ifMatch:string,key:string){return this.mutateTags(scope,wid,noteId,{rename:{tagId,name}},ifMatch,key);}
 async applyTagSuggestion(scope:Scope,wid:string,noteId:string,suggestionId:string,ifMatch:string,key:string){return this.mutateTags(scope,wid,noteId,{suggestionId},ifMatch,key);}
 async requestTagExtraction(scope:Scope,wid:string,noteId:string,key:string){return transaction(this.pool,async tx=>{
  await assertScope(tx,scope);await this.workspace(tx,scope,wid);
  return idempotent(tx,this.secret,`${scope.userId}:${wid}`,'note.tags.extract',key,{noteId},async()=>{
   const n=(await tx.query("SELECT * FROM notes WHERE note_id=$1 AND workspace_id=$2 AND state='active' FOR UPDATE",[noteId,wid])).rows[0];
   if(!n)throw new DomainError(404,'NOTE_NOT_FOUND');
   if(this.config?.tagExtractorProvider==='disabled')throw new DomainError(503,'TAG_PROVIDER_UNAVAILABLE');
   return {taskId:await this.task(tx,scope,wid,noteId,n.note_revision_id)};
  });
 });}
 async importNote(scope:Scope,wid:string,input:{title:string;mimeType:string;content:string;folderId?:string|null;sourceUrl?:string;resourceRefs?:Array<{resourceId:string;usage:string}>},key:string){
  if(!['text/plain','text/markdown'].includes(input.mimeType))throw new DomainError(400,'IMPORT_CONTENT_TYPE_UNSUPPORTED');
  if(typeof input.content!=='string'||!input.content.trim())throw new DomainError(400,'IMPORT_CONTENT_INVALID');
  checkNoteParts({raw:input.content},'input');
  const note=await this.createNote(scope,wid,{title:input.title,folderId:input.folderId,sourceKind:'import',sourceId:input.sourceUrl,resourceRefs:input.resourceRefs,processingStatus:'ready',parts:{raw:input.content,outline:'',germination:''}},key);
  return {status:'ready' as const,note};
 }
 async createNote(scope:Scope,wid:string,input:{title:string;folderId?:string|null;parts:Record<string,string>;resourceRefs?:NoteResourceRef[];sourceKind?:string;sourceId?:string;processingStatus?:'ready'|'needs-processing'},key:string){return transaction(this.pool,async tx=>{
  await assertScope(tx,scope);await this.workspace(tx,scope,wid);await this.lockTree(tx,wid,true);
  checkNoteParts(input.parts,'input');
  await this.resourceClaims?.ensure(tx,scope,wid,(input.resourceRefs??[]).filter(ref=>ref.usage!=='inline-image').map(ref=>ref.resourceId));
  const prepared=await normalizeOwnedImageParts(tx,scope,wid,input.parts,this.config,this.resourceClaims);
  const normalized={...input,parts:prepared.parts,imageOrigins:prepared.imageOrigins};
  return idempotent(tx,this.secret,`${scope.userId}:${wid}`,'note.create',key,normalized,async()=>{
   const canonicalParts=restoreOwnedImageParts({},prepared);
   checkNoteParts(canonicalParts,'create');
   if(input.folderId){const f=await tx.query("SELECT 1 FROM asset_folders WHERE folder_id=$1 AND workspace_id=$2 AND state='active' FOR SHARE",[input.folderId,wid]);if(!f.rowCount)throw new DomainError(404,'FOLDER_NOT_FOUND');}
   const id=randomUUID(),rid=randomUUID();
   await tx.query('INSERT INTO notes(note_id,workspace_id,folder_id,title,source_kind,source_id,note_revision_id,etag) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,wid,input.folderId??null,input.title.trim(),input.sourceKind??'manual',input.sourceId??null,rid,etag(id,1)]);
   await tx.query('UPDATE notes SET processing_status=$2 WHERE note_id=$1',[id,input.processingStatus??(input.parts.raw?.trim()?'ready':'needs-processing')]);
   await syncNoteRefs(tx,scope,wid,id,canonicalParts,input.resourceRefs);
   for(const part of parts){
    const text=canonicalParts[part]??'',partRevisionId=randomUUID();
    await tx.query('INSERT INTO note_parts(part_revision_id,note_id,part,revision,content_markdown,content_sha256) VALUES($1,$2,$3,1,$4,$5)',[partRevisionId,id,part,text,sha(text)]);
   }
   await this.cursor(tx,wid,'note',id,'created',false,rid,1,null,null);
   if(this.config?.tagExtractorProvider!=='disabled')await this.task(tx,scope,wid,id,rid);
   await this.indexNote(tx,scope,wid,id);
   return this.noteDto(tx,wid,id);
  });
 });}
 async updateNote(scope:Scope,wid:string,id:string,input:{title?:string;folderId?:string|null;parts?:Record<string,string>;resourceRefs?:NoteResourceRef[]},ifMatch:string,key:string){
  return transaction(this.pool,async tx=>{
   await assertScope(tx,scope);await this.workspace(tx,scope,wid);await this.lockTree(tx,wid,true);
   checkNoteParts(input.parts??{},'input');
   // Existing image pins can survive a partial body edit. Serialize their writes
   // before the note row, just like new upload claims; title-only edits need neither.
   const updatesRefs=input.parts!==undefined||input.resourceRefs!==undefined;
   if(this.resourceClaims&&updatesRefs&&(await tx.query('SELECT 1 FROM note_resource_refs r JOIN notes n ON n.note_id=r.note_id WHERE r.note_id=$1 AND n.workspace_id=$2 LIMIT 1',[id,wid])).rowCount)await this.resourceClaims.lockAccount(tx,scope);
   await this.resourceClaims?.ensure(tx,scope,wid,(input.resourceRefs??[]).filter(ref=>ref.usage!=='inline-image').map(ref=>ref.resourceId));
   // Normalize before the idempotency digest and before comparing revisions.
   const prepared=await normalizeOwnedImageParts(tx,scope,wid,input.parts??{},this.config,this.resourceClaims);
   const normalized={...input,...(input.parts?{parts:prepared.parts}:{}),imageOrigins:prepared.imageOrigins};
   return idempotent(tx,this.secret,`${scope.userId}:${wid}`,'note.update',key,{id,input:normalized,ifMatch},async()=>{
    const n=(await tx.query('SELECT * FROM notes WHERE note_id=$1 AND workspace_id=$2 FOR UPDATE',[id,wid])).rows[0];
    if(!n||n.state!=='active')throw new DomainError(404,'NOTE_NOT_FOUND');
    if(n.etag!==ifMatch)throw new DomainError(412,'NOTE_REVISION_MISMATCH');
    if(input.folderId){const f=await tx.query("SELECT 1 FROM asset_folders WHERE folder_id=$1 AND workspace_id=$2 AND state='active' FOR SHARE",[input.folderId,wid]);if(!f.rowCount)throw new DomainError(404,'FOLDER_NOT_FOUND');}
    const previous=(await tx.query<{part:string;part_revision_id:string;revision:number;content_markdown:string}>('SELECT part,part_revision_id,revision,content_markdown FROM note_parts WHERE note_id=$1',[id])).rows;
    const complete=Object.fromEntries(previous.map(p=>[p.part,p.content_markdown]));
    const canonicalParts=restoreOwnedImageParts(complete,prepared);
    checkNoteParts(canonicalParts);
    const changed=Object.entries(canonicalParts).filter(([part,text])=>complete[part]!==text);
    Object.assign(complete,canonicalParts);
    const refsChanged=updatesRefs?await syncNoteRefs(tx,scope,wid,id,complete,input.resourceRefs):false;
    const title=input.title?.trim()??n.title,folderId=input.folderId===undefined?n.folder_id:input.folderId;
    if(!changed.length&&!refsChanged&&title===n.title&&folderId===n.folder_id)return this.noteDto(tx,wid,id);
    const v=Number(n.note_revision)+1,rid=randomUUID();
    await tx.query('UPDATE notes SET title=$2,folder_id=$3,note_revision=$4,note_revision_id=$5,etag=$6,updated_at=now() WHERE note_id=$1',[id,title,folderId,v,rid,etag(id,v)]);
    for(const [part,text] of changed){
     const revision=Number(previous.find(p=>p.part===part)?.revision??0)+1,partRevisionId=randomUUID();
     await tx.query('INSERT INTO note_parts(part_revision_id,note_id,part,revision,content_markdown,content_sha256) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(note_id,part) DO UPDATE SET part_revision_id=EXCLUDED.part_revision_id,revision=EXCLUDED.revision,content_markdown=EXCLUDED.content_markdown,content_sha256=EXCLUDED.content_sha256,updated_at=now()',[partRevisionId,id,part,revision,text,sha(text)]);
     }
    const rawChanged=changed.some(([part])=>part==='raw');
    if(rawChanged)await tx.query('UPDATE notes SET processing_status=$2 WHERE note_id=$1',[id,complete.raw?.trim()?'ready':'needs-processing']);
    await this.cursor(tx,wid,'note',id,'updated',false,rid,v,n.note_revision_id,Number(n.note_revision));
    if(this.config?.tagExtractorProvider!=='disabled')await this.task(tx,scope,wid,id,rid);
    if(rawChanged)await this.indexNote(tx,scope,wid,id);
    return this.noteDto(tx,wid,id);
   });
  });
 }
 async putNotePart(scope:Scope,wid:string,id:string,part:string,markdown:string,ifMatch:string,key:string){checkPart(part);return this.updateNote(scope,wid,id,{parts:{[part]:markdown}},ifMatch,key);}
 async batchMove(scope:Scope,wid:string,folderId:string|null,notes:Array<{noteId:string;etag:string}>,key:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);await this.workspace(tx,scope,wid);await this.lockTree(tx,wid,true);return idempotent(tx,this.secret,`${scope.userId}:${wid}`,'note.batch-move',key,{folderId,notes},async()=>{if(folderId){const f=await tx.query("SELECT 1 FROM asset_folders WHERE folder_id=$1 AND workspace_id=$2 AND state='active'",[folderId,wid]);if(!f.rowCount)throw new DomainError(404,'FOLDER_NOT_FOUND');}const receipts=[];for(const item of notes){const n=(await tx.query('SELECT * FROM notes WHERE note_id=$1 AND workspace_id=$2 FOR UPDATE',[item.noteId,wid])).rows[0];if(!n||n.state!=='active') {receipts.push({noteId:item.noteId,status:'not_found'});continue;}if(n.etag!==item.etag){receipts.push({noteId:item.noteId,status:'conflict'});continue;}const v=Number(n.note_revision)+1,rid=randomUUID();await tx.query('UPDATE notes SET folder_id=$2,note_revision=$3,note_revision_id=$4,etag=$5,updated_at=now() WHERE note_id=$1',[item.noteId,folderId,v,rid,etag(item.noteId,v)]);await this.cursor(tx,wid,'note',item.noteId,'moved',false,rid,v,n.note_revision_id,Number(n.note_revision));receipts.push({noteId:item.noteId,status:'moved',etag:etag(item.noteId,v)});}return {notes:receipts};});});}
 async notePart(scope:Scope,wid:string,id:string,part:string){checkPart(part);return transaction(this.pool,async tx=>{await assertScope(tx,scope);await this.workspace(tx,scope,wid);
  const note=(await tx.query("SELECT etag FROM notes WHERE note_id=$1 AND workspace_id=$2 AND state='active' FOR SHARE",[id,wid])).rows[0];if(!note)throw new DomainError(404,'NOTE_NOT_FOUND');
  const row=(await tx.query('SELECT * FROM note_parts WHERE note_id=$1 AND part=$2',[id,part])).rows[0];if(!row)throw new DomainError(404,'NOTE_PART_NOT_FOUND');
  return {noteId:id,part,partRevisionId:row.part_revision_id,contentMarkdown:row.content_markdown,contentSha256:row.content_sha256,etag:note.etag};
 });}
 private async transitionNote(tx:pg.PoolClient,scope:Scope,wid:string,n:NoteStateRow,restore:boolean,deletedByFolder:string|null){
  const id=n.note_id,version=Number(n.note_revision)+1,revisionId=randomUUID();
  await tx.query('UPDATE notes SET state=$2,note_revision=$3,note_revision_id=$4,etag=$5,deleted_by_folder_id=$6,updated_at=now() WHERE note_id=$1',[id,restore?'active':'deleted',version,revisionId,etag(id,version),deletedByFolder]);
  if(restore){await this.indexNote(tx,scope,wid,id);}
  else if((await tx.query('SELECT 1 FROM kb_note_hybrid_builds WHERE source_id=$1 LIMIT 1',[id])).rowCount){
   const taskId=randomUUID(),inputId=randomUUID();
   await tx.query('INSERT INTO task_inputs(id,user_id,workspace_id,body) VALUES($1,$2,$3,$4)',[inputId,scope.userId,wid,JSON.stringify({noteId:id})]);
   await tx.query("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,input_id,state,trace_id,max_attempts) VALUES($1,$2,$3,'kb.note-cleanup','content',$4,'queued',$5,$6)",[taskId,scope.userId,wid,inputId,resolveTraceId(scope.traceId),newTaskMaxAttempts()]);
   await enqueueIntent(tx,taskId);await event(tx,taskId);
  }
  return this.cursor(tx,wid,'note',id,restore?'restored':'deleted',!restore,revisionId,version,n.note_revision_id,Number(n.note_revision));
 }
 async deleteNote(scope:Scope,wid:string,id:string,ifMatch:string,key:string,restore=false){
  return transaction(this.pool,async tx=>{
   await assertScope(tx,scope);await this.workspace(tx,scope,wid);await this.lockTree(tx,wid,true);
   return idempotent(tx,this.secret,`${scope.userId}:${wid}`,restore?'note.restore':'note.delete',key,{id,ifMatch},async()=>{
    const note=(await tx.query<NoteStateRow>('SELECT * FROM notes WHERE note_id=$1 AND workspace_id=$2 FOR UPDATE',[id,wid])).rows[0];
    if(!note)throw new DomainError(404,'NOTE_NOT_FOUND');
    if(note.etag!==ifMatch)throw new DomainError(412,'NOTE_REVISION_MISMATCH');
    if(restore&&note.folder_id&&!(await tx.query("SELECT 1 FROM asset_folders WHERE folder_id=$1 AND workspace_id=$2 AND state='active' FOR SHARE",[note.folder_id,wid])).rowCount)throw new DomainError(409,'PARENT_FOLDER_DELETED');
    return this.transitionNote(tx,scope,wid,note,restore,null);
   });
  });
 }

 async search(scope:Scope,wid:string,input:{query:string;mode?:string;ownerKinds?:string[];noteParts?:string[];folderIds?:string[];tagIds?:string[];sourceKinds?:string[];noteTypeIds?:string[];from?:string;to?:string;limit?:number}){
  await transaction(this.pool,async tx=>{await assertScope(tx,scope);await this.workspace(tx,scope,wid);});
  if(input.mode&&!['keyword','hybrid'].includes(input.mode))throw new DomainError(400,'SEARCH_MODE_INVALID');
  if(input.noteParts?.some(p=>!['raw','outline','germination'].includes(p)))throw new DomainError(400,'NOTE_PART_INVALID');
  if(input.noteTypeIds?.length)throw new DomainError(400,'SEARCH_NOTE_TYPE_UNSUPPORTED');
  for(const date of [input.from,input.to])if(date&&!Number.isFinite(Date.parse(date)))throw new DomainError(400,'SEARCH_DATE_INVALID');
  if(input.from&&input.to&&Date.parse(input.from)>Date.parse(input.to))throw new DomainError(400,'SEARCH_DATE_INVALID');
  const mode=input.mode==='hybrid'?'hybrid':'keyword';
  if(!input.query.trim())throw new DomainError(400,'SEARCH_QUERY_EMPTY');
  if(!this.ragQuery)throw new DomainError(503,'RAG_SEARCH_UNAVAILABLE');
  const result=(input.ownerKinds?.length&&!input.ownerKinds.includes('hnote'))||(input.noteParts?.length&&!input.noteParts.includes('raw'))?{results:[]}:await this.ragQuery.query(scope,{query:input.query,mode,sourceType:'note',workspaceId:wid,topK:Math.min(30,input.limit??20),filters:input});
  const ids=[...new Set(result.results.map(r=>String(r.documentKey)))];
  const notes=await transaction(this.pool,async tx=>{await assertScope(tx,scope);return (await tx.query("SELECT note_id,title,updated_at FROM notes WHERE note_id=ANY($1::uuid[]) AND workspace_id=$2 AND state='active'",[ids,wid])).rows;});
  const results=notes.flatMap(n=>{const hit=result.results.find(r=>r.documentKey===n.note_id);return hit?[{ownerRef:{workspaceId:wid,kind:'hnote',id:n.note_id},revisionId:hit.revisionId,part:'raw',path:`notes/${n.note_id}.md`,title:n.title,updatedAt:n.updated_at.toISOString(),matchMode:mode,score:Number(hit.rerankScore??(mode==='hybrid'?hit.rrfScore:hit.keywordScore)),staleSource:false}]:[];});
  return {mode,queryFingerprint:sha(`${wid}:${normalize(input.query)}`),keywordReadiness:'current',vectorReadiness:mode==='hybrid'?'current':'unavailable',vectorStatus:mode==='hybrid'?'ready':'unavailable',contentCursor:String((await this.pool.query('SELECT next_cursor FROM workspace_content_state WHERE workspace_id=$1',[wid])).rows[0]?.next_cursor??0),results};
 }
 async createRelation(scope:Scope,wid:string,id:string,input:{targetNoteId:string;relationType:string;rationale:string},key:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);await this.workspace(tx,scope,wid);return idempotent(tx,this.secret,`${scope.userId}:${wid}`,'note.relation.create',key,{id,...input},async()=>{if(!['references','supports','contradicts','related'].includes(input.relationType)||input.targetNoteId===id)throw new DomainError(400,'RELATION_INVALID');const ok=await tx.query("SELECT note_id FROM notes WHERE note_id=ANY($1::uuid[]) AND workspace_id=$2 AND state='active'",[[id,input.targetNoteId],wid]);if(ok.rowCount!==2)throw new DomainError(404,'NOTE_NOT_FOUND');const rid=randomUUID();await tx.query('INSERT INTO note_relations(relation_id,workspace_id,source_note_id,target_note_id,relation_type,rationale,etag) VALUES($1,$2,$3,$4,$5,$6,$7)',[rid,wid,id,input.targetNoteId,input.relationType,input.rationale,`"relation-${rid}-1"`]);return {relationId:rid,relationType:input.relationType,origin:'explicit',source:{noteId:id,part:'raw'},target:{noteId:input.targetNoteId,part:'raw'},rationale:input.rationale,version:1,etag:`"relation-${rid}-1"`};});});}
 async deleteRelation(scope:Scope,wid:string,rid:string,ifMatch:string,key:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);await this.workspace(tx,scope,wid);return idempotent(tx,this.secret,`${scope.userId}:${wid}`,'note.relation.delete',key,{rid,ifMatch},async()=>{const r=await tx.query('DELETE FROM note_relations WHERE relation_id=$1 AND workspace_id=$2 AND etag=$3 RETURNING relation_id,source_note_id,target_note_id',[rid,wid,ifMatch]);if(!r.rowCount)throw new DomainError(412,'RELATION_REVISION_MISMATCH');return {eventId:randomUUID(),workspaceId:wid,cursor:String((await tx.query('SELECT coalesce(next_cursor,0) c FROM workspace_content_state WHERE workspace_id=$1',[wid])).rows[0]?.c??0),operationId:randomUUID(),occurredAt:new Date().toISOString(),objectKind:'note_relation',objectId:rid,changeType:'deleted',tombstone:true,resourcePinDelta:{added:[],released:[]}};});});}
 async navigation(scope:Scope,wid:string,map:string,input:GraphQuery={}){return transaction(this.pool,async tx=>{
  await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await assertScope(tx,scope);await this.workspace(tx,scope,wid);
  return tagGraph(tx,wid,map,input);
 });}
 async noteRelations(scope:Scope,wid:string,id:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);await this.workspace(tx,scope,wid);const r=await tx.query('SELECT * FROM note_relations WHERE workspace_id=$1 AND (source_note_id=$2 OR target_note_id=$2) ORDER BY created_at',[wid,id]);return {items:r.rows.map(x=>({relationId:x.relation_id,relationType:x.relation_type,origin:x.origin,source:{noteId:x.source_note_id,part:'raw'},target:{noteId:x.target_note_id,part:'raw'},rationale:x.rationale,version:x.version,etag:x.etag}))};});}
}
