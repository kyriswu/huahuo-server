import pg from 'pg';
import { Readable } from 'node:stream';
import type { AppConfig } from '../../config/config.js';
import { DOCUMENT_CANONICAL_MAX_BYTES } from '../../config/document-extraction.js';
import type { Attempt } from '../tasks/execution.js';
import type { StoragePort } from '../storage/port.js';
import { transaction } from '../identity/store.js';
import { digest as sha256 } from '../../lib/crypto.js';
import type { KbDependencies } from '../kb/jobs.js';
import { KnowledgeIndexJobs } from '../kb/jobs.js';
import { analyzeDocumentStructure } from '../../lib/document-processing/structure.js';
import { readingToc } from '../../lib/document-processing/toc.js';
import type { DocumentStructure } from '../../lib/document-processing/types.js';
import { type FileProcessingSnapshot } from './processing-profile.js';
import { indexTocBytes, type CanonicalTocItem } from './canonical-toc.js';
import { EmbeddingError } from '../../integrations/embedding.js';
import { SearchIndexError } from '../../lib/search-index/types.js';
import { RagIngestionRepository, type RagVersionRow } from './repository.js';
import { DocumentPreparationError } from './document-preparation.js';
import {ManagedDocumentExtractor,ManagedExtractionError,type SavedExtraction} from '../ingestion/document-extraction.js';
import type {ExtractionDocument} from '../../integrations/document-extraction.js';
import {ParserExecutionDeferred} from '../../lib/document-parser-machine/index.js';

export class RagJobError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, options?: { cause?: unknown }) { super(message, options); this.name = 'RagJobError'; }
}
function utf8(bytes: Uint8Array): string { try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch (error) { throw new RagJobError('RAG_TEXT_NOT_UTF8', 'Saved canonical body is not valid UTF-8', false, { cause: error }); } }
async function readCanonicalBytes(stream: Readable): Promise<Uint8Array> {
  const parts: Buffer[] = [];let bytes=0;
  try{for await(const chunk of stream){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=buffer.length;if(bytes>DOCUMENT_CANONICAL_MAX_BYTES)throw new RagJobError('RAG_CANONICAL_TOO_LARGE','Saved body exceeds the extraction limit');parts.push(buffer);}}
  finally{stream.destroy();}
  return Buffer.concat(parts);
}

export class RagIngestionJobs {
  private readonly versions: RagIngestionRepository;
  private readonly extractor:ManagedDocumentExtractor;
  constructor(readonly pool: pg.Pool, readonly config: AppConfig, readonly storage: StoragePort, private readonly dependencies:{analyze?:typeof analyzeDocumentStructure;saveToc?:(id:string,toc:CanonicalTocItem[])=>Promise<void>;kb?:KbDependencies}={}) {
    this.versions = new RagIngestionRepository(pool,config);
    this.extractor=new ManagedDocumentExtractor(pool,config,storage);
  }
  async close(): Promise<void> {await this.extractor.close();}

