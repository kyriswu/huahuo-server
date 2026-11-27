import { importLink } from './link-import.js';
import type { LinkExtractor } from '../../lib/link-extraction/index.js';
import {inferAssetKind} from './asset-kind.js';
import type { AssetKind } from '../../contracts/asset-kind.js';
import type { ContentStatus } from '../../contracts/content-status.js';
import { idempotent } from '../../lib/idempotency.js';
import {resolveTraceId} from '../../lib/trace.js';
import {tagGraph,type GraphQuery} from './tag-graph.js';
import type pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, assertScope, transaction, type Scope } from '../identity/store.js';
import { enqueueIntent, event, newTaskMaxAttempts } from '../tasks/model.js';
import type { AppConfig } from '../../config/config.js';
import { RagQueryService } from '../rag/query-service.js';
import { ContentAssetIndexService } from '../ingestion/service.js';
import { normalizeOwnedImageParts, restoreOwnedImageParts } from '../storage/image-content.js';
import { syncContentAssetRefs, type ContentAssetResourceRef } from './content-asset-images.js';
import { EDITABLE_MARKDOWN_MAX_CHARS } from '../../lib/kb-image-markdown.js';
import { listContentAssetPage } from './content-asset-list.js';
import type { ResourceClaims } from '../storage/resource-claims.js';
import { findAudioTranscript, readAudioTranscriptText } from '../funasr/transcript-data.js';
export const ASSET_TAG_PAGE_SIZE = 20;
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const normalize=(v:string)=>v.trim().normalize('NFKC').toLocaleLowerCase();
const etag=(id:string,version:number)=>`"content-asset-${id}-${version}"`;
const folderEtag=(id:string,version:number)=>`"folder-${id}-${version}"`;
interface ContentAssetStateRow {
 content_asset_id: string;
 content_asset_revision: string;
 content_asset_revision_id: string;
 etag: string;
 state: 'active' | 'deleted';
}
interface ContentAssetRow extends ContentAssetStateRow {
 folder_id: string | null;
 title: string;
 asset_kind: AssetKind;
 source_kind: string;
 source_id: string | null;
 tag_set_version: string;
 tag_manual_override: boolean;
 processing_status: ContentStatus;
 created_at: Date;
 updated_at: Date;
}
export interface AudioTranscriptionInput {
 assetId: string;
 resourceId: string;
 rawRevisionId: string;
}
export interface AudioTranscriptionQueue {
 enqueue(tx: pg.PoolClient, scope: Scope, input: AudioTranscriptionInput): Promise<void>;
}
export async function originalAudioResource(tx: pg.PoolClient, userId: string, assetId: string) {
 const { rows } = await tx.query<{ resource_id: string }>(`SELECT DISTINCT r.resource_id
  FROM content_asset_resource_refs ref JOIN resources r ON r.resource_id=ref.resource_id
  WHERE ref.content_asset_id=$1 AND ref.usage='original' AND r.user_id=$2
   AND r.status='ready' AND r.mime_type LIKE 'audio/%' LIMIT 2`, [assetId, userId]);
 return rows.length === 1 ? rows[0]!.resource_id : undefined;
}
interface FolderRow {
 folder_id: string;
 user_id: string;
 parent_folder_id: string | null;
 display_name: string;
 normalized_name: string;
 state: 'active' | 'deleted';
 current_revision_id: string;
 revision: string;
}
interface FolderStateRow extends FolderRow {
 deleted_by_folder_id: string | null;
}
function toFolderDto(folder: FolderRow, contentCursor: string) {
 return {
  folderId: folder.folder_id,
  parentFolderId: folder.parent_folder_id,
  displayName: folder.display_name,
  normalizedName: folder.normalized_name,
  state: folder.state,
  currentRevisionId: folder.current_revision_id,
  etag: folderEtag(folder.folder_id, Number(folder.revision)),
  contentCursor,
 };
}
const parts=['raw','outline','germination'] as const; type Part=typeof parts[number];
function checkPart(part:string):asserts part is Part{if(!parts.includes(part as Part))throw new DomainError(400,'CONTENT_ASSET_PART_INVALID');}
function checkContentAssetParts(values:Record<string,string>,mode:'create'|'update'|'input'='update'):void{
 for(const [part,text] of Object.entries(values)){
  checkPart(part);const limit=mode==='input'?EDITABLE_MARKDOWN_MAX_CHARS:mode==='create'&&part!=='raw'?200000:500000;
  if(text.length<=limit)continue;
  let chars=0;
  for(let offset=0;offset<text.length;offset+=text.codePointAt(offset)!>0xffff?2:1)
   if(++chars>limit)throw new DomainError(400,'CONTENT_ASSET_CONTENT_TOO_LARGE');
 }
}
type CreateAssetInput = {title:string;folderId?:string|null;parts:Record<string,string>;resourceRefs?:ContentAssetResourceRef[];assetKind?:AssetKind;sourceKind?:string;sourceId?:string;processingStatus?:'ready'};

