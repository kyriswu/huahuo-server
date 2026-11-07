import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { canonical } from '../../lib/crypto.js';
import { assertScope, transaction, type Scope, DomainError } from '../identity/store.js';
import { enqueueIntent, event } from '../tasks/model.js';
import type { AppConfig, RagConfig } from '../../config/config.js';
import { sha256 } from './chunkers.js';
import type { RagMode, RagStage } from './types.js';
import { fileProcessingSnapshot, fileSplitOptions, type FileProcessingSnapshot } from './processing-profile.js';
import { isMarkdownSource } from '../ingestion/document-parser.js';
import { requireTocSection, sectionResult } from '../ingestion/sections.js';
import type { TocStatus } from '../../lib/document-processing/types.js';
import type { StoragePort } from '../storage/port.js';
import { publicToc, readCanonicalSection, type CanonicalTocItem } from './canonical-toc.js';
import { documentKeyForVersion, embeddingProfileFor, indexBuildIdForVersion } from './stable.js';
import { DocumentPreparationError, validateSourceUri } from './document-preparation.js';

export interface CreateRagInput { ossUrl:string; fileName:string; mimeType:string; idempotencyKey?:string; }
export interface RagVersionRow { id:string; user_id:string; workspace_id:string; idempotency_key:string; source_url:string; source_file_name:string; source_mime_type:string; source_size:string|null; source_sha256:string|null; source_object_key:string|null; mode:RagMode; document_key:string; source_type:string; source_pk:string; embedding_profile:string; index_build_id:string; active:boolean; canonical_content:string|null; canonical_content_uri:string|null; enriched_canonical_markdown_uri?:string|null; raw_markdown_uri:string|null; asset_manifest_uri:string|null; parser_provider:string|null; parser_version:string|null; parser_config_hash:string|null; chunk_config_hash:string; status:RagStage; current_stage:RagStage; failed_stage:string|null; error_code:string|null; error_message:string|null; retryable:boolean; attempt_count:number; last_attempt_at:Date|string|null; mineru_task_id:string|null; mineru_batch_id:string|null; mineru_trace_id:string|null; mineru_data_id?:string|null; mineru_model_version?:string|null; parser_metadata?:unknown; parse_artifact_uri:string|null; embedding_status:string; index_status:string; embedding_model:string; embedding_dimension:number; milvus_collection:string; child_count:number; content_hash:string|null; task_id:string|null; created_at:Date|string; updated_at:Date|string; task_state?:string|null; processing_snapshot?:unknown; processing_info?:{ignoredHeadingRanges?:Array<{sourceStart:number;sourceEnd:number}>}; toc_status:TocStatus; toc:CanonicalTocItem[]|null; toc_error:string|null; deleted_at?:Date|string|null; }
const hostAllowed=(url:string,hosts:string[],production:boolean)=>{
  try { return validateSourceUri(url,{appEnv:production?'production':'development',rag:{sourceAllowedHosts:hosts}}).toString(); }
  catch(error){if(error instanceof DocumentPreparationError)throw new DomainError(400,error.code);throw error;}
};
function modeFor(fileName:string,mimeType:string):RagMode {const mime=mimeType.split(';',1)[0]!.toLowerCase();const ext=fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0]??'';const plainMimes=new Set(['text/plain','text/markdown','text/csv']);const structuredMimes=new Set(['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);const plainExts=new Set(['.txt','.md','.markdown','.csv']);const structuredExts=new Set(['.pdf','.doc','.docx','.ppt','.pptx','.xls','.xlsx']);const byMime=plainMimes.has(mime)?'plain_text':structuredMimes.has(mime)?'structured_document':undefined;const byExt=plainExts.has(ext)?'plain_text':structuredExts.has(ext)?'structured_document':undefined;if(byMime&&byExt&&byMime!==byExt)throw new DomainError(400,'RAG_FILE_TYPE_MISMATCH');if(byMime||byExt)return byMime??byExt!;throw new DomainError(400,'RAG_FILE_TYPE_UNSUPPORTED');}
export class RagIngestionRepository {
  constructor(readonly pool:pg.Pool,readonly config:RagConfig,readonly appEnv:string,readonly milvusCollection:string,readonly appConfig:AppConfig){}
  async create(scope: Scope, input: CreateRagInput): Promise<{ jobId: string; documentVersionId: string; status: string; reused: boolean }> {
    if(!this.config.enabled)throw new DomainError(503,'RAG_INGESTION_DISABLED');
    const normalized={ossUrl:hostAllowed(input.ossUrl,this.config.sourceAllowedHosts,this.appEnv==='production'),fileName:input.fileName.trim(),mimeType:input.mimeType.split(';',1)[0]!.trim().toLowerCase()};
    if(!normalized.fileName||normalized.fileName.length>255||/[\0\\/]/.test(normalized.fileName))throw new DomainError(400,'RAG_FILE_NAME_INVALID');
    const mode = modeFor(normalized.fileName, normalized.mimeType);
    const format = mode === 'structured_document' || isMarkdownSource(normalized) ? 'markdown' : 'text';
    const chunkConfigHash = sha256(canonical({
      format, split: fileSplitOptions(this.config), model: this.config.embeddingModel, dimensions: this.config.embeddingDimensions,
    }));
    const idem = input.idempotencyKey?.trim() || sha256(canonical({ ...normalized, chunkConfigHash, target: this.milvusCollection }));
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idem)) throw new DomainError(400, 'IDEMPOTENCY_KEY_INVALID');

    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      const workspace = (await tx.query<{ id: string }>("SELECT id FROM workspaces WHERE user_id=$1 AND is_default AND state='ready'", [scope.userId])).rows[0];
      if (!workspace) throw new DomainError(409, 'WORKSPACE_NOT_READY');
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['rag.create:' + scope.userId + ':' + idem]);
      const existing = (await tx.query<RagVersionRow>('SELECT * FROM rag_ingestion_versions WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE', [scope.userId, idem])).rows[0];
      if (existing) {
        if (existing.source_url !== normalized.ossUrl || existing.source_file_name !== normalized.fileName || existing.source_mime_type !== normalized.mimeType) throw new DomainError(409, 'IDEMPOTENCY_CONFLICT');
        return { jobId: existing.task_id!, documentVersionId: existing.id, status: existing.status, reused: true };
      }
      const versionId = randomUUID(), taskId = randomUUID(), inputId = randomUUID();
      const documentKey = documentKeyForVersion(versionId);
      const embeddingProfile = embeddingProfileFor(this.config.embeddingModel, this.config.embeddingDimensions);
      const indexBuildId = indexBuildIdForVersion(documentKey, embeddingProfile);
      const snapshot = fileProcessingSnapshot(this.appConfig, format);
      await tx.query(`INSERT INTO rag_ingestion_versions
        (id,user_id,workspace_id,idempotency_key,source_url,source_file_name,source_mime_type,mode,chunk_config_hash,status,current_stage,
         embedding_model,embedding_dimension,milvus_collection,document_key,source_type,source_pk,embedding_profile,index_build_id,processing_snapshot,task_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'RECEIVED','RECEIVED',$10,$11,$12,$13,'file',$13,$14,$15,$16::jsonb,$17)`,
        [versionId, scope.userId, workspace.id, idem, normalized.ossUrl, normalized.fileName, normalized.mimeType, mode, chunkConfigHash,
          this.config.embeddingModel, this.config.embeddingDimensions, this.milvusCollection, documentKey, embeddingProfile, indexBuildId, JSON.stringify(snapshot), taskId]);
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
      const version=(await tx.query<RagVersionRow>('SELECT * FROM rag_ingestion_versions WHERE task_id=$1 AND user_id=$2 FOR UPDATE',[jobId,scope.userId])).rows[0];
      if(!version)throw new DomainError(404,'RAG_INGESTION_NOT_FOUND');
      if(action==='retry-toc'&&(version.deleted_at||version.status!=='SUCCEEDED'||version.toc_status!=='failed'||!version.canonical_content_uri))throw new DomainError(409,'RAG_TOC_NOT_AVAILABLE');
      if(action==='delete')await tx.query('UPDATE rag_ingestion_versions SET deleted_at=coalesce(deleted_at,now()),active=false,cleanup_status=$2 WHERE id=$1',[version.id,'pending']);
      else await tx.query("UPDATE rag_ingestion_versions SET toc_status='pending',toc_error=NULL WHERE id=$1",[version.id]);
      const taskId=randomUUID(),inputId=randomUUID();
      await tx.query('INSERT INTO task_inputs(id,user_id,workspace_id,body) VALUES($1,$2,$3,$4)',[inputId,scope.userId,version.workspace_id,JSON.stringify({versionId:version.id})]);
      await tx.query("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,input_id,state) VALUES($1,$2,$3,$4,'content',$5,'queued')",[taskId,scope.userId,version.workspace_id,action==='delete'?'rag.document-cleanup':'rag.toc-refresh',inputId]);
      await enqueueIntent(tx,taskId);await event(tx,taskId);return {jobId:taskId,documentVersionId:version.id,status:'RECEIVED'};
    });
  }
  async byId(pool:pg.Pool,id:string){return (await pool.query<RagVersionRow>('SELECT * FROM rag_ingestion_versions WHERE id=$1 FOR UPDATE',[id])).rows[0];}
  dto(row:RagVersionRow){return {jobId:row.task_id,documentVersionId:row.id,status:row.status,currentStage:row.current_stage,taskState:row.task_state??null,mode:row.mode,fileName:row.source_file_name,mimeType:row.source_mime_type,sourceSha256:row.source_sha256,sourceSizeBytes:row.source_size?Number(row.source_size):null,parserProvider:row.parser_provider,parserVersion:row.parser_version,canonicalMarkdownUri:row.enriched_canonical_markdown_uri??row.canonical_content_uri,rawMarkdownUri:row.raw_markdown_uri,embeddingStatus:row.embedding_status,indexStatus:row.index_status,embeddingModel:row.embedding_model,embeddingDimension:row.embedding_dimension,milvusCollection:row.milvus_collection,parentId:row.id,sourceType:row.source_type,toc:row.deleted_at||!row.toc?null:publicToc(row.toc),tocStatus:row.toc_status,tocError:row.toc_error,offsetUnit:'utf16' as const,deletedAt:row.deleted_at?new Date(row.deleted_at).toISOString():null,cleanupStatus:(row as RagVersionRow & {cleanup_status?:string}).cleanup_status??'pending',processingComplete:!row.deleted_at&&row.index_status==='ready'&&row.toc_status==='ready',childCount:row.child_count,error:row.error_code?{code:row.error_code,message:row.error_message,retryable:row.retryable}:null,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()};}
}