  async execute(attempt: Attempt): Promise<{ digest: string; bytes: number }> {
    const input = (await this.pool.query('SELECT body FROM task_inputs WHERE id=$1 AND user_id=$2 AND workspace_id=$3', [attempt.task.input_id, attempt.task.user_id, attempt.task.workspace_id])).rows[0];
    if (!input) throw new RagJobError('RAG_INPUT_UNAVAILABLE', 'RAG task input is unavailable', false);
    let versionId: string;
    try { versionId = String(JSON.parse(String(input.body)).versionId); } catch (error) { throw new RagJobError('RAG_INPUT_INVALID', 'RAG task input is invalid', false, { cause: error }); }
    const version = await this.versions.byId(this.pool, versionId);
    if (!version || version.user_id !== attempt.task.user_id || version.workspace_id !== attempt.task.workspace_id) throw new RagJobError('RAG_VERSION_NOT_FOUND', 'RAG document version is unavailable', false);
    if(attempt.task.kind==='rag.document-cleanup'){await this.cleanupDeleted(version,attempt);return {digest:version.content_hash??version.id,bytes:0};}
    if(version.deleted_at){
      const parser=(version.processing_snapshot as FileProcessingSnapshot|null)?.parser;
      if(parser&&await this.extractor.pending(attempt))await this.extractor.parse(attempt,{url:version.source_url,fileName:version.source_file_name,mimeType:version.source_mime_type},parser,async()=>{throw new ManagedExtractionError('DOCUMENT_EXTRACTION_STALE_ATTEMPT');});
      await this.cleanupDeleted(version,attempt);return {digest:version.content_hash??version.id,bytes:0};
    }
    if(attempt.task.kind==='rag.toc-refresh'){
      if(version.toc_status!=='ready')await this.retryToc(version);
      return {digest:version.content_hash??version.id,bytes:0};
    }
    if(version.status==='SUCCEEDED'&&version.toc_status==='failed')await this.retryToc(version);
    if(version.status==='SUCCEEDED')await this.cleanupRetired(version,attempt);
    if (version.status === 'SUCCEEDED') return { digest: version.content_hash ?? version.id, bytes: Number(version.source_size ?? 0) };

    if(attempt.task.attempt_no-attempt.task.resume_count>version.attempt_count)await this.update(version.id, { attempt_count: attempt.task.attempt_no-attempt.task.resume_count, last_attempt_at: new Date() });

    try {
      const snapshot = version.processing_snapshot as FileProcessingSnapshot | null;
      if(!snapshot || snapshot.version!=='file-processing' || snapshot.keyword?.mode!=='keyword')throw new RagJobError('RAG_PROFILE_UNAVAILABLE','Processing snapshot is unavailable');
      let canonical:string;
      let canonicalHash:string;
      const storedBytes=Number(version.source_size??0);
      if(version.canonical_content_uri&&version.content_hash){
        await this.extractor.acknowledgeCompleted(attempt);
        canonical=await this.loadCanonical(version.canonical_content_uri,version.content_hash);
        canonicalHash=version.content_hash;
      }else{
        if(!snapshot.parser)throw new RagJobError('DOCUMENT_EXTRACTION_SNAPSHOT_INVALID','Document parser snapshot is unavailable');
        await this.mark(version.id,'PARSING');
        const saved=await this.extractor.parse(attempt,{url:version.source_url,fileName:version.source_file_name,mimeType:version.source_mime_type},snapshot.parser,
          async(tx,result)=>this.saveExtraction(tx,version,result));
        canonical=saved.content;canonicalHash=saved.contentHash;await this.mark(version.id,'PARSED');
      }
      await this.mark(version.id,'SEGMENTING');
      const latest=await this.versions.byId(this.pool,version.id);
      let structure: DocumentStructure | undefined;
      if(latest?.toc_status!=='ready'){
        try{structure=await (this.dependencies.analyze??analyzeDocumentStructure)(canonical,{format:snapshot.format});await this.saveToc(version.id,canonicalHash,indexTocBytes(canonical,readingToc(canonical,structure.toc)));}
        catch{await this.failToc(version.id,canonicalHash,'STRUCTURE_OR_TOC_FAILED');}
      }
      await new KnowledgeIndexJobs(this.pool,this.config,this.dependencies.kb).indexSource({type:'file',id:version.id,revision:canonicalHash,userId:version.user_id,workspaceId:version.workspace_id,content:canonical,format:snapshot.format},attempt,snapshot.keyword);
      // Publication is short and fenced by the existing task lease and source record.
      await transaction(this.pool,async tx=>{
        const lease=await tx.query("SELECT id FROM tasks WHERE id=$1 AND state='running' AND lease_owner=$2 AND version=$3 AND attempt_no=$4 AND lease_until>clock_timestamp() FOR UPDATE",[attempt.task.id,attempt.owner,attempt.version,attempt.attempt]);
        const current=(await tx.query('SELECT deleted_at FROM rag_ingestion_versions WHERE id=$1 FOR UPDATE',[version.id])).rows[0];
        if(!current||current.deleted_at||!lease.rowCount)throw new RagJobError('RAG_STALE_ATTEMPT','Source deleted or task lease lost');
        await tx.query("UPDATE rag_ingestion_versions SET active=false,updated_at=now() WHERE user_id=$1 AND workspace_id=$2 AND source_url=$3 AND id<>$4 AND created_at<(SELECT created_at FROM rag_ingestion_versions WHERE id=$4)",[version.user_id,version.workspace_id,version.source_url,version.id]);
        const newer=await tx.query("SELECT id FROM rag_ingestion_versions WHERE user_id=$1 AND source_url=$2 AND created_at>(SELECT created_at FROM rag_ingestion_versions WHERE id=$3) AND active=true AND status='SUCCEEDED'",[version.user_id,version.source_url,version.id]);
        if(newer.rowCount)throw new RagJobError('RAG_STALE_ATTEMPT','A newer source revision is already indexed');
        await tx.query("UPDATE rag_ingestion_versions SET status='SUCCEEDED',current_stage='SUCCEEDED',active=true,error_code=NULL,error_message=NULL WHERE id=$1",[version.id]);
      });
      await this.cleanupRetired(version,attempt);
      return {digest:canonicalHash,bytes:storedBytes};
    } catch (error) {
      if(error instanceof ParserExecutionDeferred)throw error;
      const mapped = error instanceof RagJobError ? error : error instanceof DocumentPreparationError||error instanceof ManagedExtractionError ? new RagJobError(error.code, error.message, error.retryable, { cause: error }) : error instanceof EmbeddingError ? new RagJobError(error.code, error.message, error.retryable, { cause: error }) : error instanceof SearchIndexError ? new RagJobError(error.code, error.message, error.retryable, { cause: error }) : new RagJobError('RAG_INGEST_FAILED', error instanceof Error ? error.message : 'RAG ingestion failed', true, { cause: error });
      const latest = await this.versions.byId(this.pool, version.id);
      if(mapped.code==='RAG_STALE_ATTEMPT'){
        try{await new KnowledgeIndexJobs(this.pool,this.config,this.dependencies.kb).cleanup('file',version.id,attempt);}catch{await this.update(version.id,{cleanup_status:'failed'});throw new RagJobError('RAG_CLEANUP_FAILED','Stale index cleanup needs retry',true);}
      }
      if(latest?.status==='SUCCEEDED'){await this.update(version.id,{cleanup_status:'failed'});throw mapped;}
      await this.update(version.id, { status: 'FAILED', current_stage: 'FAILED', failed_stage: latest?.current_stage ?? version.current_stage, error_code: mapped.code, error_message: mapped.message.slice(0, 500), retryable: mapped.retryable });
      throw mapped;
    }
  }