export class ContentAssetService {
 constructor(readonly pool:pg.Pool,readonly secret:string,readonly config?:AppConfig,private readonly ragQuery?:RagQueryService,
  private readonly resourceClaims?:ResourceClaims,private readonly audioTranscription?:AudioTranscriptionQueue){}
 private async indexContentAsset(tx:pg.PoolClient,scope:Scope,contentAssetId:string){if(this.config?.kb.contentAssetEnabled)await new ContentAssetIndexService(this.pool,this.config).schedule(tx,scope,contentAssetId);}
 // Serialize placements with folder tree changes. ContentAsset mutations may share the
 // fence so independent account/resource and contentAsset row locks retain their order.
 private async lockTree(tx:pg.PoolClient,userId:string,shared=false){await tx.query(`SELECT ${shared?'pg_advisory_xact_lock_shared':'pg_advisory_xact_lock'}(hashtextextended($1,0))`,[`asset-tree:${userId}`]);}
 private async findContentAsset(tx: pg.PoolClient, scope: Pick<Scope,'userId'>, contentAssetId: string,
  lock: '' | 'FOR SHARE OF asset' | 'FOR UPDATE OF asset' = '') {
  const { rows: [contentAsset] } = await tx.query<ContentAssetRow>(
   `SELECT asset.* FROM content_assets asset
    WHERE asset.content_asset_id=$1 AND asset.user_id=$2 ${lock}`,
   [contentAssetId, scope.userId],
  );
  return contentAsset;
 }
 private async assertActiveFolder(tx: pg.PoolClient, userId: string, folderId: string | null) {
  if (folderId === null) return;
  const result = await tx.query(
   "SELECT 1 FROM asset_folders WHERE folder_id=$1 AND user_id=$2 AND state='active' FOR SHARE",
   [folderId, userId],
  );
  if (!result.rowCount) throw new DomainError(404, 'FOLDER_NOT_FOUND');
 }
 private async cursor(tx:pg.PoolClient, userId: string,kind:string,id:string,change:string,tombstone:boolean,revisionId:string|null,version:number|null,previousRevisionId:string|null,previousVersion:number|null){await tx.query('INSERT INTO account_content_state(user_id) VALUES($1) ON CONFLICT DO NOTHING',[userId]);const c=await tx.query<{next_cursor:string}>("UPDATE account_content_state SET next_cursor=next_cursor+1,updated_at=now() WHERE user_id=$1 RETURNING next_cursor",[userId]);const cursor=String(c.rows[0]!.next_cursor),eventId=randomUUID(),operationId=randomUUID();await tx.query('INSERT INTO content_events(event_id,user_id,cursor,operation_id,object_kind,object_id,change_type,tombstone,revision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[eventId,userId,cursor,operationId,kind,id,change,tombstone,revisionId]);return {eventId,cursor,operationId,occurredAt:new Date().toISOString(),objectKind:kind,objectId:id,changeType:change,tombstone,resourcePinDelta:{added:[],released:[]},...(revisionId?{revisionId}:{}) ,...(previousRevisionId?{previousRevisionId}:{}),...(version!==null?{version}:{}) ,...(previousVersion!==null?{previousVersion}:{})};}
 private async contentAssetDto(tx: pg.PoolClient, scope: Scope, contentAssetId: string, lockedAsset?: ContentAssetRow) {
  const contentAsset = lockedAsset ?? await this.findContentAsset(tx, scope, contentAssetId);
  if (!contentAsset) throw new DomainError(404, 'CONTENT_ASSET_NOT_FOUND');
  const folder = contentAsset.folder_id === null ? undefined : (await tx.query<{ folder_id: string }>(
   "SELECT folder_id FROM asset_folders WHERE folder_id=$1 AND user_id=$2 AND state='active'",
   [contentAsset.folder_id, scope.userId],
  )).rows[0];
  const savedParts = await tx.query(
   'SELECT part,part_revision_id,content_markdown,content_sha256 FROM content_asset_parts WHERE content_asset_id=$1', [contentAssetId],
  );
  const currentParts = new Map(savedParts.rows.map(part => [part.part, part]));
  const refs = await tx.query<{resource_id:string;sha256:string|null;mime_type:string;ref_order:number;usage:string;anchor:string|null;alt:string|null}>(
   `SELECT r.resource_id,r.sha256,r.mime_type,ref.ref_order,ref.usage,ref.anchor,ref.alt
    FROM content_asset_resource_refs ref JOIN resources r ON r.resource_id=ref.resource_id AND r.user_id=$2
    WHERE ref.content_asset_id=$1 ORDER BY ref.ref_order`, [contentAssetId, scope.userId],
  );
  const { rows: [cursor] } = await tx.query<{ next_cursor: string }>(
   'SELECT next_cursor FROM account_content_state WHERE user_id=$1', [scope.userId],
  );
  return {
   contentAssetId: contentAsset.content_asset_id, folderId: folder?.folder_id ?? null, title: contentAsset.title, state: contentAsset.state,
   contentAssetRevisionId: contentAsset.content_asset_revision_id,
   parts: Object.fromEntries(parts.map(part => {
    const saved = currentParts.get(part);
    return [part, saved
     ? { partRevisionId: saved.part_revision_id, contentMarkdown: saved.content_markdown, contentSha256: saved.content_sha256 }
     : { partRevisionId: `absent-${contentAssetId}-${part}`, contentMarkdown: '', contentSha256: sha('') }];
   })),
   resourceRefs: refs.rows.map(ref => ({
    resourceId: ref.resource_id, order: ref.ref_order, usage: ref.usage, anchor: ref.anchor, alt: ref.alt,
    sha256: ref.sha256, mimeType: ref.mime_type,
   })),
   etag: contentAsset.etag, contentCursor: String(cursor?.next_cursor ?? 0), sourceKind: contentAsset.source_kind,
   sourceRef: contentAsset.source_id ? { kind: contentAsset.source_kind, id: contentAsset.source_id } : null,
   createdAt: contentAsset.created_at.toISOString(), updatedAt: contentAsset.updated_at.toISOString(),
  };
 }
 private async folderDto(tx: pg.PoolClient, id: string) {
  const { rows: [folder] } = await tx.query<FolderRow>('SELECT * FROM asset_folders WHERE folder_id=$1', [id]);
  if (!folder) throw new DomainError(404, 'FOLDER_NOT_FOUND');
  const { rows: [cursor] } = await tx.query<{ next_cursor: string }>(
   'SELECT next_cursor FROM account_content_state WHERE user_id=$1', [folder.user_id],
  );
  return toFolderDto(folder, String(cursor?.next_cursor ?? 0));
 }
 async getFolder(scope:Scope,id:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);const f=await tx.query('SELECT 1 FROM asset_folders WHERE folder_id=$1 AND user_id=$2',[id,scope.userId]);if(!f.rowCount)throw new DomainError(404,'FOLDER_NOT_FOUND');return this.folderDto(tx,id);});}
 async listFolders(scope: Scope) {
  return transaction(this.pool, async tx => {
   await assertScope(tx, scope);
   const { rows } = await tx.query<FolderRow & { content_cursor: string }>(
    `SELECT folder.*, coalesce(account.next_cursor, 0)::text AS content_cursor
     FROM asset_folders folder
     LEFT JOIN account_content_state account ON account.user_id=folder.user_id
     WHERE folder.user_id=$1
     ORDER BY folder.parent_folder_id NULLS FIRST, folder.normalized_name, folder.folder_id`,
    [scope.userId],
   );
   return { folders: rows.map(folder => toFolderDto(folder, folder.content_cursor)) };
  });
 }
 async createFolder(scope:Scope,input:{displayName:string;parentFolderId?:string|null},key:string){if(!input.displayName.trim())throw new DomainError(400,'FOLDER_NAME_INVALID');return transaction(this.pool,async tx=>{await assertScope(tx,scope);await this.lockTree(tx,scope.userId);return idempotent(tx,this.secret,scope.userId,'folder.create',key,input,async()=>{if(input.parentFolderId){const p=await tx.query("SELECT 1 FROM asset_folders WHERE folder_id=$1 AND user_id=$2 AND state='active'",[input.parentFolderId,scope.userId]);if(!p.rowCount)throw new DomainError(404,'PARENT_FOLDER_NOT_FOUND');}const id=randomUUID(),rev=randomUUID();try{await tx.query('INSERT INTO asset_folders(folder_id,user_id,parent_folder_id,display_name,normalized_name,current_revision_id) VALUES($1,$2,$3,$4,$5,$6)',[id,scope.userId,input.parentFolderId??null,input.displayName.trim(),normalize(input.displayName),rev]);}catch(e){if((e as {code?:string}).code==='23505')throw new DomainError(409,'FOLDER_NAME_CONFLICT');throw e;}await this.cursor(tx,scope.userId,'folder',id,'created',false,rev,1,null,null);return this.folderDto(tx,id);});});}
 async updateFolder(scope:Scope,id:string,displayName:string,ifMatch:string,key:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);await this.lockTree(tx,scope.userId);return idempotent(tx,this.secret,scope.userId,'folder.update',key,{id,displayName,ifMatch},async()=>{const f=(await tx.query('SELECT * FROM asset_folders WHERE folder_id=$1 AND user_id=$2 AND state=\'active\' FOR UPDATE',[id,scope.userId])).rows[0];if(!f)throw new DomainError(404,'FOLDER_NOT_FOUND');if(folderEtag(id,Number(f.revision))!==ifMatch)throw new DomainError(412,'FOLDER_REVISION_MISMATCH');const rev=randomUUID(),v=Number(f.revision)+1;await tx.query('UPDATE asset_folders SET display_name=$2,normalized_name=$3,current_revision_id=$4,revision=$5,updated_at=now() WHERE folder_id=$1',[id,displayName.trim(),normalize(displayName),rev,v]);await this.cursor(tx,scope.userId,'folder',id,'updated',false,rev,v,f.current_revision_id,Number(f.revision));return this.folderDto(tx,id);});});}
 private async assertNoCycle(tx:pg.PoolClient,userId:string,id:string,parent:string|null){if(!parent)return;const r=await tx.query(`WITH RECURSIVE chain(id) AS (SELECT $1::uuid UNION ALL SELECT parent_folder_id FROM asset_folders f JOIN chain c ON f.folder_id=c.id WHERE f.parent_folder_id IS NOT NULL) SELECT 1 FROM chain WHERE id=$2 LIMIT 1`,[parent,id]);if(r.rowCount)throw new DomainError(409,'FOLDER_CYCLE');const p=await tx.query("SELECT 1 FROM asset_folders WHERE folder_id=$1 AND user_id=$2 AND state='active'",[parent,userId]);if(!p.rowCount)throw new DomainError(404,'PARENT_FOLDER_NOT_FOUND');}
 async moveFolder(scope:Scope,id:string,parent:string|null,ifMatch:string,key:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);await this.lockTree(tx,scope.userId);return idempotent(tx,this.secret,scope.userId,'folder.move',key,{id,parent,ifMatch},async()=>{const f=(await tx.query('SELECT * FROM asset_folders WHERE folder_id=$1 AND user_id=$2 AND state=\'active\' FOR UPDATE',[id,scope.userId])).rows[0];if(!f)throw new DomainError(404,'FOLDER_NOT_FOUND');if(folderEtag(id,Number(f.revision))!==ifMatch)throw new DomainError(412,'FOLDER_REVISION_MISMATCH');await this.assertNoCycle(tx,scope.userId,id,parent);const rev=randomUUID(),v=Number(f.revision)+1;await tx.query('UPDATE asset_folders SET parent_folder_id=$2,current_revision_id=$3,revision=$4,updated_at=now() WHERE folder_id=$1',[id,parent,rev,v]);return this.cursor(tx,scope.userId,'folder',id,'moved',false,rev,v,f.current_revision_id,Number(f.revision));});});}
 async deleteFolder(scope:Scope,id:string,ifMatch:string,key:string,restore=false){
  return transaction(this.pool,async tx=>{
   await assertScope(tx,scope);await this.lockTree(tx,scope.userId);
   return idempotent(tx,this.secret,scope.userId,restore?'folder.restore':'folder.delete',key,{id,ifMatch},async()=>{
    const root=(await tx.query<FolderStateRow>('SELECT * FROM asset_folders WHERE folder_id=$1 AND user_id=$2 FOR UPDATE',[id,scope.userId])).rows[0];
    if(!root)throw new DomainError(404,'FOLDER_NOT_FOUND');
    if(folderEtag(id,Number(root.revision))!==ifMatch)throw new DomainError(412,'FOLDER_REVISION_MISMATCH');
    if(root.state!==(restore?'deleted':'active'))throw new DomainError(409,'FOLDER_STATE_CONFLICT');
    if(restore&&root.parent_folder_id&&!(await tx.query("SELECT 1 FROM asset_folders WHERE folder_id=$1 AND user_id=$2 AND state='active' FOR SHARE",[root.parent_folder_id,scope.userId])).rowCount)throw new DomainError(409,'PARENT_FOLDER_DELETED');
    const folders=(await tx.query<FolderStateRow>(restore?
     `SELECT * FROM asset_folders WHERE user_id=$2 AND state='deleted' AND (folder_id=$1 OR deleted_by_folder_id=$1) ORDER BY folder_id FOR UPDATE`:
     `WITH RECURSIVE tree(id) AS (SELECT $1::uuid UNION SELECT f.folder_id FROM asset_folders f JOIN tree t ON f.parent_folder_id=t.id WHERE f.user_id=$2)
      SELECT f.* FROM asset_folders f JOIN tree t ON t.id=f.folder_id WHERE f.user_id=$2 AND f.state='active' ORDER BY f.folder_id FOR UPDATE OF f`,[id,scope.userId])).rows;
    const state=restore?'active':'deleted';
    const receipts=[];
    for(const folder of folders){
     const revision=Number(folder.revision)+1,revisionId=randomUUID();
     await tx.query('UPDATE asset_folders SET state=$2,deleted_by_folder_id=$3,revision=$4,current_revision_id=$5,updated_at=now() WHERE folder_id=$1',[folder.folder_id,state,restore?null:id,revision,revisionId]);
     receipts.push(await this.cursor(tx,scope.userId,'folder',folder.folder_id,restore?'restored':'deleted',!restore,revisionId,revision,folder.current_revision_id,Number(folder.revision)));
    }
    return {affectedObjectCount:receipts.length,firstContentCursor:receipts[0]!.cursor,contentCursor:receipts.at(-1)!.cursor};
   });
  });
 }

 async listAssetTags(scope: Scope, cursor?: string) {
  return transaction(this.pool, async tx => {
   await assertScope(tx, scope);
   const { rows } = await tx.query<{tagId: string; displayName: string; normalizedName: string}>(
    `SELECT tag_id AS "tagId", display_name AS "displayName", normalized_name AS "normalizedName"
     FROM asset_tags WHERE user_id = $1 AND normalized_name > $2
     ORDER BY normalized_name LIMIT $3`,
    [scope.userId, cursor ?? '', ASSET_TAG_PAGE_SIZE + 1],
   );
   const items = rows.slice(0, ASSET_TAG_PAGE_SIZE);
   return { items, nextCursor: rows.length > ASSET_TAG_PAGE_SIZE ? items[ASSET_TAG_PAGE_SIZE - 1]!.normalizedName : null };
  });
 }
 async listContentAssets(scope:Scope,cursor?:string,selectedKinds?:AssetKind[]){return transaction(this.pool,async tx=>{await assertScope(tx,scope);return listContentAssetPage(tx,scope.userId,cursor,selectedKinds);});}
 async getContentAsset(scope: Scope, id: string, revisionId?: string) {
  return transaction(this.pool, async tx => {
   await assertScope(tx, scope);

   const contentAsset = await this.findContentAsset(tx, scope, id, 'FOR SHARE OF asset');
   if (!contentAsset) throw new DomainError(404, 'CONTENT_ASSET_NOT_FOUND');
   if (revisionId && (contentAsset.content_asset_revision_id !== revisionId || contentAsset.state !== 'active')) {
    throw new DomainError(409, 'CONTENT_ASSET_REVISION_MISMATCH');
   }
   const resourceId = contentAsset.state === 'active' && contentAsset.asset_kind === 'audio' && contentAsset.processing_status === 'ready'
    ? await originalAudioResource(tx, scope.userId, id) : undefined;
   const ref = resourceId ? await findAudioTranscript(tx, id, scope.userId, resourceId, false) : undefined;
   const audioTranscript = ref ? { transcriptionId: ref.transcriptionId, ...await readAudioTranscriptText(tx, ref) } : undefined;
   return {
    ...await this.contentAssetDto(tx, scope, id, contentAsset),
    assetKind: contentAsset.asset_kind,
    contentStatus: contentAsset.processing_status,
    audioTranscript,
   };
  });
 }
 private async task(tx:pg.PoolClient,scope:Pick<Scope,'userId'|'traceId'>,contentAssetId:string,contentAssetRevisionId:string){
  const tagSetVersion = Number((await this.findContentAsset(tx, scope, contentAssetId))?.tag_set_version ?? 0);
  // task_inputs also contains plain text. Materialize the scoped tag jobs before
  // parsing their JSON so the planner cannot cast an unrelated task's body.
  const existing=(await tx.query(`WITH eligible AS MATERIALIZED (
    SELECT c.task_id,i.body FROM content_jobs c JOIN tasks t ON t.id=c.task_id JOIN task_inputs i ON i.id=t.input_id
    WHERE c.content_asset_id=$1 AND c.content_asset_revision_id=$2 AND c.operation='tag_extract' AND t.kind='content-asset.tag-extract'
      AND t.state IN ('queued','running','retry_scheduled') AND t.user_id=$4 AND t.workspace_id IS NULL
  ) SELECT task_id FROM eligible WHERE (body::jsonb->>'tagSetVersion')::bigint=$3 LIMIT 1`,[contentAssetId,contentAssetRevisionId,tagSetVersion,scope.userId])).rows[0];
  if(existing)return existing.task_id as string;
  const inputId=randomUUID(),taskId=randomUUID();
  await tx.query('INSERT INTO task_inputs(id,user_id,body) VALUES($1,$2,$3)',[inputId,scope.userId,JSON.stringify({contentAssetId,contentAssetRevisionId,tagSetVersion})]);
  await tx.query("INSERT INTO tasks(id,user_id,kind,queue,state,input_id,trace_id,max_attempts) VALUES($1,$2,'content-asset.tag-extract','content','queued',$3,$4,$5)",[taskId,scope.userId,inputId,resolveTraceId(scope.traceId),newTaskMaxAttempts()]);
  await tx.query("INSERT INTO content_jobs(task_id,content_asset_id,content_asset_revision_id,operation) VALUES($1,$2,$3,'tag_extract')",[taskId,contentAssetId,contentAssetRevisionId]);
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
 private async tagDto(tx:pg.PoolClient,scope:Scope,contentAssetId:string){
  const asset=await this.findContentAsset(tx,scope,contentAssetId);
  if(!asset)throw new DomainError(404,'CONTENT_ASSET_NOT_FOUND');
  const tags=await tx.query(`SELECT t.tag_id,t.display_name,t.normalized_name,membership.source FROM content_asset_tags membership JOIN asset_tags t ON t.tag_id=membership.tag_id AND t.user_id=$2 WHERE membership.content_asset_id=$1 ORDER BY t.normalized_name,t.tag_id`,[contentAssetId,scope.userId]);
  const suggestions=await tx.query(`SELECT suggestion_id,content_asset_revision_id,labels,provider,status,created_at FROM content_asset_tag_suggestions WHERE content_asset_id=$1 AND user_id=$2 AND status='pending' AND content_asset_revision_id=$3 AND expected_tag_set_version=$4 ORDER BY created_at DESC LIMIT 10`,[contentAssetId,scope.userId,asset.content_asset_revision_id,asset.tag_set_version]);
  const job=(await tx.query(`SELECT c.task_id,c.outcome,c.provider,t.state,t.error_code FROM content_jobs c JOIN tasks t ON t.id=c.task_id WHERE c.content_asset_id=$1 AND t.user_id=$2 AND t.workspace_id IS NULL ORDER BY t.created_at DESC,t.id DESC LIMIT 1`,[contentAssetId,scope.userId])).rows[0];
  const processingStatus=asset.processing_status==='ready'?'ready':'needs-processing';
  return {contentAssetId,tags:tags.rows.map(x=>({tagId:x.tag_id,displayName:x.display_name,normalizedName:x.normalized_name,source:x.source})),tagSetVersion:Number(asset.tag_set_version),tagEtag:`"tags-${contentAssetId}-${asset.tag_set_version}"`,manualOverride:asset.tag_manual_override,suggestions:suggestions.rows.map(x=>({suggestionId:x.suggestion_id,contentAssetRevisionId:x.content_asset_revision_id,labels:x.labels as string[],provider:x.provider,status:x.status,createdAt:x.created_at.toISOString()})),contentAssetEtag:asset.etag,processingStatus,extraction:job?{taskId:job.task_id as string,status:job.state as string,outcome:job.outcome as string|null,provider:job.provider as string|null,errorCode:job.error_code as string|null}:null};
 }
 private async applyTagSetTx(tx:pg.PoolClient,userId:string,contentAssetId:string,names:string[]){
  const normalized=this.normalizeTagNames(names);
  const ids:string[]=[];
  // Stable lock ordering for shared account labels.
  for(const displayName of normalized.sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()))){
   const row=(await tx.query(`INSERT INTO asset_tags(tag_id,user_id,normalized_name,display_name,source) VALUES($1,$2,$3,$4,'manual') ON CONFLICT(user_id,normalized_name) DO UPDATE SET display_name=asset_tags.display_name RETURNING tag_id`,[randomUUID(),userId,displayName.toLowerCase(),displayName])).rows[0];ids.push(row.tag_id);
  }
  await tx.query(`DELETE FROM content_asset_tags membership USING asset_tags t
   WHERE membership.content_asset_id=$1 AND membership.tag_id=t.tag_id AND t.user_id=$2`,[contentAssetId,userId]);
  for(const tagId of ids)await tx.query("INSERT INTO content_asset_tags(content_asset_id,tag_id,source) VALUES($1,$2,'manual')",[contentAssetId,tagId]);
  const updated=(await tx.query('UPDATE content_assets SET tag_set_version=tag_set_version+1,tag_manual_override=true WHERE content_asset_id=$1 RETURNING tag_set_version',[contentAssetId])).rows[0];
  await tx.query("UPDATE content_asset_tag_suggestions SET status='stale' WHERE content_asset_id=$1 AND status='pending'",[contentAssetId]);
  await this.cursor(tx,userId,'content_asset',contentAssetId,'updated',false,null,Number(updated.tag_set_version),null,null);
 }
 async contentAssetTags(scope:Scope,contentAssetId:string){return transaction(this.pool,async tx=>{
  await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await assertScope(tx,scope);return this.tagDto(tx,scope,contentAssetId);
 });}
 private async mutateTags(scope:Scope,contentAssetId:string,change:{replace?:string[];add?:string;remove?:string;rename?:{tagId:string;name:string};suggestionId?:string},ifMatch:string,key:string){
  return transaction(this.pool,async tx=>{
   await assertScope(tx,scope);
   return idempotent(tx,this.secret,scope.userId,'content-asset.tags.mutate',key,{contentAssetId,change,ifMatch},async()=>{
    const asset=await this.findContentAsset(tx,scope,contentAssetId,'FOR UPDATE OF asset');
    if(!asset||asset.state!=='active')throw new DomainError(404,'CONTENT_ASSET_NOT_FOUND');
    if(ifMatch!==`"tags-${contentAssetId}-${asset.tag_set_version}"`)throw new DomainError(412,'TAG_REVISION_MISMATCH');
    const view=await this.tagDto(tx,scope,contentAssetId);let names=view.tags.map(t=>t.displayName as string);
    if(change.replace)names=change.replace;
    if(change.add!==undefined)names.push(change.add);
    if(change.remove||change.rename){
     const id=change.remove??change.rename!.tagId;
     if(!view.tags.some(t=>t.tagId===id))throw new DomainError(404,'TAG_NOT_FOUND');
     names=view.tags.flatMap(t=>t.tagId!==id?[t.displayName as string]:change.rename?[change.rename.name]:[]);
    }
    if(change.suggestionId){
     const suggestion=(await tx.query("SELECT * FROM content_asset_tag_suggestions WHERE suggestion_id=$1 AND content_asset_id=$2 AND user_id=$3 FOR UPDATE",[change.suggestionId,contentAssetId,scope.userId])).rows[0];
     if(!suggestion)throw new DomainError(404,'TAG_SUGGESTION_NOT_FOUND');
     if(suggestion.status!=='pending'||suggestion.content_asset_revision_id!==asset.content_asset_revision_id||Number(suggestion.expected_tag_set_version)!==Number(asset.tag_set_version))throw new DomainError(409,'TAG_SUGGESTION_STALE');
     names=suggestion.labels;
    }
    await this.applyTagSetTx(tx,scope.userId,contentAssetId,names);
    if(change.suggestionId)await tx.query("UPDATE content_asset_tag_suggestions SET status='applied',applied_at=now() WHERE suggestion_id=$1",[change.suggestionId]);
    return this.tagDto(tx,scope,contentAssetId);
   });
  });
 }
 async replaceContentAssetTags(scope:Scope,contentAssetId:string,names:string[],ifMatch:string,key:string){return this.mutateTags(scope,contentAssetId,{replace:names},ifMatch,key);}
 async addContentAssetTag(scope:Scope,contentAssetId:string,name:string,ifMatch:string,key:string){return this.mutateTags(scope,contentAssetId,{add:name},ifMatch,key);}
 async removeContentAssetTag(scope:Scope,contentAssetId:string,tagId:string,ifMatch:string,key:string){return this.mutateTags(scope,contentAssetId,{remove:tagId},ifMatch,key);}
 async renameContentAssetTag(scope:Scope,contentAssetId:string,tagId:string,name:string,ifMatch:string,key:string){return this.mutateTags(scope,contentAssetId,{rename:{tagId,name}},ifMatch,key);}
 async applyTagSuggestion(scope:Scope,contentAssetId:string,suggestionId:string,ifMatch:string,key:string){return this.mutateTags(scope,contentAssetId,{suggestionId},ifMatch,key);}
 async requestTagExtraction(scope:Scope,contentAssetId:string,key:string){return transaction(this.pool,async tx=>{
  await assertScope(tx,scope);
  return idempotent(tx,this.secret,scope.userId,'content-asset.tags.extract',key,{contentAssetId},async()=>{
   const asset=await this.findContentAsset(tx,scope,contentAssetId,'FOR UPDATE OF asset');
   if(!asset||asset.state!=='active')throw new DomainError(404,'CONTENT_ASSET_NOT_FOUND');
   if(this.config?.tagExtractorProvider==='disabled')throw new DomainError(503,'TAG_PROVIDER_UNAVAILABLE');
   return {taskId:await this.task(tx,scope,contentAssetId,asset.content_asset_revision_id)};
  });
 });}
 async importContentAsset(scope:Scope,input:{title:string;mimeType:string;content:string;folderId?:string|null;sourceUrl?:string;resourceRefs?:Array<{resourceId:string;usage:string}>},key:string){
  if(!['text/plain','text/markdown'].includes(input.mimeType))throw new DomainError(400,'IMPORT_CONTENT_TYPE_UNSUPPORTED');
  if(typeof input.content!=='string'||!input.content.trim())throw new DomainError(400,'IMPORT_CONTENT_INVALID');
  checkContentAssetParts({raw:input.content},'input');
  // Retain the original processingStatus input in existing import idempotency digests.
  const contentAsset=await this.createContentAsset(scope,{title:input.title,folderId:input.folderId,sourceKind:'import',sourceId:input.sourceUrl,resourceRefs:input.resourceRefs,processingStatus:'ready',parts:{raw:input.content,outline:'',germination:''}},key);
  return {status:'ready' as const,contentAsset};
 }
 private async pendingAudioAsset(tx:pg.PoolClient,userId:string,input:AudioTranscriptionInput,lock=false){
  const {rows:[asset]}=await tx.query<ContentAssetRow>(`SELECT asset.* FROM content_assets asset
   JOIN users u ON u.id=asset.user_id AND u.status='active' AND u.deleted_at IS NULL
   JOIN content_asset_parts p ON p.content_asset_id=asset.content_asset_id AND p.part='raw'
   WHERE asset.content_asset_id=$1 AND asset.user_id=$2 AND p.part_revision_id=$3
    AND asset.asset_kind='audio' AND asset.state='active' AND asset.processing_status='processing'
   ${lock?'FOR UPDATE OF asset':''}`,[input.assetId,userId,input.rawRevisionId]);
  if(asset && await originalAudioResource(tx,userId,input.assetId)===input.resourceId)return asset;
 }
 async isAudioTranscriptionCurrent(tx:pg.PoolClient,userId:string,input:AudioTranscriptionInput){
  return Boolean(await this.pendingAudioAsset(tx,userId,input));
 }
 async finishAudioTranscription(tx:pg.PoolClient,scope:Pick<Scope,'userId'|'traceId'>,input:AudioTranscriptionInput & {text:string|null}){
  const asset=await this.pendingAudioAsset(tx,scope.userId,input,true);
  if(!asset)return false;
  const id=asset.content_asset_id,version=Number(asset.content_asset_revision)+1,revisionId=randomUUID();
  const text=input.text;
  const contentStatus:ContentStatus=text?.trim()?'ready':'failed';
  await tx.query(`UPDATE content_assets SET processing_status=$2,content_asset_revision=$3,content_asset_revision_id=$4,
    etag=$5,updated_at=now() WHERE content_asset_id=$1`,[id,contentStatus,version,revisionId,etag(id,version)]);
  if(text && contentStatus==='ready'){
   await tx.query(`UPDATE content_asset_parts SET part_revision_id=$2,revision=revision+1,content_markdown=$3,
    content_sha256=$4,updated_at=now() WHERE content_asset_id=$1 AND part='raw'`,[id,randomUUID(),text,sha(text)]);
   if(this.config?.tagExtractorProvider!=='disabled')await this.task(tx,scope,id,revisionId);
  }
  await this.cursor(tx,scope.userId,'content_asset',id,'updated',false,revisionId,version,asset.content_asset_revision_id,Number(asset.content_asset_revision));
  return true;
 }
 async importLinkAsset(scope: Scope, url: string, key: string, extractor: LinkExtractor, signal: AbortSignal) {
  return importLink(this.pool,this.secret,scope,key,url,() => extractor.extract(url,signal), async (tx,body) => {
   const asset = await this.createAssetInTransaction(tx,scope,{
    title:body.title, sourceKind:'link', assetKind:'link', sourceId:url, parts:{raw:body.markdown}
   });
   return {...body, contentAssetId:asset.contentAssetId};
  },signal);
 }
 async createContentAsset(scope:Scope,input:CreateAssetInput,key:string){
  return transaction(this.pool,tx=>this.createAssetInTransaction(tx,scope,input,key));
 }
 private async createAssetInTransaction(tx:pg.PoolClient,scope:Scope,input:CreateAssetInput,key?:string){
  await assertScope(tx,scope);await this.lockTree(tx,scope.userId,true);
  checkContentAssetParts(input.parts,'input');
  await this.resourceClaims?.ensure(tx,scope,undefined,(input.resourceRefs??[]).filter(ref=>ref.usage!=='inline-image').map(ref=>ref.resourceId));
  const prepared=await normalizeOwnedImageParts(tx,scope,input.parts,this.config,this.resourceClaims,undefined,(input.assetKind??inferAssetKind(input.sourceKind))==='link');
  const normalized={...input,parts:prepared.parts,imageOrigins:prepared.imageOrigins};
  return idempotent(tx,this.secret,scope.userId,'content-asset.create',key,normalized,async()=>{
   const canonicalParts=restoreOwnedImageParts({},prepared);
   checkContentAssetParts(canonicalParts,'create');
   await this.assertActiveFolder(tx, scope.userId, input.folderId ?? null);
   const id=randomUUID(),rid=randomUUID();
   const assetKind=input.assetKind??inferAssetKind(input.sourceKind);
   const contentStatus:ContentStatus=input.processingStatus??(canonicalParts.raw?.trim()?'ready':'draft');
   await tx.query(
    'INSERT INTO content_assets(content_asset_id,user_id,title,source_kind,source_id,content_asset_revision_id,etag,folder_id,asset_kind,processing_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id,scope.userId,input.title.trim(),input.sourceKind??'manual',input.sourceId??null,rid,etag(id,1),input.folderId??null,assetKind,contentStatus],
   );
   await syncContentAssetRefs(tx,scope,id,canonicalParts,input.resourceRefs);
   const rawRevisionId=randomUUID();
   for(const part of parts){
    const text=canonicalParts[part]??'',partRevisionId=part==='raw'?rawRevisionId:randomUUID();
    await tx.query('INSERT INTO content_asset_parts(part_revision_id,content_asset_id,part,revision,content_markdown,content_sha256) VALUES($1,$2,$3,1,$4,$5)',[partRevisionId,id,part,text,sha(text)]);
   }
   await this.cursor(tx,scope.userId,'content_asset',id,'created',false,rid,1,null,null);
   const originalAudio=this.audioTranscription && assetKind==='audio' && contentStatus==='draft'
    ? await originalAudioResource(tx,scope.userId,id) : undefined;
   if(originalAudio && this.audioTranscription){
    await tx.query("UPDATE content_assets SET processing_status='processing' WHERE content_asset_id=$1",[id]);
    await this.audioTranscription.enqueue(tx,scope,{assetId:id,resourceId:originalAudio,rawRevisionId});
   }else{
    if(this.config?.tagExtractorProvider!=='disabled')await this.task(tx,scope,id,rid);
    await this.indexContentAsset(tx,scope,id);
   }
   return this.contentAssetDto(tx,scope,id);
  });
 }
 async updateContentAsset(scope:Scope,id:string,input:{title?:string;folderId?:string|null;parts?:Record<string,string>;resourceRefs?:ContentAssetResourceRef[]},ifMatch:string,key:string){
  return transaction(this.pool,async tx=>{
   await assertScope(tx,scope);await this.lockTree(tx,scope.userId,true);
   checkContentAssetParts(input.parts??{},'input');
   // Existing image pins can survive a partial body edit. Serialize their writes
   // before the contentAsset row, just like new upload claims; title-only edits need neither.
   const updatesRefs=input.parts!==undefined||input.resourceRefs!==undefined;
   if (this.resourceClaims && updatesRefs && (await tx.query(
    `SELECT 1 FROM content_asset_resource_refs r JOIN content_assets asset ON asset.content_asset_id=r.content_asset_id
     WHERE r.content_asset_id=$1 AND asset.user_id=$2 LIMIT 1`, [id,scope.userId],
   )).rowCount) await this.resourceClaims.lockAccount(tx,scope);
   await this.resourceClaims?.ensure(tx,scope,undefined,(input.resourceRefs??[]).filter(ref=>ref.usage!=='inline-image').map(ref=>ref.resourceId));
   // Normalize before the idempotency digest and before comparing revisions.
   const assetKind = input.parts && (await this.findContentAsset(tx,scope,id))?.asset_kind;
   const prepared=await normalizeOwnedImageParts(tx,scope,input.parts??{},this.config,this.resourceClaims,undefined,assetKind==='link');
   const normalized={...input,...(input.parts?{parts:prepared.parts}:{}),imageOrigins:prepared.imageOrigins};
   return idempotent(tx,this.secret,scope.userId,'content-asset.update',key,{id,input:normalized,ifMatch},async()=>{
    const asset=await this.findContentAsset(tx,scope,id,'FOR UPDATE OF asset');
    if(!asset||asset.state!=='active')throw new DomainError(404,'CONTENT_ASSET_NOT_FOUND');
    if(asset.etag!==ifMatch)throw new DomainError(412,'CONTENT_ASSET_REVISION_MISMATCH');
    if (input.folderId !== undefined) await this.assertActiveFolder(tx, scope.userId, input.folderId);
    const previous=(await tx.query<{part:string;part_revision_id:string;revision:number;content_markdown:string}>('SELECT part,part_revision_id,revision,content_markdown FROM content_asset_parts WHERE content_asset_id=$1',[id])).rows;
    const complete=Object.fromEntries(previous.map(p=>[p.part,p.content_markdown]));
    const canonicalParts=restoreOwnedImageParts(complete,prepared);
    checkContentAssetParts(canonicalParts);
    const changed=Object.entries(canonicalParts).filter(([part,text])=>complete[part]!==text);
    Object.assign(complete,canonicalParts);
    const pendingAudio=asset.asset_kind==='audio' && asset.processing_status==='processing';
    const previousAudio=pendingAudio && input.resourceRefs ? await originalAudioResource(tx,scope.userId,id) : undefined;
    const refsChanged=updatesRefs?await syncContentAssetRefs(tx,scope,id,complete,input.resourceRefs):false;
    const supersedesAudio=pendingAudio && (Object.hasOwn(input.parts??{},'raw')
     || Boolean(refsChanged && input.resourceRefs && previousAudio!==await originalAudioResource(tx,scope.userId,id)));
    const title=input.title?.trim()??asset.title;
    const folderId = input.folderId === undefined ? asset.folder_id : input.folderId;
    const placementChanged = folderId !== asset.folder_id;
    if(!changed.length&&!refsChanged&&title===asset.title&&!placementChanged&&!supersedesAudio)return this.contentAssetDto(tx,scope,id);
    const v=Number(asset.content_asset_revision)+1,rid=randomUUID();
    await tx.query('UPDATE content_assets SET title=$2,content_asset_revision=$3,content_asset_revision_id=$4,etag=$5,folder_id=$6,updated_at=now() WHERE content_asset_id=$1',
     [id,title,v,rid,etag(id,v),folderId]);
    for(const [part,text] of changed){
     const revision=Number(previous.find(p=>p.part===part)?.revision??0)+1,partRevisionId=randomUUID();
     await tx.query('INSERT INTO content_asset_parts(part_revision_id,content_asset_id,part,revision,content_markdown,content_sha256) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(content_asset_id,part) DO UPDATE SET part_revision_id=EXCLUDED.part_revision_id,revision=EXCLUDED.revision,content_markdown=EXCLUDED.content_markdown,content_sha256=EXCLUDED.content_sha256,updated_at=now()',[partRevisionId,id,part,revision,text,sha(text)]);
     }
    const rawChanged=changed.some(([part])=>part==='raw');
    if(rawChanged||supersedesAudio){
     const contentStatus:ContentStatus=complete.raw?.trim()?'ready':'draft';
     await tx.query('UPDATE content_assets SET processing_status=$2 WHERE content_asset_id=$1',[id,contentStatus]);
    }
    await this.cursor(tx,scope.userId,'content_asset',id,'updated',false,rid,v,asset.content_asset_revision_id,Number(asset.content_asset_revision));
    if(this.config?.tagExtractorProvider!=='disabled' && (!pendingAudio || complete.raw?.trim()))await this.task(tx,scope,id,rid);
    if(rawChanged)await this.indexContentAsset(tx,scope,id);
    else if(this.config?.kb.contentAssetEnabled)await new ContentAssetIndexService(this.pool,this.config).scheduleMetadataRefresh(tx,scope,id);
    return this.contentAssetDto(tx,scope,id);
   });
  });
 }
 async putContentAssetPart(scope:Scope,id:string,part:string,markdown:string,ifMatch:string,key:string){checkPart(part);return this.updateContentAsset(scope,id,{parts:{[part]:markdown}},ifMatch,key);}
 async moveContentAssets(scope: Scope, folderId: string | null, contentAssets: Array<{contentAssetId:string;etag:string}>, key: string) {
  return transaction(this.pool, async tx => {
   await assertScope(tx,scope);

   await this.lockTree(tx,scope.userId,true);
   return idempotent(tx,this.secret,scope.userId,'content-asset.batch-move',key,{folderId,contentAssets},async()=>{
    await this.assertActiveFolder(tx,scope.userId,folderId);
    const receipts = [];
    for(const item of contentAssets){
     const contentAsset=await this.findContentAsset(tx,scope,item.contentAssetId,'FOR UPDATE OF asset');
     if(!contentAsset||contentAsset.state!=='active'){
      receipts.push({contentAssetId:item.contentAssetId,status:'not_found'});
      continue;
     }
     if(contentAsset.etag!==item.etag){
      receipts.push({contentAssetId:item.contentAssetId,status:'conflict'});
      continue;
     }
     const version=Number(contentAsset.content_asset_revision)+1,revisionId=randomUUID(),nextEtag=etag(item.contentAssetId,version);
     await tx.query('UPDATE content_assets SET content_asset_revision=$2,content_asset_revision_id=$3,etag=$4,folder_id=$5,updated_at=now() WHERE content_asset_id=$1',
      [item.contentAssetId,version,revisionId,nextEtag,folderId]);
     await this.cursor(tx,scope.userId,'content_asset',item.contentAssetId,'moved',false,revisionId,version,contentAsset.content_asset_revision_id,Number(contentAsset.content_asset_revision));
     if(this.config?.kb.contentAssetEnabled)await new ContentAssetIndexService(this.pool,this.config).scheduleMetadataRefresh(tx,scope,item.contentAssetId);
     receipts.push({contentAssetId:item.contentAssetId,status:'moved',etag:nextEtag});
    }
    return {contentAssets:receipts};
   });
  });
 }
 async contentAssetPart(scope:Scope,id:string,part:string){checkPart(part);return transaction(this.pool,async tx=>{await assertScope(tx,scope);
  const contentAsset=await this.findContentAsset(tx,scope,id,'FOR SHARE OF asset');
  if(!contentAsset||contentAsset.state!=='active')throw new DomainError(404,'CONTENT_ASSET_NOT_FOUND');
  const row=(await tx.query('SELECT * FROM content_asset_parts WHERE content_asset_id=$1 AND part=$2',[id,part])).rows[0];if(!row)throw new DomainError(404,'CONTENT_ASSET_PART_NOT_FOUND');
  return {contentAssetId:id,part,partRevisionId:row.part_revision_id,contentMarkdown:row.content_markdown,contentSha256:row.content_sha256,etag:contentAsset.etag};
 });}
 private async transitionContentAsset(tx:pg.PoolClient,scope:Scope,asset:ContentAssetStateRow,restore:boolean){
  const id=asset.content_asset_id,version=Number(asset.content_asset_revision)+1,revisionId=randomUUID();
  await tx.query(`UPDATE content_assets SET state=$2,content_asset_revision=$3,content_asset_revision_id=$4,etag=$5,updated_at=now(),
   processing_status=CASE WHEN $2='deleted' AND asset_kind='audio' AND processing_status='processing' THEN 'draft' ELSE processing_status END
   WHERE content_asset_id=$1`,
   [id,restore?'active':'deleted',version,revisionId,etag(id,version)]);
  if(restore){
   await this.indexContentAsset(tx,scope,id);
   if(this.config?.kb.contentAssetEnabled)await new ContentAssetIndexService(this.pool,this.config).scheduleMetadataRefresh(tx,scope,id);
  }
  else if((await tx.query('SELECT 1 FROM kb_content_asset_hybrid_builds WHERE source_id=$1 LIMIT 1',[id])).rowCount){
   const taskId=randomUUID(),inputId=randomUUID();
   await tx.query('INSERT INTO task_inputs(id,user_id,body) VALUES($1,$2,$3)',[inputId,scope.userId,JSON.stringify({contentAssetId:id})]);
   await tx.query("INSERT INTO tasks(id,user_id,kind,queue,input_id,state,trace_id,max_attempts) VALUES($1,$2,'kb.content-asset-cleanup','content',$3,'queued',$4,$5)",[taskId,scope.userId,inputId,resolveTraceId(scope.traceId),newTaskMaxAttempts()]);
   await enqueueIntent(tx,taskId);await event(tx,taskId);
  }
  return this.cursor(tx,scope.userId,'content_asset',id,restore?'restored':'deleted',!restore,revisionId,version,asset.content_asset_revision_id,Number(asset.content_asset_revision));
 }
 async deleteContentAsset(scope:Scope,id:string,ifMatch:string,key:string,restore=false){
  return transaction(this.pool,async tx=>{
   await assertScope(tx,scope);await this.lockTree(tx,scope.userId,true);
   return idempotent(tx,this.secret,scope.userId,restore?'content-asset.restore':'content-asset.delete',key,{id,ifMatch},async()=>{
    const contentAsset=await this.findContentAsset(tx,scope,id,'FOR UPDATE OF asset');
    if(!contentAsset)throw new DomainError(404,'CONTENT_ASSET_NOT_FOUND');
    if(contentAsset.etag!==ifMatch)throw new DomainError(412,'CONTENT_ASSET_REVISION_MISMATCH');
    return this.transitionContentAsset(tx,scope,contentAsset,restore);
   });
  });
 }

 async search(scope:Scope,input:{query:string;mode?:string;ownerKinds?:string[];contentAssetParts?:string[];folderIds?:string[];tagIds?:string[];sourceKinds?:string[];assetKinds?:AssetKind[];timeField?:'created_at'|'updated_at';contentAssetTypeIds?:string[];from?:string;to?:string;limit?:number}){
  await transaction(this.pool,async tx=>{await assertScope(tx,scope);});
  if(input.mode&&!['keyword','hybrid'].includes(input.mode))throw new DomainError(400,'SEARCH_MODE_INVALID');
  if(input.contentAssetParts?.some(p=>!['raw','outline','germination'].includes(p)))throw new DomainError(400,'CONTENT_ASSET_PART_INVALID');
  if(input.contentAssetTypeIds?.length)throw new DomainError(400,'SEARCH_CONTENT_ASSET_TYPE_UNSUPPORTED');
  for(const date of [input.from,input.to])if(date&&!Number.isFinite(Date.parse(date)))throw new DomainError(400,'SEARCH_DATE_INVALID');
  if(input.from&&input.to&&Date.parse(input.from)>Date.parse(input.to))throw new DomainError(400,'SEARCH_DATE_INVALID');
  const mode=input.mode==='hybrid'?'hybrid':'keyword';
  if(!input.query.trim())throw new DomainError(400,'SEARCH_QUERY_EMPTY');
  if(!this.ragQuery)throw new DomainError(503,'RAG_SEARCH_UNAVAILABLE');
  const result=(input.ownerKinds?.length&&!input.ownerKinds.includes('content_asset'))||(input.contentAssetParts?.length&&!input.contentAssetParts.includes('raw'))?{results:[]}:await this.ragQuery.query(scope,{query:input.query,mode,sourceType:'content_asset',topK:Math.min(30,input.limit??20),filters:input});
  const ids=[...new Set(result.results.map(r=>String(r.documentKey)))];
  const contentAssets=await transaction(this.pool,async tx=>{await assertScope(tx,scope);return (await tx.query("SELECT asset.content_asset_id,asset.title,asset.updated_at FROM content_assets asset WHERE asset.content_asset_id=ANY($1::uuid[]) AND asset.user_id=$2 AND asset.state='active'",[ids,scope.userId])).rows;});
  const results=contentAssets.flatMap(asset=>{const hit=result.results.find(r=>r.documentKey===asset.content_asset_id);return hit?[{ownerRef:{kind:'content_asset',id:asset.content_asset_id},revisionId:hit.revisionId,part:'raw',path:`content-assets/${asset.content_asset_id}.md`,title:asset.title,updatedAt:asset.updated_at.toISOString(),matchMode:mode,score:Number(hit.rerankScore??(mode==='hybrid'?hit.rrfScore:hit.keywordScore)),staleSource:false}]:[];});
  return {mode,queryFingerprint:sha(`${scope.userId}:${normalize(input.query)}`),keywordReadiness:'current',vectorReadiness:mode==='hybrid'?'current':'unavailable',vectorStatus:mode==='hybrid'?'ready':'unavailable',contentCursor:String((await this.pool.query('SELECT next_cursor FROM account_content_state WHERE user_id=$1',[scope.userId])).rows[0]?.next_cursor??0),results};
 }
 async createContentAssetRelation(scope:Scope,id:string,input:{targetContentAssetId:string;relationType:string;rationale:string},key:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);return idempotent(tx,this.secret,scope.userId,'content-asset.relation.create',key,{id,...input},async()=>{if(!['references','supports','contradicts','related'].includes(input.relationType)||input.targetContentAssetId===id)throw new DomainError(400,'RELATION_INVALID');const ok=await tx.query("SELECT asset.content_asset_id FROM content_assets asset WHERE asset.content_asset_id=ANY($1::uuid[]) AND asset.user_id=$2 AND asset.state='active'",[[id,input.targetContentAssetId],scope.userId]);if(ok.rowCount!==2)throw new DomainError(404,'CONTENT_ASSET_NOT_FOUND');const rid=randomUUID();await tx.query('INSERT INTO content_asset_relations(relation_id,user_id,source_content_asset_id,target_content_asset_id,relation_type,rationale,etag) VALUES($1,$2,$3,$4,$5,$6,$7)',[rid,scope.userId,id,input.targetContentAssetId,input.relationType,input.rationale,`"relation-${rid}-1"`]);return {relationId:rid,relationType:input.relationType,origin:'explicit',source:{contentAssetId:id,part:'raw'},target:{contentAssetId:input.targetContentAssetId,part:'raw'},rationale:input.rationale,version:1,etag:`"relation-${rid}-1"`};});});}
 async deleteContentAssetRelation(scope:Scope,rid:string,ifMatch:string,key:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);return idempotent(tx,this.secret,scope.userId,'content-asset.relation.delete',key,{rid,ifMatch},async()=>{const r=await tx.query('DELETE FROM content_asset_relations WHERE relation_id=$1 AND user_id=$2 AND etag=$3 RETURNING relation_id,source_content_asset_id,target_content_asset_id',[rid,scope.userId,ifMatch]);if(!r.rowCount)throw new DomainError(412,'RELATION_REVISION_MISMATCH');return {eventId:randomUUID(),cursor:String((await tx.query('SELECT coalesce(next_cursor,0) c FROM account_content_state WHERE user_id=$1',[scope.userId])).rows[0]?.c??0),operationId:randomUUID(),occurredAt:new Date().toISOString(),objectKind:'content_asset_relation',objectId:rid,changeType:'deleted',tombstone:true,resourcePinDelta:{added:[],released:[]}};});});}
 async navigation(scope:Scope,map:string,input:GraphQuery={}){return transaction(this.pool,async tx=>{
  await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await assertScope(tx,scope);
  return tagGraph(tx,scope.userId,map,input);
 });}
 async contentAssetRelations(scope:Scope,id:string){return transaction(this.pool,async tx=>{await assertScope(tx,scope);const r=await tx.query('SELECT * FROM content_asset_relations WHERE user_id=$1 AND (source_content_asset_id=$2 OR target_content_asset_id=$2) ORDER BY created_at',[scope.userId,id]);return {items:r.rows.map(x=>({relationId:x.relation_id,relationType:x.relation_type,origin:x.origin,source:{contentAssetId:x.source_content_asset_id,part:'raw'},target:{contentAssetId:x.target_content_asset_id,part:'raw'},rationale:x.rationale,version:x.version,etag:x.etag}))};});}
}
