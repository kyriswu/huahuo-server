import pg from 'pg';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../config/config.js';
import type { Attempt } from '../tasks/engine.js';
import type { StoragePort } from '../storage/port.js';
import { transaction } from '../identity/store.js';
import { sha256, stableUuid } from './chunkers.js';
import { analyzeDocumentStructure } from '../../lib/document-processing/structure.js';
import { splitTextIntoChunks } from '../../lib/document-processing/splitter.js';
import { readingToc } from '../../lib/document-processing/toc.js';
import type { DocumentStructure } from '../../lib/document-processing/types.js';
import { indexChunks } from '../../lib/rag-indexing/index.js';
import { ocrHeadingRanges } from './structure-hints.js';
import { cachedEmbedding } from './embedding-cache.js';
import { createBusinessVectorStore } from './vector-store.js';
import { processingTokenizer, processingEmbedding, fileChunkKey, FILE_CHUNK_MAX_CHARS, type FileProcessingSnapshot } from './processing-profile.js';
import { indexTocBytes, type CanonicalTocItem } from './canonical-toc.js';
import type { ChildChunk, DocumentBlock, ParsedDocument } from './types.js';
import { MineruParserAdapter, MockMineruParser, MineruError, type MineruParser } from './adapters/mineru.js';
import { EmbeddingError } from './adapters/embedding.js';
import { MilvusError } from './adapters/milvus.js';
import { RagIngestionRepository, type RagVersionRow } from './repository.js';
import { DocumentPreparationError, downloadSourceBytes, prepareParsedContent, type PreparedContent, type PreparedAsset } from './document-preparation.js';

export class RagJobError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, options?: { cause?: unknown }) { super(message, options); this.name = 'RagJobError'; }
}
function mime(value: string): string { return value.split(';', 1)[0]!.trim().toLowerCase(); }
function safeName(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180) || 'document'; }
function blockForPlain(content: string): DocumentBlock[] { return [{ id: 'root', type: 'paragraph', text: content, sectionPath: [], charStart: 0, charEnd: content.length, sourceOrder: 0 }]; }
function utf8(bytes: Uint8Array): string { try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch (error) { throw new RagJobError('RAG_TEXT_NOT_UTF8', 'Plain text source is not valid UTF-8', false, { cause: error }); } }
async function readAll(stream: Readable): Promise<Uint8Array> { const parts: Buffer[] = []; for await (const chunk of stream) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return new Uint8Array(Buffer.concat(parts)); }

export class RagIngestionJobs {
  private readonly versions: RagIngestionRepository;
  constructor(readonly pool: pg.Pool, readonly config: AppConfig, readonly storage: StoragePort, private readonly dependencies:{analyze?:typeof analyzeDocumentStructure;saveToc?:(id:string,toc:CanonicalTocItem[])=>Promise<void>}={}) {
    this.versions = new RagIngestionRepository(pool, config.rag, config.appEnv, config.milvus.collection, config);
  }
  async close(): Promise<void> {}