  private async saveExtraction(tx:pg.PoolClient,version:RagVersionRow,saved:SavedExtraction){
    const current=await tx.query('SELECT id FROM rag_ingestion_versions WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND deleted_at IS NULL FOR UPDATE',[version.id,version.user_id,version.workspace_id]);
    if(!current.rowCount)throw new ManagedExtractionError('DOCUMENT_EXTRACTION_STALE_ATTEMPT');
    const doc=saved.response.results[0] as ExtractionDocument;
    await tx.query(`UPDATE rag_ingestion_versions SET canonical_content_uri=$2,raw_markdown_uri=$2,content_hash=$3,parse_artifact_uri=$4,
      asset_manifest_uri=$5,parser_provider='xberg',parser_version='kb-markdown-v1',parser_config_hash=$6,
      parser_metadata=$7::jsonb,toc=NULL,toc_status='pending',toc_error=NULL WHERE id=$1`,
      [version.id,saved.canonicalUri,saved.contentHash,saved.artifactUri,saved.manifestUri,
        saved.configHash,
        JSON.stringify({sourceResourceId:doc.source_resource_id,parseRunId:doc.parse_run_id,contentFormat:doc.content_format,requestId:saved.requestId,fingerprint:saved.fingerprint})]);
    for(const receipt of doc.kb.uploaded_resources){
      await tx.query(`INSERT INTO rag_document_assets(id,version_id,object_key,sha256,mime_type,byte_size,asset_type,page_no,metadata,
        source_asset_key,asset_ref,source_path,upload_status) VALUES($1::uuid,$2,$3,$4,$5,$6,'image',$7,$8::jsonb,$1::text,$1::text,$3,'ready')
        ON CONFLICT(id) DO NOTHING`,[receipt.resource_id,version.id,receipt.object_key,receipt.sha256,receipt.mime_type,receipt.bytes,
        typeof receipt.page_number==='number'?receipt.page_number:null,JSON.stringify(receipt)]);
      const stored=(await tx.query('SELECT version_id,sha256,object_key FROM rag_document_assets WHERE id=$1',[receipt.resource_id])).rows[0];
      if(!stored||stored.version_id!==version.id||stored.sha256!==receipt.sha256||stored.object_key!==receipt.object_key)throw new ManagedExtractionError('DOCUMENT_EXTRACTION_RESOURCE_CONFLICT');
    }
  }
  private async cleanupDeleted(version:RagVersionRow,attempt:Attempt):Promise<void>{
    await new KnowledgeIndexJobs(this.pool,this.config,this.dependencies.kb).cleanup('file',version.id,attempt);
    await this.update(version.id,{cleanup_status:'ready'});
  }
  private async cleanupRetired(version:RagVersionRow,attempt:Attempt):Promise<void>{
    const rows=(await this.pool.query<RagVersionRow>("SELECT * FROM rag_ingestion_versions WHERE user_id=$1 AND workspace_id=$2 AND source_url=$3 AND id<>$4 AND NOT active AND cleanup_status<>'ready'",[version.user_id,version.workspace_id,version.source_url,version.id])).rows;
    for(const old of rows)await this.cleanupDeleted(old,attempt);
  }

