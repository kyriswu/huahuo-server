import { assertTextEncoding } from './policy.js';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import { splitTextIntoChunks } from '../../lib/document-processing/splitter.js';
import type { ChunkDraft, TokenCounter } from '../../lib/document-processing/types.js';
import { deleteVectors, indexChunks, type BoundVectorStoreAdapter, type EmbeddingAdapter } from '../../lib/rag-indexing/index.js';
import { transaction } from '../identity/store.js';
import { prepareFileText } from '../rag/document-preparation.js';
import { cachedEmbedding } from '../rag/embedding-cache.js';
import { processingEmbedding, processingTokenizer, type FileProcessingSnapshot } from '../rag/processing-profile.js';
import { createBusinessVectorStore } from '../rag/vector-store.js';
import { storageFor } from '../storage/port.js';
import type { Attempt } from '../tasks/engine.js';
import { TextIngestionSourceType, type TextIngestionStatus } from './types.js';

const hash = (content: string) => createHash('sha256').update(content).digest('hex');
type Store = BoundVectorStoreAdapter & { close?: () => Promise<void> };
export class TextIngestionError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); this.name = 'TextIngestionError'; }
}
export interface PreparedTextSource { content: string; format: 'text' | 'markdown'; artifactUri?: string; }
export interface TextIngestionJobRow {
  id: string; workspace_id: string; created_by: string; source_type: TextIngestionSourceType;
  raw_content: string | null; origin_resource_uri: string | null; ingest_status: TextIngestionStatus;
  error_msg: string | null; current_task_id: string; active_task_id: string | null;
  content_hash: string | null; artifact_uri: string | null;
}
interface TextChunkRow {
  chunk_key: string; ordinal: number; content: string; embedding_text: string;
  content_hash: string; embedding_text_hash: string; index_status: 'pending' | 'ready' | 'failed';
}
export interface TextIngestionDependencies {
  prepareSource?: (job: Readonly<TextIngestionJobRow>, snapshot: FileProcessingSnapshot) => Promise<PreparedTextSource>;
  vectorStore?: (snapshot: FileProcessingSnapshot) => Store;
  embedding?: (snapshot: FileProcessingSnapshot) => EmbeddingAdapter;
  tokenizer?: (snapshot: FileProcessingSnapshot) => TokenCounter | Promise<TokenCounter>;
}

