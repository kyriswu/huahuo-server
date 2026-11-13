import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { canonical } from '../../lib/crypto.js';
import { assertScope, transaction, type Scope, DomainError } from '../identity/store.js';
import { enqueueIntent, event } from '../tasks/model.js';
import type { AppConfig, RagConfig } from '../../config/config.js';
import { sha256 } from './chunkers.js';
import type { RagMode, RagStage } from './types.js';
import { fileProcessingSnapshot, type FileProcessingSnapshot } from './processing-profile.js';
import { isMarkdownSource } from '../ingestion/document-parser.js';
import { requireTocSection, sectionResult } from '../ingestion/sections.js';
import type { TocStatus } from '../../lib/document-processing/types.js';
import type { StoragePort } from '../storage/port.js';
import { publicToc, readCanonicalSection, type CanonicalTocItem } from './canonical-toc.js';
import {validUuid} from '../../integrations/document-extraction.js';
import {createGunzip} from 'node:zlib';
import {attachResource} from '../storage/references.js';
import {TaskService} from '../tasks/service.js';
import type {TaskRow} from '../tasks/model.js';

import { DocumentPreparationError, validateSourceUri } from './document-preparation.js';

export interface CreateRagInput { ossUrl:string; fileName:string; mimeType:string; idempotencyKey?:string; sourceResourceId?:string;parseRunId?:string; }
export interface RagVersionRow { id:string; user_id:string; workspace_id:string; idempotency_key:string; source_url:string; source_file_name:string; source_mime_type:string; source_size:string|null; source_sha256:string|null; source_object_key:string|null; mode:RagMode; document_key:string; source_type:string;    active:boolean;  canonical_content_uri:string|null; enriched_canonical_markdown_uri?:string|null; raw_markdown_uri:string|null; asset_manifest_uri:string|null; parser_provider:string|null; parser_version:string|null; parser_config_hash:string|null;  status:RagStage; current_stage:RagStage; failed_stage:string|null; error_code:string|null; error_message:string|null; retryable:boolean; attempt_count:number; last_attempt_at:Date|string|null; parser_metadata?:unknown; parse_artifact_uri:string|null;       content_hash:string|null; task_id:string|null; created_at:Date|string; updated_at:Date|string; task_state?:string|null; processing_snapshot?:unknown; processing_info?:{ignoredHeadingRanges?:Array<{sourceStart:number;sourceEnd:number}>}; toc_status:TocStatus; toc:CanonicalTocItem[]|null; toc_error:string|null; deleted_at?:Date|string|null; }
const hostAllowed=(url:string,hosts:string[],production:boolean)=>{
  try { return validateSourceUri(url,{appEnv:production?'production':'development',rag:{sourceAllowedHosts:hosts}}).toString(); }
  catch(error){if(error instanceof DocumentPreparationError)throw new DomainError(400,error.code);throw error;}
};
function modeFor(fileName: string, mimeType: string,structuredEnabled=false): RagMode {
  const mime = mimeType.split(';', 1)[0]!.toLowerCase();
  const ext = fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  const textMimes = new Set(['text/plain', 'text/markdown', 'text/x-markdown', 'text/csv']);
  const textExts = new Set(['.txt', '.md', '.markdown', '.csv']);
  const binaryMimes = new Set(['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
  const binaryExts = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx']);
  if ((textMimes.has(mime) && binaryExts.has(ext)) || (textExts.has(ext) && binaryMimes.has(mime))) throw new DomainError(400, 'RAG_FILE_TYPE_MISMATCH');
  if (binaryMimes.has(mime) || binaryExts.has(ext)) {
    if(!structuredEnabled)throw new DomainError(400, 'RAG_FILE_TYPE_UNSUPPORTED');
    return 'structured_document';
  }
  if (textMimes.has(mime) || textExts.has(ext)) return 'plain_text';
  throw new DomainError(400, 'RAG_FILE_TYPE_UNSUPPORTED');
}
export class RagIngestionRepository {
  constructor(readonly pool:pg.Pool,readonly config:RagConfig,readonly appEnv:string,readonly milvusCollection:string,readonly appConfig:AppConfig){}
  async create(scope: Scope, input: CreateRagInput): Promise<{ jobId: string; documentVersionId: string; status: string; reused: boolean }> {
    input={...input,sourceResourceId:input.sourceResourceId?.toLowerCase(),parseRunId:input.parseRunId?.toLowerCase()};
    if(!this.config.enabled)throw new DomainError(503,'RAG_INGESTION_DISABLED');
    const normalized={ossUrl:hostAllowed(input.ossUrl,this.config.sourceAllowedHosts,this.appEnv==='production'),fileName:input.fileName.trim(),mimeType:input.mimeType.split(';',1)[0]!.trim().toLowerCase()};
    if(!normalized.fileName||normalized.fileName.length>255||/[\0\\/]/.test(normalized.fileName))throw new DomainError(400,'RAG_FILE_NAME_INVALID');
    const mode = modeFor(normalized.fileName, normalized.mimeType,this.appConfig.documentExtraction.enabled);
    if((input.sourceResourceId!==undefined&&!validUuid(input.sourceResourceId))||(input.parseRunId!==undefined&&!validUuid(input.parseRunId)))throw new DomainError(400,'DOCUMENT_EXTRACTION_CONTEXT_INVALID');
    const format = mode==='structured_document'||isMarkdownSource(normalized) ? 'markdown' : 'text';
    const chunkConfigHash = sha256(canonical({
      format, rules: 'paragraph-2000-zero-overlap',
    }));
    const idem = input.idempotencyKey?.trim() || sha256(canonical({ ...normalized, chunkConfigHash, target: this.milvusCollection,
      ...(mode==='structured_document'?{sourceResourceId:input.sourceResourceId??null,parseRunId:input.parseRunId??null,parser:this.appConfig.documentExtraction}:{}), }));
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idem)) throw new DomainError(400, 'IDEMPOTENCY_KEY_INVALID');

    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      const workspace = (await tx.query<{ id: string }>("SELECT id FROM workspaces WHERE user_id=$1 AND is_default AND state='ready'", [scope.userId])).rows[0];
      if (!workspace) throw new DomainError(409, 'WORKSPACE_NOT_READY');
      let sourceResource:{object_key:string;sha256:string;size_bytes:string;mime_type:string}|undefined;
      if(mode==='structured_document'&&input.sourceResourceId){
        sourceResource=(await tx.query<{object_key:string;sha256:string;size_bytes:string;mime_type:string}>("SELECT object_key,sha256,size_bytes,mime_type FROM resources WHERE resource_id=$1 AND user_id=$2 AND workspace_id=$3 AND status='ready' FOR UPDATE",[input.sourceResourceId,scope.userId,workspace.id])).rows[0];
        if(!sourceResource)throw new DomainError(404,'RESOURCE_NOT_FOUND');
        if(sourceResource.mime_type!==normalized.mimeType)throw new DomainError(400,'RAG_FILE_TYPE_MISMATCH');
        if(input.parseRunId){
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['document.parse:'+scope.userId+':'+input.sourceResourceId+':'+input.parseRunId]);
          const same=(await tx.query<RagVersionRow>(`SELECT * FROM rag_ingestion_versions WHERE user_id=$1 AND workspace_id=$2
            AND processing_snapshot#>>'{parser,sourceResourceId}'=$3 AND processing_snapshot#>>'{parser,parseRunId}'=$4 FOR UPDATE`,[scope.userId,workspace.id,input.sourceResourceId,input.parseRunId])).rows[0];
          if(same){
            const parser=(same.processing_snapshot as FileProcessingSnapshot).parser!;
            if(same.source_file_name!==normalized.fileName||same.source_mime_type!==normalized.mimeType
              ||!this.appConfig.documentExtraction.enabled||parser.extraction.configHash!==this.appConfig.documentExtraction.configHash)throw new DomainError(409,'DOCUMENT_EXTRACTION_BATCH_CONFLICT');
            return {jobId:same.task_id!,documentVersionId:same.id,status:same.status,reused:true};
          }
        }
      }
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['rag.create:' + scope.userId + ':' + idem]);
      const existing = (await tx.query<RagVersionRow>('SELECT * FROM rag_ingestion_versions WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE', [scope.userId, idem])).rows[0];
      if (existing) {
        if (existing.source_url !== normalized.ossUrl || existing.source_file_name !== normalized.fileName || existing.source_mime_type !== normalized.mimeType) throw new DomainError(409, 'IDEMPOTENCY_CONFLICT');
        const parser=(existing.processing_snapshot as FileProcessingSnapshot|null)?.parser;
        if((input.sourceResourceId&&parser?.sourceResourceId!==input.sourceResourceId)||(input.parseRunId&&parser?.parseRunId!==input.parseRunId))throw new DomainError(409,'IDEMPOTENCY_CONFLICT');
        return { jobId: existing.task_id!, documentVersionId: existing.id, status: existing.status, reused: true };
      }
      const versionId = randomUUID(), taskId = randomUUID(), inputId = randomUUID();
      const snapshot = fileProcessingSnapshot(this.appConfig, format,mode==='structured_document'?{
        sourceResourceId:input.sourceResourceId??versionId,parseRunId:input.parseRunId??randomUUID(),
      }:undefined);
      await tx.query(`INSERT INTO rag_ingestion_versions
        (id,user_id,workspace_id,idempotency_key,source_url,source_file_name,source_mime_type,mode,status,current_stage,document_key,source_type,processing_snapshot,task_id)
        VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,'RECEIVED','RECEIVED',$1::text,'file',$9::jsonb,$10)`,
        [versionId,scope.userId,workspace.id,idem,normalized.ossUrl,normalized.fileName,normalized.mimeType,mode,JSON.stringify(snapshot),taskId]);
      if(sourceResource)await tx.query('UPDATE rag_ingestion_versions SET source_object_key=$2,source_sha256=$3,source_size=$4 WHERE id=$1',[versionId,sourceResource.object_key,sourceResource.sha256,sourceResource.size_bytes]);
      if(sourceResource)await attachResource(tx,scope.userId,input.sourceResourceId!,'document-source',versionId,workspace.id);
      await tx.query('INSERT INTO task_inputs(id,user_id,workspace_id,body) VALUES($1,$2,$3,$4)', [inputId, scope.userId, workspace.id, JSON.stringify({ versionId })]);
      await tx.query("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,input_id,state,max_attempts) VALUES($1,$2,$3,'rag.document-ingest','content',$4,'queued',3)", [taskId, scope.userId, workspace.id, inputId]);
      await enqueueIntent(tx, taskId);
      await event(tx, taskId);
      return { jobId: taskId, documentVersionId: versionId, status: 'RECEIVED', reused: false };
    });
  }
  private async versionForJob(scope: Scope, jobId: string) {
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      const row = (await tx.query<RagVersionRow>(`SELECT v.*,t.state AS task_state
        FROM rag_ingestion_versions v JOIN tasks t ON t.id=v.task_id
        JOIN workspaces w ON w.id=v.workspace_id AND w.user_id=v.user_id AND w.state='ready'
        WHERE v.task_id=$1 AND v.user_id=$2`, [jobId, scope.userId])).rows[0];
      if (!row) throw new DomainError(404, 'RAG_INGESTION_NOT_FOUND');
      return row;
    });
  }
  async detail(scope: Scope, jobId: string) {
    return this.dto(await this.versionForJob(scope, jobId));
  }
  async extraction(scope:Scope,jobId:string,storage:Pick<StoragePort,'read'>){
    const row=await this.versionForJob(scope,jobId);
    if(row.deleted_at)throw new DomainError(404,'RAG_INGESTION_NOT_FOUND');
    if(!row.parse_artifact_uri)throw new DomainError(409,'DOCUMENT_EXTRACTION_NOT_READY');
    return (await storage.read(row.parse_artifact_uri)).pipe(createGunzip());
  }
  async asset(scope:Scope,jobId:string,resourceId:string,storage:Pick<StoragePort,'read'>){
    const version=await this.versionForJob(scope,jobId);
    if(version.deleted_at)throw new DomainError(404,'RAG_INGESTION_NOT_FOUND');
    const row=(await this.pool.query('SELECT * FROM rag_document_assets WHERE id=$1 AND version_id=$2 AND upload_status=$3',[resourceId,version.id,'ready'])).rows[0];
    if(!row)throw new DomainError(404,'RESOURCE_NOT_FOUND');
    const config=this.appConfig.storageAliyunOss,receipt=row.metadata;
    if(this.appConfig.storageDriver!=='aliyun-oss'||!config||receipt?.bucket!==config.bucket)throw new DomainError(503,'DOCUMENT_ASSET_STORAGE_UNAVAILABLE');
    const prefix=config.keyPrefix?.replace(/\/+$/,'');
    if(prefix&&!String(row.object_key).startsWith(prefix+'/'))throw new DomainError(503,'DOCUMENT_ASSET_STORAGE_UNAVAILABLE');
    const key=prefix?String(row.object_key).slice(prefix.length+1):String(row.object_key);
    return {stream:await storage.read(key),mimeType:String(row.mime_type),sizeBytes:Number(row.byte_size)};
  }
  async section(scope: Scope, jobId: string, sectionId: string, storage: Pick<StoragePort, 'read'>) {
    const row = await this.versionForJob(scope, jobId);
    if (row.deleted_at) throw new DomainError(404, 'RAG_INGESTION_NOT_FOUND');
    const section = requireTocSection(row.toc_status, row.toc, sectionId);
    const snapshot = row.processing_snapshot as FileProcessingSnapshot | null;
    if (!row.canonical_content_uri || !snapshot?.format) throw new DomainError(503, 'DOCUMENT_SECTION_UNAVAILABLE');
    const content = await readCanonicalSection(storage, row.canonical_content_uri, section);
    return sectionResult(section, row.id, snapshot.format, content);
  }
  async action(scope:Scope,jobId:string,action:'delete'|'retry-toc'){
    return transaction(this.pool,async tx=>{
      await assertScope(tx,scope);
      // Match the worker's Task -> source lock order before taking the source row lock.
      const original=action==='delete'?(await tx.query<TaskRow>(`SELECT t.* FROM tasks t JOIN rag_ingestion_versions v ON v.task_id=t.id
        WHERE v.task_id=$1 AND v.user_id=$2 AND t.user_id=v.user_id AND t.workspace_id=v.workspace_id FOR UPDATE OF t`,[jobId,scope.userId])).rows[0]:undefined;
      const version=(await tx.query<RagVersionRow>('SELECT * FROM rag_ingestion_versions WHERE task_id=$1 AND user_id=$2 FOR UPDATE',[jobId,scope.userId])).rows[0];
      if(!version)throw new DomainError(404,'RAG_INGESTION_NOT_FOUND');
      if(action==='retry-toc'&&(version.deleted_at||version.status!=='SUCCEEDED'||version.toc_status!=='failed'||!version.canonical_content_uri))throw new DomainError(409,'RAG_TOC_NOT_AVAILABLE');
      if(action==='delete'){
        if(original)await new TaskService(this.pool,this.appConfig.appTokenSecret!).change(tx,original,'cancel');
        await tx.query('UPDATE rag_ingestion_versions SET deleted_at=coalesce(deleted_at,now()),active=false,cleanup_status=$2 WHERE id=$1',[version.id,'pending']);
        await tx.query("DELETE FROM resource_refs WHERE ref_kind='document-source' AND ref_id_external=$1 AND user_id=$2 AND workspace_id=$3",[version.id,scope.userId,version.workspace_id]);
      }
      else await tx.query("UPDATE rag_ingestion_versions SET toc_status='pending',toc_error=NULL WHERE id=$1",[version.id]);
      const taskId=randomUUID(),inputId=randomUUID();
      await tx.query('INSERT INTO task_inputs(id,user_id,workspace_id,body) VALUES($1,$2,$3,$4)',[inputId,scope.userId,version.workspace_id,JSON.stringify({versionId:version.id})]);
      await tx.query("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,input_id,state) VALUES($1,$2,$3,$4,'content',$5,'queued')",[taskId,scope.userId,version.workspace_id,action==='delete'?'rag.document-cleanup':'rag.toc-refresh',inputId]);
      await enqueueIntent(tx,taskId);await event(tx,taskId);return {jobId:taskId,documentVersionId:version.id,status:'RECEIVED'};
    });
  }
  async byId(pool:pg.Pool,id:string){return (await pool.query<RagVersionRow>('SELECT * FROM rag_ingestion_versions WHERE id=$1 FOR UPDATE',[id])).rows[0];}
  dto(row:RagVersionRow){return {jobId:row.task_id,documentVersionId:row.id,status:row.status,currentStage:row.current_stage,taskState:row.task_state??null,mode:row.mode,fileName:row.source_file_name,mimeType:row.source_mime_type,sourceSha256:row.source_sha256,sourceSizeBytes:row.source_size?Number(row.source_size):null,parserProvider:row.parser_provider,parserVersion:row.parser_version,canonicalMarkdownUri:row.enriched_canonical_markdown_uri??row.canonical_content_uri,rawMarkdownUri:row.raw_markdown_uri,parentId:row.id,sourceType:row.source_type,toc:row.deleted_at||!row.toc?null:publicToc(row.toc),tocStatus:row.toc_status,tocError:row.toc_error,offsetUnit:'utf16' as const,deletedAt:row.deleted_at?new Date(row.deleted_at).toISOString():null,cleanupStatus:(row as RagVersionRow & {cleanup_status?:string}).cleanup_status??'pending',processingComplete:!row.deleted_at&&row.status==='SUCCEEDED'&&row.toc_status==='ready',error:row.error_code?{code:row.error_code,message:row.error_message,retryable:row.retryable}:null,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()};}
}