  private async loadCanonical(key: string, hash: string): Promise<string> {
    const content = utf8(await readCanonicalBytes(await this.storage.read(key)));
    if (sha256(content) !== hash) throw new RagJobError('RAG_CANONICAL_CHANGED', 'Saved body changed');
    return content;
  }
  private async retryToc(version: RagVersionRow): Promise<void> {
    const snapshot = version.processing_snapshot as FileProcessingSnapshot | null;
    if (!version.canonical_content_uri || !version.content_hash || !snapshot?.format) throw new RagJobError('RAG_TOC_NOT_AVAILABLE', 'Canonical document is unavailable');
    try {
      const content = await this.loadCanonical(version.canonical_content_uri, version.content_hash);
      const structure = await (this.dependencies.analyze ?? analyzeDocumentStructure)(content, {
        format: snapshot.format,
      });
      await this.saveToc(version.id, version.content_hash, indexTocBytes(content, readingToc(content, structure.toc)));
    } catch (error) {
      await this.failToc(version.id, version.content_hash, 'TOC_RETRY_FAILED');
      throw new RagJobError('TOC_RETRY_FAILED', 'Could not regenerate document TOC', true, { cause: error });
    }
  }
  private async saveToc(id: string, contentHash: string, toc: CanonicalTocItem[]): Promise<void> {
    if (this.dependencies.saveToc) return this.dependencies.saveToc(id, toc);
    await this.pool.query(`UPDATE rag_ingestion_versions SET toc=$3::jsonb,toc_status='ready',toc_error=NULL,updated_at=now()
      WHERE id=$1 AND content_hash=$2 AND deleted_at IS NULL AND toc_status<>'ready'`, [id, contentHash, JSON.stringify(toc)]);
  }
  private async failToc(id: string, contentHash: string, errorCode: string): Promise<void> {
    await this.pool.query(`UPDATE rag_ingestion_versions SET toc_status='failed',toc_error=$3,updated_at=now()
      WHERE id=$1 AND content_hash=$2 AND deleted_at IS NULL AND toc_status<>'ready'`, [id, contentHash, errorCode]);
  }

  private async mark(id: string, status: import('./types.js').RagStage, fields: Record<string, unknown> = {}): Promise<void> { await this.update(id, { status, current_stage: status, ...fields }); }
  private async update(id: string, fields: Record<string, unknown>): Promise<void> { const entries = Object.entries(fields).filter(([, value]) => value !== undefined); if (!entries.length) return; const values: unknown[] = [id]; const sets = entries.map(([key, value], index) => { values.push(value); return `${key}=$${index + 2}`; }); await this.pool.query(`UPDATE rag_ingestion_versions SET ${sets.join(',')},updated_at=now() WHERE id=$1`, values); }
}