/** Business orchestration over the existing Task lease and the shared RAG core. */
export class TextIngestionJobs {
  constructor(readonly pool: pg.Pool, readonly config: AppConfig, private readonly dependencies: TextIngestionDependencies = {}) {}
  async close(): Promise<void> {}
  private store(snapshot: FileProcessingSnapshot): Store {
    return this.dependencies.vectorStore?.(snapshot) ?? createBusinessVectorStore(this.config, snapshot.vectorTarget);
  }
  private async current(tx: pg.PoolClient, id: string, attempt: Attempt): Promise<TextIngestionJobRow> {
    const row = (await tx.query<TextIngestionJobRow>(`SELECT j.* FROM text_ingestion_jobs j
      JOIN workspaces w ON w.id=j.workspace_id AND w.user_id=j.created_by AND w.state='ready'
      JOIN users u ON u.id=j.created_by AND u.status='active' AND u.deleted_at IS NULL
      JOIN tasks t ON t.id=j.current_task_id AND t.user_id=j.created_by AND t.workspace_id=j.workspace_id
      WHERE j.id=$1 AND j.workspace_id=$2 AND j.created_by=$3 AND j.current_task_id=$4
        AND t.kind='text.ingest' AND t.state='running' AND t.lease_owner=$5 AND t.version=$6
        AND t.attempt_no=$7 AND t.lease_until>now() FOR UPDATE OF j`,
    [id, attempt.task.workspace_id, attempt.task.user_id, attempt.task.id, attempt.owner, attempt.version, attempt.attempt])).rows[0];
    if (!row) throw new TextIngestionError('TEXT_INGESTION_STALE_ATTEMPT');
    // The source row is always locked first. Recheck and lock the lease next so
    // recovery cannot revoke it between this check and a publication/write.
    const lease = await tx.query(`SELECT id FROM tasks WHERE id=$1 AND user_id=$2 AND workspace_id=$3
      AND kind='text.ingest' AND state='running' AND lease_owner=$4 AND version=$5
      AND attempt_no=$6 AND lease_until>now() FOR SHARE`,
    [attempt.task.id, row.created_by, row.workspace_id, attempt.owner, attempt.version, attempt.attempt]);
    if (!lease.rowCount) throw new TextIngestionError('TEXT_INGESTION_STALE_ATTEMPT');
    return row;
  }
  private async stage(id: string, attempt: Attempt, stage: TextIngestionStatus): Promise<void> {
    await transaction(this.pool, async tx => {
      await this.current(tx, id, attempt);
      await tx.query('UPDATE text_ingestion_jobs SET ingest_status=$2,error_msg=NULL,updated_at=now() WHERE id=$1 AND current_task_id=$3', [id, stage, attempt.task.id]);
    });
  }
  private async prepare(job: TextIngestionJobRow, snapshot: FileProcessingSnapshot): Promise<PreparedTextSource> {
    if (job.source_type === TextIngestionSourceType.MANUAL_INPUT) {
      if (job.raw_content === null) throw new TextIngestionError('TEXT_INGESTION_CONTENT_EMPTY');
      return { content: job.raw_content, format: snapshot.format };
    }
    if (this.dependencies.prepareSource) return this.dependencies.prepareSource(job, snapshot);
    if (job.source_type !== TextIngestionSourceType.FILE_UPLOAD) throw new TextIngestionError('TEXT_SOURCE_ADAPTER_UNAVAILABLE');
    if (!job.origin_resource_uri) throw new TextIngestionError('TEXT_INGESTION_ORIGIN_INVALID');
    return prepareFileText(this.config, storageFor(this.config), { id: job.id, uri: job.origin_resource_uri });
  }
  private async saveDrafts(job: TextIngestionJobRow, attempt: Attempt, drafts: readonly ChunkDraft[], batchSize: number): Promise<void> {
    for (let offset = 0; offset < drafts.length; offset += batchSize) {
      await transaction(this.pool, async tx => {
        await this.current(tx, job.id, attempt);
        for (const draft of drafts.slice(offset, offset + batchSize)) {
          if (job.raw_content!.slice(draft.source_start, draft.source_end) !== draft.content) throw new TextIngestionError('TEXT_INGESTION_OFFSET_INVALID');
          const key = 'text-' + hash(JSON.stringify([job.id, attempt.task.id, draft.ordinal, draft.content_hash]));
          await tx.query(`INSERT INTO text_ingestion_chunks
            (chunk_key,parent_id,task_id,ordinal,content,embedding_text,content_hash,embedding_text_hash,source_hash,heading_path,
             source_start,source_end,char_count,token_count,embedding_token_count,index_status)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,'pending')
            ON CONFLICT(task_id,ordinal) DO NOTHING`,
          [key, job.id, attempt.task.id, draft.ordinal, draft.content, draft.embedding_text, draft.content_hash,
            draft.embedding_text_hash, job.content_hash, JSON.stringify(draft.heading_path), draft.source_start, draft.source_end,
            draft.char_count, draft.token_count, draft.embedding_token_count]);
        }
      });
    }
  }
  private snapshot(value: unknown): FileProcessingSnapshot {
    if (!value || typeof value !== 'object') throw new TextIngestionError('TEXT_INGESTION_SNAPSHOT_INVALID');
    const snapshot = value as FileProcessingSnapshot;
    if (snapshot.version !== 'file-processing' || !snapshot.vectorTarget?.database || !snapshot.vectorTarget.collection ||
      !snapshot.embedding?.model || !Number.isInteger(snapshot.embedding.dimensions) || snapshot.embedding.dimensions < 1 ||
      !snapshot.indexing || !Number.isInteger(snapshot.indexing.batchSize) || snapshot.indexing.batchSize < 1 || snapshot.indexing.batchSize > 512 ||
      !snapshot.split || !['text','markdown'].includes(snapshot.format)) throw new TextIngestionError('TEXT_INGESTION_SNAPSHOT_INVALID');
    return snapshot;
  }
  private async removeTaskBuild(job: TextIngestionJobRow, taskId: string, snapshot: FileProcessingSnapshot): Promise<void> {
    const store = this.store(snapshot);
    try {
      // The execution scope includes vectors whose upsert completed before its
      // PostgreSQL acknowledgement. Chunk IDs alone cannot find those rows.
      const deleted = await deleteVectors(store, { scope: { source_type: 'text', parent_id: job.id,
        index_build_id: taskId, user_id: job.created_by, workspace_id: job.workspace_id } }, snapshot.indexing);
      if (deleted.status !== 'deleted') throw new TextIngestionError('TEXT_INDEX_CLEANUP_FAILED', true);
      await this.pool.query('DELETE FROM text_ingestion_chunks WHERE parent_id=$1 AND task_id=$2', [job.id, taskId]);
    } finally { await store.close?.(); }
  }
  private async cleanupStale(job: TextIngestionJobRow, attempt: Attempt, snapshot: FileProcessingSnapshot): Promise<void> {
    const latest = (await this.pool.query<{ current_task_id: string; active_task_id: string | null }>(
      'SELECT current_task_id,active_task_id FROM text_ingestion_jobs WHERE id=$1 AND created_by=$2 AND workspace_id=$3',
      [job.id, job.created_by, job.workspace_id])).rows[0];
    // A lost lease can belong to another attempt of this same execution. It
    // retains ownership of its stable keys. An old active index also stays live
    // until a successful replacement publishes and cleans it in its own scope.
    if (latest?.active_task_id === attempt.task.id || latest?.current_task_id === attempt.task.id) return;
    await this.removeTaskBuild(job, attempt.task.id, snapshot);
  }
  private async cleanup(job: TextIngestionJobRow, attempt: Attempt): Promise<void> {
    const retired = await transaction(this.pool, async tx => {
      await this.current(tx, job.id, attempt);
      // Capture a fixed retirement set while this source and lease are locked.
      // A later editor's new task must never enter an old attempt's cleanup.
      return (await tx.query<{ task_id: string; body: string }>(`SELECT t.id AS task_id,i.body FROM text_ingestion_jobs j
        JOIN tasks t ON t.user_id=j.created_by AND t.workspace_id=j.workspace_id AND t.kind='text.ingest'
        JOIN task_inputs i ON i.id=t.input_id AND i.user_id=t.user_id AND i.workspace_id=t.workspace_id
        WHERE j.id=$1 AND j.current_task_id=$2 AND j.active_task_id=$2 AND t.id<>$2
          AND CASE WHEN i.body IS JSON OBJECT THEN i.body::jsonb->>'jobId' END=j.id::text
        ORDER BY t.created_at,t.id`, [job.id, attempt.task.id])).rows;
    });
    for (const old of retired) {
      let input: { jobId?: string; snapshot?: unknown };
      try { input = JSON.parse(old.body) as typeof input; } catch { throw new TextIngestionError('TEXT_INGESTION_SNAPSHOT_INVALID'); }
      if (input.jobId !== job.id) throw new TextIngestionError('TEXT_INGESTION_SNAPSHOT_INVALID');
      await this.removeTaskBuild(job, old.task_id, this.snapshot(input.snapshot));
    }
  }
  async execute(attempt: Attempt): Promise<{ digest: string; bytes: number }> {
    const rawInput = (await this.pool.query<{ body: string }>('SELECT body FROM task_inputs WHERE id=$1 AND user_id=$2 AND workspace_id=$3', [attempt.task.input_id, attempt.task.user_id, attempt.task.workspace_id])).rows[0];
    let input: { jobId?: string; snapshot?: unknown };
    try { input = JSON.parse(rawInput?.body ?? '') as typeof input; } catch { throw new TextIngestionError('TEXT_INGESTION_INPUT_INVALID'); }
    if (!input.jobId || typeof input.jobId !== 'string') throw new TextIngestionError('TEXT_INGESTION_INPUT_INVALID');
    const snapshot = this.snapshot(input.snapshot);
    let job = await transaction(this.pool, tx => this.current(tx, input.jobId!, attempt));
    let store: Store | undefined;
    try {
      if (job.active_task_id === attempt.task.id && job.ingest_status === 'success' && job.content_hash && job.raw_content !== null) {
        await this.cleanup(job, attempt);
        return { digest: job.content_hash, bytes: Buffer.byteLength(job.raw_content, 'utf8') };
      }
      const tokenizer = await (this.dependencies.tokenizer?.(snapshot) ?? processingTokenizer(this.config, snapshot));
      if (job.raw_content === null || job.content_hash === null) {
        await this.stage(job.id, attempt, job.source_type === TextIngestionSourceType.MANUAL_INPUT ? 'chunking' : 'parsing');
        const prepared = await this.prepare(job, snapshot);
        if (typeof prepared.content !== 'string' || !prepared.content.trim()) throw new TextIngestionError('TEXT_INGESTION_CONTENT_EMPTY');
        if (job.source_type === TextIngestionSourceType.MANUAL_INPUT && Array.from(prepared.content).length > this.config.rag.plainTextMaxChars) throw new TextIngestionError('TEXT_INGESTION_CONTENT_TOO_LARGE');
        assertTextEncoding(prepared.content);
        const contentHash = hash(prepared.content);
        await transaction(this.pool, async tx => {
          await this.current(tx, job.id, attempt);
          await tx.query('UPDATE text_ingestion_jobs SET raw_content=$2,content_hash=$3,artifact_uri=$4,ingest_status=\'chunking\',error_msg=NULL,updated_at=now() WHERE id=$1 AND current_task_id=$5', [job.id, prepared.content, contentHash, prepared.artifactUri ?? null, attempt.task.id]);
        });
        job = { ...job, raw_content: prepared.content, content_hash: contentHash, artifact_uri: prepared.artifactUri ?? null };
      }
      if (job.raw_content === null || job.content_hash !== hash(job.raw_content) || !job.raw_content.trim()) throw new TextIngestionError('TEXT_INGESTION_SOURCE_CHANGED');
      if (job.source_type === TextIngestionSourceType.MANUAL_INPUT && Array.from(job.raw_content).length > this.config.rag.plainTextMaxChars) throw new TextIngestionError('TEXT_INGESTION_CONTENT_TOO_LARGE');
      assertTextEncoding(job.raw_content);
      await this.stage(job.id, attempt, 'chunking');
      const existing = (await this.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM text_ingestion_chunks WHERE parent_id=$1 AND task_id=$2', [job.id, attempt.task.id])).rows[0]?.count ?? 0;
      // Deterministic drafts repair partially persisted batches after a restart.
      // Existing successful chunks retain their state through ON CONFLICT.
      const drafts = await splitTextIntoChunks({ content: job.raw_content, format: snapshot.format, options: { ...snapshot.split, tokenizer, respectSections: false } });
      if (!drafts.length) throw new TextIngestionError('TEXT_INGESTION_CONTENT_EMPTY');
      if (existing < drafts.length) await this.saveDrafts(job, attempt, drafts, snapshot.indexing.batchSize);
      const chunks = (await this.pool.query<TextChunkRow>('SELECT chunk_key,ordinal,content,embedding_text,content_hash,embedding_text_hash,index_status FROM text_ingestion_chunks WHERE parent_id=$1 AND task_id=$2 ORDER BY ordinal', [job.id, attempt.task.id])).rows;
      if (chunks.length !== drafts.length || chunks.some((chunk, i) => chunk.ordinal !== i || chunk.content_hash !== drafts[i]?.content_hash)) throw new TextIngestionError('TEXT_INGESTION_CHUNKS_CHANGED');
      await this.stage(job.id, attempt, 'embedding');
      const pending = chunks.filter(chunk => chunk.index_status !== 'ready');
      if (pending.length) {
        store = this.store(snapshot);
        const raw = this.dependencies.embedding?.(snapshot) ?? processingEmbedding(this.config, snapshot.embedding.model, snapshot.embedding.dimensions);
        if (raw.model !== snapshot.embedding.model || raw.dimensions !== snapshot.embedding.dimensions) throw new TextIngestionError('TEXT_EMBEDDING_PROFILE_MISMATCH');
        const embedder = raw;
        const result = await indexChunks(pending.map(chunk => ({ id: chunk.chunk_key, embeddingText: chunk.embedding_text, metadata: {
          parent_id: job.id, source_type: 'text', source_revision: job.content_hash!, chunk_id: chunk.chunk_key,
          content: chunk.content, ordinal: chunk.ordinal, user_id: job.created_by, workspace_id: job.workspace_id,
          document_id: job.id, document_version: attempt.task.id, index_build_id: attempt.task.id,
          embedding_profile: snapshot.embedding.profile, embedding_model: snapshot.embedding.model,
        } })), { embeddingAdapter: snapshot.providerMode === 'live' && !this.dependencies.embedding ? cachedEmbedding(embedder, storageFor(this.config), attempt.task.id) : embedder,
          vectorStoreAdapter: store, tokenizer, options: { ...snapshot.indexing, maxEmbeddingTokens: snapshot.split.maxEmbeddingTokens } });
        for (let offset = 0; offset < result.items.length; offset += snapshot.indexing.batchSize) {
          await transaction(this.pool, async tx => {
            await this.current(tx, job.id, attempt);
            for (const item of result.items.slice(offset, offset + snapshot.indexing.batchSize)) await tx.query('UPDATE text_ingestion_chunks SET index_status=$4 WHERE parent_id=$1 AND task_id=$2 AND chunk_key=$3', [job.id, attempt.task.id, item.id, item.status === 'indexed' ? 'ready' : 'failed']);
          });
        }
        if (result.failedCount) throw new TextIngestionError('TEXT_INDEX_PARTIAL_FAILURE', result.items.some(item => item.retryable));
      }
      await transaction(this.pool, async tx => {
        await this.current(tx, job.id, attempt);
        const incomplete = await tx.query('SELECT 1 FROM text_ingestion_chunks WHERE parent_id=$1 AND task_id=$2 AND index_status<>\'ready\' LIMIT 1', [job.id, attempt.task.id]);
        if (incomplete.rowCount) throw new TextIngestionError('TEXT_INDEX_PARTIAL_FAILURE', true);
        await tx.query('UPDATE text_ingestion_jobs SET active_task_id=$2,ingest_status=\'success\',error_msg=NULL,updated_at=now() WHERE id=$1 AND current_task_id=$2', [job.id, attempt.task.id]);
      });
      // Publication is durable before cleanup; cleanup retries keep the new index readable.
      await this.cleanup(job, attempt);
      return { digest: job.content_hash, bytes: Buffer.byteLength(job.raw_content, 'utf8') };
    } catch (error) {
      const candidate = error && typeof error === 'object' ? error as { code?: unknown; retryable?: unknown; statusCode?: unknown } : {};
      const code = typeof candidate.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/u.test(candidate.code) ? candidate.code : 'TEXT_INGESTION_FAILED';
      const retryable = typeof candidate.retryable === 'boolean' ? candidate.retryable : typeof candidate.statusCode === 'number' ? candidate.statusCode === 429 || candidate.statusCode >= 500 : true;
      let superseded = code === 'TEXT_INGESTION_STALE_ATTEMPT';
      await transaction(this.pool, async tx => {
        try { await this.current(tx, job.id, attempt); }
        catch (stale) { if (stale instanceof TextIngestionError) { superseded = true; return; } throw stale; }
        await tx.query(`UPDATE text_ingestion_jobs SET ingest_status=CASE WHEN active_task_id=$2 AND ingest_status='success' THEN 'success' ELSE 'failed' END,
          error_msg=CASE WHEN active_task_id=$2 AND ingest_status='success' THEN NULL ELSE $3 END,updated_at=now() WHERE id=$1 AND current_task_id=$2`, [job.id, attempt.task.id, code]);
      });
      if (superseded) {
        try { await this.cleanupStale(job, attempt, snapshot); }
        catch { throw new TextIngestionError('TEXT_STALE_CLEANUP_FAILED', true); }
      }
      throw error instanceof TextIngestionError ? error : new TextIngestionError(code, retryable);
    } finally { await store?.close?.(); }
  }
}