  async execute(attempt: Attempt): Promise<{ digest: string; bytes: number }> {
    const input = (await this.pool.query('SELECT body FROM task_inputs WHERE id=$1 AND user_id=$2 AND workspace_id=$3', [attempt.task.input_id, attempt.task.user_id, attempt.task.workspace_id])).rows[0];
    if (!input) throw new RagJobError('RAG_INPUT_UNAVAILABLE', 'RAG task input is unavailable', false);
    let versionId: string;
    try { versionId = String(JSON.parse(String(input.body)).versionId); } catch (error) { throw new RagJobError('RAG_INPUT_INVALID', 'RAG task input is invalid', false, { cause: error }); }
    const version = await this.versions.byId(this.pool, versionId);
    if (!version || version.user_id !== attempt.task.user_id || version.workspace_id !== attempt.task.workspace_id) throw new RagJobError('RAG_VERSION_NOT_FOUND', 'RAG document version is unavailable', false);
    if(attempt.task.kind==='rag.document-cleanup'){await this.cleanupDeleted(version);return {digest:version.content_hash??version.id,bytes:0};}
    if(version.deleted_at){await this.cleanupDeleted(version);return {digest:version.content_hash??version.id,bytes:0};}
    if(attempt.task.kind==='rag.toc-refresh'){
      if(version.toc_status!=='ready')await this.retryToc(version);
      return {digest:version.content_hash??version.id,bytes:0};
    }
    if(version.status==='SUCCEEDED'&&version.toc_status==='failed')await this.retryToc(version);
    if(version.status==='SUCCEEDED')await this.cleanupRetired(version);
    if (version.status === 'SUCCEEDED') return { digest: version.content_hash ?? version.id, bytes: Number(version.source_size ?? 0) };

    await this.update(version.id, { attempt_count: version.attempt_count + 1, last_attempt_at: new Date() });

    try {
      const snapshot = version.processing_snapshot as FileProcessingSnapshot | null;
      if(!snapshot || snapshot.version!=='file-processing' || snapshot.split?.maxSourceChars!==FILE_CHUNK_MAX_CHARS)throw new RagJobError('RAG_PROFILE_UNAVAILABLE','Processing snapshot is unavailable');
      const tokenizer=await processingTokenizer(this.config,snapshot);
      let canonical:string;
      let canonicalHash:string;
      let ignoredHeadingRanges=version.processing_info?.ignoredHeadingRanges??[];
      let storedBytes=Number(version.source_size??0);
      if(version.canonical_content_uri&&version.content_hash){
        canonical=await this.loadCanonical(version.canonical_content_uri,version.content_hash);
        canonicalHash=version.content_hash;
      }else{
      await this.mark(version.id,'DOWNLOADING');
      const source = await this.loadSource(version);
      const sourceHash = createHash('sha256').update(source).digest('hex');
      if (version.source_object_key && version.source_sha256 && version.source_sha256 !== sourceHash) throw new RagJobError('RAG_SOURCE_CHANGED', 'Source bytes changed after the first successful download', false);
      const sourceUrl=new URL(version.source_url);
      const ownOss=this.config.storageDriver==='aliyun-oss'&&this.config.storageAliyunOss&&sourceUrl.hostname===`${this.config.storageAliyunOss.bucket}.${new URL(this.config.storageAliyunOss.endpoint).hostname}`;
      const prefix=this.config.storageAliyunOss?.keyPrefix?.replace(/\/+$/,'');
      const originalKey=decodeURIComponent(sourceUrl.pathname.replace(/^\//,''));
      const reusableKey=prefix?(originalKey.startsWith(prefix+'/')?originalKey.slice(prefix.length+1):null):originalKey;
      const sourceKey=ownOss?reusableKey:`rag/${version.id}/source/${safeName(version.source_file_name)}`;
      const stored=ownOss?{bytes:source.byteLength}:version.source_object_key&&version.source_sha256===sourceHash?await this.storage.stat(sourceKey!,version.source_mime_type):await this.storage.put(sourceKey!,Readable.from([Buffer.from(source)]),version.source_mime_type,this.config.rag.maxSourceBytes);
      await this.update(version.id, { source_sha256: sourceHash, source_size: stored.bytes, source_object_key: sourceKey });

      storedBytes=stored.bytes;
      const parsed = await this.parse(version, source,snapshot);
      const rawMarkdown = parsed.rawMarkdown ?? parsed.markdown ?? '';
      const canonicalInput = parsed.artifacts.canonicalMarkdown ?? parsed.markdown ?? rawMarkdown;
      if (version.mode === 'plain_text' && [...rawMarkdown].length > this.config.rag.plainTextMaxChars) throw new RagJobError('RAG_PLAIN_TEXT_TOO_LARGE', 'Plain text exceeds configured character limit', false);
      const prepared: PreparedContent = version.mode==='plain_text'?{canonical:rawMarkdown,assets:[]}:await this.prepareCanonical(version, parsed, canonicalInput);
      canonical=prepared.canonical;const assets=prepared.assets;
      if (version.mode === 'structured_document') ignoredHeadingRanges=ocrHeadingRanges(canonical,assets);
      if (!canonical.trim()) throw new RagJobError('RAG_SOURCE_EMPTY', 'Parsed document has no canonical content', false);
      canonicalHash = sha256(canonical);
      const canonicalKey = `rag/${version.id}/canonical/${canonicalHash}.md`;
      const savedCanonical = await this.putStable(canonicalKey, Readable.from([Buffer.from(canonical, 'utf8')]), 'text/markdown', Math.max(this.config.rag.maxSourceBytes, Buffer.byteLength(canonical)));
      if (savedCanonical.sha256 !== canonicalHash) throw new RagJobError('RAG_CANONICAL_CHANGED', 'Saved body changed');
      const rawMarkdownKey = version.mode === 'structured_document' ? `rag/${version.id}/artifacts/mineru/full.md` : undefined;
      if (rawMarkdownKey) await this.putStable(rawMarkdownKey, Readable.from([Buffer.from(rawMarkdown, 'utf8')]), 'text/markdown', Math.max(this.config.rag.maxSourceBytes, Buffer.byteLength(rawMarkdown)));
      const artifactKey = parsed.artifacts.zipBytes ? `rag/${version.id}/artifacts/mineru.zip` : parsed.artifacts.jsonText ? `rag/${version.id}/artifacts/parser-detail.json` : undefined;
      if (parsed.artifacts.zipBytes) await this.putStable(artifactKey!, Readable.from([Buffer.from(parsed.artifacts.zipBytes)]), 'application/zip', this.config.rag.maxSourceBytes);
      else if (parsed.artifacts.jsonText) await this.putStable(artifactKey!, Readable.from([Buffer.from(parsed.artifacts.jsonText, 'utf8')]), 'application/json', Math.max(this.config.rag.maxSourceBytes, Buffer.byteLength(parsed.artifacts.jsonText)));
      // Document diagnostics (including every unresolved OCR record) belong to one artifact,
      // rather than being copied into every image row. Content-addressing also fences retries.
      const assetManifest = version.mode === 'structured_document' ? JSON.stringify({ assets, diagnostics: prepared.diagnostics }) : undefined;
      const assetManifestKey = assetManifest ? `rag/${version.id}/assets/manifest-${sha256(assetManifest)}.json` : undefined;
      if (assetManifestKey && assetManifest) await this.putStable(assetManifestKey, Readable.from([Buffer.from(assetManifest, 'utf8')]), 'application/json', Math.max(this.config.rag.maxSourceBytes, Buffer.byteLength(assetManifest)));
      // Publish the canonical checkpoint only once its asset rows and diagnostics are durable.
      // A failed asset transaction must not make the next attempt skip missing assets.
      if (assets.length) await this.persistAssets(version.id, assets);
      await this.update(version.id, {
        canonical_content: version.mode === 'plain_text' ? canonical : null,
        canonical_content_uri: canonicalKey,
        enriched_canonical_markdown_uri: canonicalKey,
        raw_markdown_uri: rawMarkdownKey ?? null,
        asset_manifest_uri: assetManifestKey ?? null,
        content_hash: canonicalHash,
        toc: null,
        toc_status: 'pending',
        toc_error: null,
        processing_info:JSON.stringify({ignoredHeadingRanges}),
        parser_provider: parsed.parserProvider,
        parser_version: parsed.parserVersion,
        parser_config_hash: sha256(JSON.stringify({ provider: parsed.parserProvider, version: parsed.parserVersion, model: parsed.parserMeta?.model ?? null, ocr: version.mode === 'structured_document' })),
        parse_artifact_uri: artifactKey ?? null,
        mineru_task_id: parsed.parserMeta?.taskId ?? null,
        mineru_data_id: parsed.parserMeta?.dataId ?? null,
        mineru_trace_id: parsed.parserMeta?.traceId ?? null,
        mineru_model_version: parsed.parserMeta?.model ?? null,
        parser_metadata: JSON.stringify(parsed.parserMeta ?? {}),
      });
      await this.mark(version.id, 'PARSED');

      }
      await this.mark(version.id,'SEGMENTING');
      const latest=await this.versions.byId(this.pool,version.id);
      const existing=(await this.pool.query<ChildChunk & {embedding_status:string;index_status:string;chunk_key:string;embedding_text:string;content_hash:string;embedding_text_hash:string;heading_path:string[];token_count:number;char_start:number;char_end:number;metadata:Record<string,unknown>}>('SELECT * FROM rag_child_chunks WHERE version_id=$1 ORDER BY ordinal',[version.id])).rows;
      let structure: DocumentStructure | undefined;
      const needsToc = latest?.toc_status !== 'ready';
      if (needsToc || !existing.length) {
        try {
          structure = await (this.dependencies.analyze ?? analyzeDocumentStructure)(canonical, { format: snapshot.format, ignoreHeadingRanges: ignoredHeadingRanges });
        } catch {
          if (needsToc) await this.failToc(version.id, canonicalHash, 'STRUCTURE_OR_TOC_FAILED');
        }
        if (needsToc && structure) {
          try { await this.saveToc(version.id, canonicalHash, indexTocBytes(canonical, readingToc(canonical, structure.toc))); }
          catch { await this.failToc(version.id, canonicalHash, 'TOC_SAVE_FAILED'); }
        }
      }
      let normalizedChildren:ChildChunk[];
      if(existing.length){normalizedChildren=existing.map(row=>({...row,chunkKey:row.chunk_key,parentId:version.id,sourceType:'file',sourceRevision:canonicalHash,embeddingText:row.embedding_text,contentHash:row.content_hash,embeddingTextHash:row.embedding_text_hash,headingPath:row.heading_path,tokenCount:row.token_count,charStart:row.char_start,charEnd:row.char_end}));}
      else{
        const drafts=await splitTextIntoChunks({content:canonical,format:snapshot.format,options:{...snapshot.split,tokenizer},structureHints:structure});
        const profile=sha256(JSON.stringify({snapshot,tokenizer:tokenizer.id,hints:!!structure}));
        await this.update(version.id,{processing_info:JSON.stringify({ignoredHeadingRanges,structureHintsUsed:!!structure,tokenizerId:tokenizer.id,chunkProfile:profile,offsetUnit:'utf16',structureVersion:structure?.version??null})});
        normalizedChildren=drafts.map(d=>{
          const chunkKey=fileChunkKey(version.id,canonicalHash,profile,d.ordinal);
          return {id:stableUuid(chunkKey),chunkKey,parentId:version.id,sourceType:'file',sourceRevision:canonicalHash,ordinal:d.ordinal,content:d.content,embeddingText:d.embedding_text,contentHash:d.content_hash,embeddingTextHash:d.embedding_text_hash,headingPath:d.heading_path,tokenCount:d.token_count,charStart:d.source_start,charEnd:d.source_end,metadata:{...d.metadata,embeddingTokenCount:d.embedding_token_count,profile}};
        });
        if(!normalizedChildren.length)throw new RagJobError('RAG_SOURCE_EMPTY','Source contains no indexable content');
        await this.persistChunks(version,normalizedChildren);
      }
      await this.mark(version.id,'CHUNKED',{child_count:normalizedChildren.length});
      const readyIds=new Set(existing.filter(row=>row.index_status==='ready').map(row=>row.chunk_key));
      const pending=normalizedChildren.filter(c=>!readyIds.has(c.chunkKey!));
      const store=createBusinessVectorStore(this.config,snapshot.vectorTarget);
      try{
        if(pending.length){
          await this.mark(version.id,'EMBEDDING',{embedding_status:'running'});
          const result=await indexChunks(pending.map(c=>({id:c.chunkKey!,embeddingText:c.embeddingText,metadata:{parent_id:version.id,source_type:'file',source_revision:canonicalHash,chunk_id:c.chunkKey!,content:c.content,ordinal:c.ordinal,user_id:version.user_id,workspace_id:version.workspace_id,document_id:version.document_key,document_version:version.id,embedding_profile:version.embedding_profile,index_build_id:version.index_build_id,embedding_model:snapshot.embedding.model}})),{embeddingAdapter:cachedEmbedding(processingEmbedding(this.config,snapshot.embedding.model,snapshot.embedding.dimensions),this.storage,version.id),vectorStoreAdapter:store,tokenizer,options:{...snapshot.indexing,maxEmbeddingTokens:snapshot.split.maxEmbeddingTokens}});
          for(const item of result.items)await this.pool.query("UPDATE rag_child_chunks SET embedding_status=$3,index_status=$3,milvus_id=$2,error_code=$4,updated_at=now() WHERE version_id=$1 AND chunk_key=$2",[version.id,item.id,item.status==='indexed'?'ready':'failed',item.errorCode??null]);
          if(result.failedCount)throw new RagJobError('RAG_INDEX_PARTIAL_FAILURE','Some index batches failed',true);
        }
      }finally{await store.close();}
      // Publication is short and fenced by the existing task lease and source record.
      await transaction(this.pool,async tx=>{
        const current=(await tx.query('SELECT deleted_at FROM rag_ingestion_versions WHERE id=$1 FOR UPDATE',[version.id])).rows[0];
        const lease=await tx.query("SELECT id FROM tasks WHERE id=$1 AND state='running' AND lease_owner=$2 AND version=$3 AND lease_until>now()",[attempt.task.id,attempt.owner,attempt.version]);
        if(!current||current.deleted_at||!lease.rowCount)throw new RagJobError('RAG_STALE_ATTEMPT','Source deleted or task lease lost');
        await tx.query("UPDATE rag_ingestion_versions SET active=false,updated_at=now() WHERE user_id=$1 AND workspace_id=$2 AND source_url=$3 AND id<>$4 AND created_at<(SELECT created_at FROM rag_ingestion_versions WHERE id=$4)",[version.user_id,version.workspace_id,version.source_url,version.id]);
        const newer=await tx.query("SELECT id FROM rag_ingestion_versions WHERE user_id=$1 AND source_url=$2 AND created_at>(SELECT created_at FROM rag_ingestion_versions WHERE id=$3) AND active=true AND status='SUCCEEDED'",[version.user_id,version.source_url,version.id]);
        if(newer.rowCount)throw new RagJobError('RAG_STALE_ATTEMPT','A newer source revision is already indexed');
        await tx.query("UPDATE rag_ingestion_versions SET status='SUCCEEDED',current_stage='SUCCEEDED',embedding_status='ready',index_status='ready',active=true,child_count=$2,error_code=NULL,error_message=NULL WHERE id=$1",[version.id,normalizedChildren.length]);
      });
      await this.cleanupRetired(version);
      return {digest:canonicalHash,bytes:storedBytes};
    } catch (error) {
      const mapped = error instanceof RagJobError ? error : error instanceof MineruError ? new RagJobError(error.code, error.message, error.retryable, { cause: error }) : error instanceof EmbeddingError ? new RagJobError(error.code, error.message, error.retryable, { cause: error }) : error instanceof MilvusError ? new RagJobError(error.code, error.message, error.retryable, { cause: error }) : new RagJobError('RAG_INGEST_FAILED', error instanceof Error ? error.message : 'RAG ingestion failed', true, { cause: error });
      const latest = await this.versions.byId(this.pool, version.id);
      if(mapped.code==='RAG_STALE_ATTEMPT'){
        try{await this.removeVersionVectors(version);}catch{await this.update(version.id,{cleanup_status:'failed'});throw new RagJobError('RAG_CLEANUP_FAILED','Stale index cleanup needs retry',true);}
      }
      if(latest?.status==='SUCCEEDED'){await this.update(version.id,{cleanup_status:'failed'});throw mapped;}
      await this.update(version.id, { status: 'FAILED', current_stage: 'FAILED', failed_stage: latest?.current_stage ?? version.current_stage, error_code: mapped.code, error_message: mapped.message.slice(0, 500), retryable: mapped.retryable, active: false });
      throw mapped;
    }
  }

  private async removeVersionVectors(version:RagVersionRow):Promise<void>{
    if(!version.processing_snapshot)throw new RagJobError('RAG_TARGET_SNAPSHOT_UNAVAILABLE','Original vector target has no snapshot');
    const snapshot=version.processing_snapshot as FileProcessingSnapshot;
    const ids=(await this.pool.query<{chunk_key:string}>('SELECT chunk_key FROM rag_child_chunks WHERE version_id=$1',[version.id])).rows.map(c=>c.chunk_key);
    const store=createBusinessVectorStore(this.config,snapshot.vectorTarget);
    try{for(let offset=0;offset<ids.length;offset+=128)await store.delete({ids:ids.slice(offset,offset+128)});}finally{await store.close();}
  }
  private async cleanupDeleted(version:RagVersionRow):Promise<void>{
    if(!version.deleted_at)throw new RagJobError('RAG_DELETE_NOT_CONFIRMED','Source remains active');
    await this.removeVersionVectors(version);await this.update(version.id,{cleanup_status:'deleted'});
  }
  private async cleanupRetired(version:RagVersionRow):Promise<void>{
    const retired=(await this.pool.query<RagVersionRow>("SELECT * FROM rag_ingestion_versions WHERE user_id=$1 AND source_url=$2 AND id<>$3 AND active=false AND created_at<(SELECT created_at FROM rag_ingestion_versions WHERE id=$3) AND cleanup_status NOT IN ('ready','deleted')",[version.user_id,version.source_url,version.id])).rows;
    for(const old of retired){
      await this.removeVersionVectors(old);await this.update(old.id,{cleanup_status:'ready'});
    }
    await this.update(version.id,{cleanup_status:'ready'});
  }

  private async loadCanonical(key: string, hash: string): Promise<string> {
    const content = utf8(await readAll(await this.storage.read(key)));
    if (sha256(content) !== hash) throw new RagJobError('RAG_CANONICAL_CHANGED', 'Saved body changed');
    return content;
  }
  private async retryToc(version: RagVersionRow): Promise<void> {
    const snapshot = version.processing_snapshot as FileProcessingSnapshot | null;
    if (!version.canonical_content_uri || !version.content_hash || !snapshot?.format) throw new RagJobError('RAG_TOC_NOT_AVAILABLE', 'Canonical document is unavailable');
    try {
      const content = await this.loadCanonical(version.canonical_content_uri, version.content_hash);
      const structure = await (this.dependencies.analyze ?? analyzeDocumentStructure)(content, {
        format: snapshot.format, ignoreHeadingRanges: version.processing_info?.ignoredHeadingRanges ?? [],
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

  private async loadSource(version: RagVersionRow): Promise<Uint8Array> {
    if (version.source_object_key) { try { return await readAll(await this.storage.read(version.source_object_key)); } catch { /* fall through to source URL */ } }
    return this.download(version.source_url);
  }
  private async download(sourceUrl: string): Promise<Uint8Array> {
    try { return (await downloadSourceBytes(sourceUrl, this.config)).bytes; }
    catch (error) {
      if (error instanceof DocumentPreparationError) throw new RagJobError(error.code, error.message, error.retryable);
      throw error;
    }
  }
  private async parse(version: RagVersionRow, source: Uint8Array,snapshot:FileProcessingSnapshot): Promise<ParsedDocument> {
    if (version.mode === 'plain_text') { const content = utf8(source); return { source: { fileName: version.source_file_name, mimeType: mime(version.source_mime_type), sha256: createHash('sha256').update(source).digest('hex') }, blocks: blockForPlain(content), markdown: content, rawMarkdown: content, artifacts: {}, parserProvider: 'server-text', parserVersion: 'text' }; }
    let parser: MineruParser;
    if (this.config.rag.providerMode === 'mock') parser = new MockMineruParser();
    else {
      if(snapshot.parser.baseUrl!==this.config.rag.mineruBaseUrl)throw new RagJobError('RAG_PARSER_TARGET_CHANGED','Original parser endpoint is unavailable');
      if (!this.config.rag.mineruToken) throw new RagJobError('RAG_MINERU_CONFIG_MISSING', 'MinerU token is not configured', false);
      parser = new MineruParserAdapter({ baseUrl: snapshot.parser.baseUrl, token: this.config.rag.mineruToken, model: snapshot.parser.model, pollIntervalMs: snapshot.parser.pollIntervalMs, timeoutMs: snapshot.parser.timeoutMs });
    }
    await this.mark(version.id, 'PARSE_SUBMITTED');
    const parsed = await parser.parse({ ossUrl: version.source_url, fileName: version.source_file_name, mimeType: version.source_mime_type, sourceBytes: source });
    await this.mark(version.id, 'PARSING', { mineru_trace_id: parsed.parserMeta?.traceId ?? null, mineru_task_id: parsed.parserMeta?.taskId ?? null, mineru_data_id: parsed.parserMeta?.dataId ?? null, mineru_model_version: parsed.parserMeta?.model ?? null });
    return parsed;
  }
  private async prepareCanonical(version: RagVersionRow, parsed: ParsedDocument, rawMarkdown: string): Promise<PreparedContent> {
    if (version.mode !== 'structured_document') return { canonical: rawMarkdown, assets: [] };
    try { return await prepareParsedContent(parsed, { storage: this.storage, prefix: `rag/${version.id}/assets`, identity: version.id, rawMarkdown }); }
    catch (error) {
      if (error instanceof DocumentPreparationError) throw new RagJobError(error.code, error.message, error.retryable);
      throw error;
    }
  }
  private async putStable(key: string, input: Readable, mimeType: string, maxBytes: number) {
    try { return await this.storage.stat(key, mimeType); }
    catch { return this.storage.put(key, input, mimeType, maxBytes); }
  }
  private async persistAssets(versionId: string, rows: PreparedAsset[]): Promise<void> {
    await transaction(this.pool, async (tx) => {
      await tx.query('DELETE FROM rag_document_assets WHERE version_id=$1', [versionId]);
      for (const row of rows) {
        await tx.query('INSERT INTO rag_document_assets(id,version_id,object_key,sha256,mime_type,byte_size,asset_type,page_no,source_block_id,char_start,char_end,caption,alt_text,metadata,source_asset_key,asset_ref,source_path,upload_status,ocr_text,caption_text,enrichment_status,enrichment_provider,enrichment_source,enrichment_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)', [row.id, versionId, row.objectKey, row.sha256, row.mimeType, row.byteSize, row.assetType, row.pageNo, row.sourceBlockId, row.charStart, row.charEnd, row.caption, row.altText, JSON.stringify(row.metadata), row.sourceAssetKey, row.assetRef, row.sourcePath, row.uploadStatus, row.ocrText, row.captionText, row.enrichmentStatus, row.enrichmentProvider, row.enrichmentSource, row.enrichmentHash]);
      }
    });
  }
  private async persistChunks(version:RagVersionRow,children:ChildChunk[]):Promise<void>{
    await transaction(this.pool,async tx=>{
      for(const c of children)await tx.query(`INSERT INTO rag_child_chunks(id,version_id,ordinal,ordinal_global,content,embedding_text,content_hash,embedding_text_hash,heading_path,token_count,char_start,char_end,embedding_model,embedding_dimension,metadata,document_key,chunk_key,chunk_profile,chunk_count,embedding_profile,index_build_id,char_count,source_type,source_revision,embedding_token_count)
        VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,'langchain-child',$17,$18,$19,char_length($4),'file',$20,$21) ON CONFLICT(version_id,ordinal) DO NOTHING`,[c.id,version.id,c.ordinal,c.content,c.embeddingText,c.contentHash,c.embeddingTextHash,JSON.stringify(c.headingPath),c.tokenCount,c.charStart,c.charEnd,version.embedding_model,version.embedding_dimension,JSON.stringify(c.metadata),version.document_key,c.chunkKey,children.length,version.embedding_profile,version.index_build_id,c.sourceRevision,c.metadata.embeddingTokenCount]);
    });
  }
  private async mark(id: string, status: import('./types.js').RagStage, fields: Record<string, unknown> = {}): Promise<void> { await this.update(id, { status, current_stage: status, ...fields }); }
  private async update(id: string, fields: Record<string, unknown>): Promise<void> { const entries = Object.entries(fields).filter(([, value]) => value !== undefined); if (!entries.length) return; const values: unknown[] = [id]; const sets = entries.map(([key, value], index) => { values.push(value); return `${key}=$${index + 2}`; }); await this.pool.query(`UPDATE rag_ingestion_versions SET ${sets.join(',')},updated_at=now() WHERE id=$1`, values); }
}
