import pg from 'pg';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppConfig } from '../../config/config.js';
import type { Attempt } from '../tasks/engine.js';
import { analyzeDocumentStructure } from '../../lib/document-processing/structure.js';
import { readingToc } from '../../lib/document-processing/toc.js';
import { indexChunks, deleteVectors, type IndexRecord, type BoundVectorStoreAdapter } from '../../lib/rag-indexing/index.js';
import { DeterministicEmbeddingClient, OpenAICompatibleEmbeddingClient } from '../rag/adapters/embedding.js';
import { cachedEmbedding } from '../rag/embedding-cache.js';
import { storageFor } from '../storage/port.js';
import { createBusinessVectorStore } from '../rag/vector-store.js';
import { manualTokenizer, NOTE_CHUNK_MAX_CHARS, NOTE_CHUNK_TARGET_CHARS, type ManualTextSnapshot } from './profile.js';
import { planNoteChunks, type IndexedNoteChunk } from './delta.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class ManualTextJobError extends Error {
  constructor(readonly code: string, readonly retryable = false) {
    super(code);
    this.name = 'ManualTextJobError';
  }
}

interface IndexJob {
  idempotency_key: string;
  workspace_id: string;
  document_id: string;
  document_version: string;
  canonical_content: string;
  content_hash: string;
  task_id: string;
  planned: boolean;
  processing_snapshot: ManualTextSnapshot;
}

interface IndexState {
  canonical_content: string;
  processing_snapshot: ManualTextSnapshot;
  pending_delete_ids: string[];
}

interface StoredChunk {
  chunk_id: string;
  block_id: string;
  start_offset: number;
  end_offset: number;
  core_start: number;
  core_end: number;
  text: string;
  embedding_text: string;
  index_status: 'pending' | 'ready' | 'failed';
}

export interface ManualTextJobDependencies {
  vectorStore?: (snapshot: ManualTextSnapshot) => BoundVectorStoreAdapter & { close?: () => Promise<void> };
}

async function inTransaction<T>(client: pg.Client, operation: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await operation();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

function leaseParameters(attempt: Attempt): unknown[] {
  return [attempt.task.id, attempt.task.workspace_id, attempt.task.user_id, attempt.owner, attempt.version, attempt.attempt];
}

function sameTarget(left: ManualTextSnapshot['vectorTarget'], right: ManualTextSnapshot['vectorTarget']): boolean {
  return left.connectionId === right.connectionId && left.database === right.database &&
    left.collection === right.collection && left.partition === right.partition;
}

/** Updates the current Note index in place, with a durable plan for each task. */
export class ManualTextIngestionJobs {
  constructor(readonly pool: pg.Pool, readonly config: AppConfig, private readonly dependencies: ManualTextJobDependencies = {}) {}
  async close(): Promise<void> {}

  private store(snapshot: ManualTextSnapshot) {
    return this.dependencies.vectorStore?.(snapshot) ?? createBusinessVectorStore(this.config, snapshot.vectorTarget);
  }

  private async withNoteLock<T>(noteId: string, attempt: Attempt, operation: (client: pg.Client) => Promise<T>): Promise<T> {
    // A dedicated session leaves the worker pool free to renew task leases.
    const client = new pg.Client(this.pool.options);
    client.on('error', () => undefined);
    const key = 'note-index:' + noteId;
    try {
      await client.connect();
      for (;;) {
        const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [key]);
        if (lock.rows[0]?.locked) break;
        const lease = await client.query(`SELECT 1 FROM tasks WHERE id=$1 AND workspace_id=$2 AND user_id=$3
          AND state='running' AND lease_owner=$4 AND version=$5 AND attempt_no=$6 AND lease_until>clock_timestamp()`, leaseParameters(attempt));
        if (!lease.rowCount) throw new ManualTextJobError('INGEST_LEASE_LOST', true);
        await delay(100);
      }
      return await operation(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async jobFor(client: pg.Pool | pg.Client, attempt: Attempt): Promise<IndexJob> {
    const row = (await client.query<IndexJob>('SELECT * FROM note_index_jobs WHERE task_id=$1 AND workspace_id=$2', [attempt.task.id, attempt.task.workspace_id])).rows[0];
    if (!row?.processing_snapshot || row.canonical_content === null) throw new ManualTextJobError('INGEST_SNAPSHOT_UNAVAILABLE');
    return row;
  }

  private async stateFor(client: pg.Client, noteId: string, workspaceId: string): Promise<IndexState | undefined> {
    return (await client.query<IndexState>('SELECT * FROM note_index_state WHERE document_id=$1 AND workspace_id=$2', [noteId, workspaceId])).rows[0];
  }

  private async checkCleanup(client: pg.Client, noteId: string, attempt: Attempt): Promise<void> {
    const result = await client.query(`SELECT 1 FROM notes n
      JOIN workspaces w ON w.id=n.workspace_id AND w.user_id=$3
      JOIN tasks t ON t.id=$1 AND t.workspace_id=w.id AND t.user_id=w.user_id
      WHERE n.note_id=$7 AND n.workspace_id=$2 AND n.state='deleted'
        AND t.state='running' AND t.lease_owner=$4 AND t.version=$5
        AND t.attempt_no=$6 AND t.lease_until>clock_timestamp()
      FOR UPDATE OF n,t`, [...leaseParameters(attempt), noteId]);
    if (!result.rowCount) throw new ManualTextJobError('INGEST_CLEANUP_SOURCE_CHANGED');
  }

  async executeCleanup(attempt: Attempt): Promise<{ digest: string; bytes: number }> {
    const input = (await this.pool.query('SELECT body FROM task_inputs WHERE id=$1 AND user_id=$2 AND workspace_id=$3',
      [attempt.task.input_id, attempt.task.user_id, attempt.task.workspace_id])).rows[0];
    if (!input) throw new ManualTextJobError('INGEST_INPUT_UNAVAILABLE');
    const noteId = (JSON.parse(String(input.body)) as { noteId?: string }).noteId;
    if (!noteId) throw new ManualTextJobError('INGEST_INPUT_UNAVAILABLE');
    return this.withNoteLock(noteId, attempt, async client => {
      const state = await inTransaction(client, async () => {
        await this.checkCleanup(client, noteId, attempt);
        const current = await this.stateFor(client, noteId, attempt.task.workspace_id!);
        if (!current) return;
        const chunks = await client.query<{ chunk_id: string }>('DELETE FROM document_ingestion_chunks WHERE document_id=$1 AND workspace_id=$2 RETURNING chunk_id',
          [noteId, attempt.task.workspace_id]);
        current.pending_delete_ids = [...new Set([...current.pending_delete_ids, ...chunks.rows.map(chunk => chunk.chunk_id)])];
        // A restore during deletion starts from an empty index and can retry
        // retirement by the same IDs even if some remote deletes succeeded.
        await client.query("UPDATE note_index_state SET canonical_content='',pending_delete_ids=$3 WHERE document_id=$1 AND workspace_id=$2",
          [noteId, attempt.task.workspace_id, current.pending_delete_ids]);
        return current;
      });
      if (state) {
        const store = this.store(state.processing_snapshot);
        try {
          await this.retire(store, state);
          await inTransaction(client, async () => {
            await this.checkCleanup(client, noteId, attempt);
            await client.query('DELETE FROM note_index_state WHERE document_id=$1 AND workspace_id=$2', [noteId, attempt.task.workspace_id]);
          });
        } finally { await store.close?.(); }
      }
      return { digest: hash('deleted:note:' + noteId), bytes: 0 };
    });
  }

  private async current(client: pg.Client, row: IndexJob, attempt: Attempt, lock = false): Promise<void> {
    const snapshot = row.processing_snapshot;
    const result = await client.query(`SELECT 1 FROM notes n
      JOIN workspaces w ON w.id=n.workspace_id AND w.user_id=$3 AND w.state='ready'
      JOIN tasks t ON t.id=$1 AND t.workspace_id=w.id AND t.user_id=w.user_id
      WHERE n.note_id=$7 AND n.workspace_id=$2 AND n.state='active'
        AND (n.note_revision_id=$8 OR ($9::uuid IS NOT NULL AND
          (SELECT p.part_revision_id FROM note_part_revisions p WHERE p.note_id=n.note_id AND p.part='raw' ORDER BY p.revision DESC LIMIT 1)=$9::uuid))
        AND t.state='running' AND t.lease_owner=$4 AND t.version=$5
        AND t.attempt_no=$6 AND t.lease_until>clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM note_index_jobs newer
          JOIN note_index_jobs current ON current.idempotency_key=$10
          WHERE newer.document_id=n.note_id AND newer.workspace_id=n.workspace_id
            AND (newer.created_at,newer.idempotency_key)>(current.created_at,current.idempotency_key))
      ${lock ? 'FOR UPDATE OF n,t' : ''}`,
    [...leaseParameters(attempt), row.document_id, snapshot.expectedNoteRevision, snapshot.expectedRawRevision ?? null, row.idempotency_key]);
    if (!result.rowCount) throw new ManualTextJobError('INGEST_SOURCE_SUPERSEDED');
  }

  private async storedChunks(client: pg.Client, row: IndexJob): Promise<StoredChunk[]> {
    return (await client.query<StoredChunk>(`SELECT chunk_id,block_id,start_offset,end_offset,core_start,core_end,text,embedding_text,index_status
      FROM document_ingestion_chunks WHERE document_id=$1 AND workspace_id=$2 ORDER BY chunk_index`, [row.document_id, row.workspace_id])).rows;
  }

  private async plan(client: pg.Client, row: IndexJob, attempt: Attempt, state: IndexState | undefined, tokenizer: Awaited<ReturnType<typeof manualTokenizer>>): Promise<void> {
    const snapshot = row.processing_snapshot;
    const old = state ? await this.storedChunks(client, row) : [];
    const byId = new Map(old.map(chunk => [chunk.chunk_id, chunk]));
    const eligible: IndexedNoteChunk[] = state?.processing_snapshot.chunkProfile === snapshot.chunkProfile ? old.map(chunk => ({
      id: chunk.chunk_id, start: chunk.start_offset, end: chunk.end_offset, coreStart: chunk.core_start,
      coreEnd: chunk.core_end, text: chunk.text, embeddingText: chunk.embedding_text,
    })) : [];
    let structure;
    try {
      structure = await analyzeDocumentStructure(row.canonical_content, { format: snapshot.format });
    } catch {
      await inTransaction(client, async () => {
        await this.current(client, row, attempt, true);
        await client.query("UPDATE note_index_jobs SET toc=NULL,toc_status='failed',updated_at=now() WHERE idempotency_key=$1", [row.idempotency_key]);
      });
      throw new ManualTextJobError('INGEST_TOC_FAILED', true);
    }
    const toc = readingToc(row.canonical_content, structure.toc);
    const { chunks } = await planNoteChunks({
      content: row.canonical_content, format: snapshot.format,
      options: { ...snapshot.split, tokenizer }, structureHints: structure,
    }, state?.canonical_content ?? '', eligible);

    const next = chunks.map(chunk => {
      if (row.canonical_content.slice(chunk.source_start, chunk.source_end) !== chunk.content) throw new ManualTextJobError('INGEST_OFFSET_INVALID');
      const matched = chunk.reuseId ? byId.get(chunk.reuseId) : undefined;
      const previous = matched ?? (chunk.previousId ? byId.get(chunk.previousId) : undefined);
      const reuse = matched?.index_status === 'ready' && matched.text === chunk.content && matched.embedding_text === chunk.embedding_text;
      const id = reuse ? matched.chunk_id : hash(JSON.stringify(['note', row.document_id, row.task_id, chunk.ordinal, chunk.content_hash, chunk.embedding_text_hash]));
      return { chunk, id, blockId: previous?.block_id ?? id, ready: reuse };
    });
    const retained = new Set(next.filter(point => point.ready).map(point => point.id));
    const retired = old.filter(chunk => !retained.has(chunk.chunk_id)).map(chunk => chunk.chunk_id);
    const pending = [...new Set([...(state?.pending_delete_ids ?? []), ...retired])];
    await inTransaction(client, async () => {
      await this.current(client, row, attempt, true);
      await client.query(`INSERT INTO note_index_state(document_id,workspace_id,canonical_content,processing_snapshot,pending_delete_ids)
        VALUES($1,$2,$3,$4::jsonb,$5::text[]) ON CONFLICT(document_id) DO UPDATE SET
        canonical_content=EXCLUDED.canonical_content,processing_snapshot=EXCLUDED.processing_snapshot,pending_delete_ids=EXCLUDED.pending_delete_ids`,
      [row.document_id, row.workspace_id, row.canonical_content, JSON.stringify(snapshot), pending]);
      if (retired.length) await client.query('DELETE FROM document_ingestion_chunks WHERE document_id=$1 AND workspace_id=$2 AND chunk_id=ANY($3::text[])',
        [row.document_id, row.workspace_id, retired]);
      for (const { chunk, id, blockId, ready } of next) {
        await client.query(`INSERT INTO document_ingestion_chunks
          (workspace_id,document_id,chunk_id,block_id,chunk_index,chunk_hash,text,heading_path,start_offset,end_offset,core_start,core_end,
           token_count,embedding_text,embedding_text_hash,embedding_token_count,index_status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          ON CONFLICT(chunk_id) DO UPDATE SET chunk_index=EXCLUDED.chunk_index, heading_path=EXCLUDED.heading_path,
            start_offset=EXCLUDED.start_offset,end_offset=EXCLUDED.end_offset,core_start=EXCLUDED.core_start,core_end=EXCLUDED.core_end,updated_at=now()
          WHERE (document_ingestion_chunks.chunk_index,document_ingestion_chunks.heading_path,document_ingestion_chunks.start_offset,
            document_ingestion_chunks.end_offset,document_ingestion_chunks.core_start,document_ingestion_chunks.core_end)
          IS DISTINCT FROM (EXCLUDED.chunk_index,EXCLUDED.heading_path,EXCLUDED.start_offset,EXCLUDED.end_offset,EXCLUDED.core_start,EXCLUDED.core_end)`,
        [row.workspace_id, row.document_id, id, blockId, chunk.ordinal, chunk.content_hash, chunk.content, JSON.stringify(chunk.heading_path),
          chunk.source_start, chunk.source_end, chunk.core_start, chunk.core_end, chunk.token_count, chunk.embedding_text,
          chunk.embedding_text_hash, chunk.embedding_token_count, ready ? 'ready' : 'pending']);
      }
      await client.query("UPDATE note_index_jobs SET planned=true,chunk_count=$2,toc=$3::jsonb,toc_status='ready',status='processing',updated_at=now() WHERE idempotency_key=$1",
        [row.idempotency_key, chunks.length, JSON.stringify(toc)]);
    });
  }

  private async retire(store: BoundVectorStoreAdapter, state: IndexState): Promise<void> {
    if (!state.pending_delete_ids.length) return;
    const result = await deleteVectors(store, { ids: state.pending_delete_ids });
    if (result.status !== 'deleted') throw new ManualTextJobError('INGEST_CLEANUP_FAILED', result.retryable);
  }

  private async indexPending(client: pg.Client, row: IndexJob, attempt: Attempt, store: BoundVectorStoreAdapter, tokenizer: Awaited<ReturnType<typeof manualTokenizer>>): Promise<void> {
    const snapshot = row.processing_snapshot;
    const pending = (await this.storedChunks(client, row)).filter(chunk => chunk.index_status !== 'ready');
    if (!pending.length) return;
    const raw = this.config.rag.providerMode === 'mock'
      ? new DeterministicEmbeddingClient(snapshot.embedding.dimensions)
      : new OpenAICompatibleEmbeddingClient({
        baseUrl: snapshot.embedding.baseUrl!, apiKey: this.config.rag.embeddingApiKey!, model: snapshot.embedding.model,
        dimensions: snapshot.embedding.dimensions, sendDimensions: this.config.rag.embeddingSendDimensions,
        timeoutMs: snapshot.indexing.timeoutMs, maxRetries: 0,
      });
    const embedder = { model: snapshot.embedding.model, dimensions: snapshot.embedding.dimensions, embed: (texts: string[]) => raw.embed(texts) };
    const embeddingAdapter = snapshot.providerMode === 'live' ? cachedEmbedding(embedder, storageFor(this.config), row.idempotency_key) : embedder;
    const { batchSize } = snapshot.indexing;
    let failure: ManualTextJobError | undefined;
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      await this.current(client, row, attempt);
      const records: IndexRecord[] = pending.slice(offset, offset + batchSize).map(chunk => ({
        id: chunk.chunk_id, embeddingText: chunk.embedding_text, metadata: {
          parent_id: row.document_id, source_type: 'note', content: chunk.text, user_id: attempt.task.user_id!,
          workspace_id: row.workspace_id, embedding_profile: snapshot.embedding.profile, embedding_model: snapshot.embedding.model,
        },
      }));
      let write: Promise<void> | undefined;
      const vectorStoreAdapter: BoundVectorStoreAdapter = {
        target: store.target,
        upsert: (batch, options) => {
          write = store.upsert(batch, options);
          return write;
        },
        delete: (selector, options) => store.delete(selector, options),
      };
      const result = await indexChunks(records, {
        embeddingAdapter, vectorStoreAdapter, tokenizer,
        options: { ...snapshot.indexing, maxEmbeddingTokens: snapshot.split.maxEmbeddingTokens },
      }).finally(async () => {
        // The indexing deadline can fire before the transport settles. Hold
        // the Note lock until that write finishes, so a later task can retire it.
        await write?.catch(() => undefined);
      });
      await inTransaction(client, async () => {
        await this.current(client, row, attempt, true);
        const ready = result.items.filter(item => item.status === 'indexed').map(item => item.id);
        const failed = result.items.filter(item => item.status === 'failed').map(item => item.id);
        if (ready.length) await client.query("UPDATE document_ingestion_chunks SET index_status='ready',updated_at=now() WHERE document_id=$1 AND workspace_id=$2 AND chunk_id=ANY($3::text[])",
          [row.document_id, row.workspace_id, ready]);
        if (failed.length) await client.query("UPDATE document_ingestion_chunks SET index_status='failed',updated_at=now() WHERE document_id=$1 AND workspace_id=$2 AND chunk_id=ANY($3::text[])",
          [row.document_id, row.workspace_id, failed]);
      });
      if (result.failedCount) {
        failure = new ManualTextJobError('INGEST_INDEX_PARTIAL_FAILURE', !!failure?.retryable || result.items.some(item => item.retryable));
        if (result.items.some(item => item.errorCode === 'INDEX_OPERATION_TIMEOUT' || item.errorCode === 'INDEX_TARGET_CHANGED')) break;
      }
    }
    if (failure) throw failure;
  }

  async execute(attempt: Attempt): Promise<{ digest: string; bytes: number }> {
    const { document_id } = await this.jobFor(this.pool, attempt);
    return this.withNoteLock(document_id, attempt, async client => {
      const row = await this.jobFor(client, attempt);
      const snapshot = row.processing_snapshot;
      if (snapshot.sourceType !== 'note' || snapshot.parentId !== row.document_id || snapshot.sourceRevision !== row.document_version ||
          snapshot.split.maxSourceChars !== NOTE_CHUNK_MAX_CHARS || snapshot.split.targetSourceChars !== NOTE_CHUNK_TARGET_CHARS) {
        throw new ManualTextJobError('INGEST_SNAPSHOT_INVALID');
      }
      if (snapshot.providerMode !== this.config.rag.providerMode) throw new ManualTextJobError('INGEST_PROVIDER_CHANGED');
      let store: ReturnType<ManualTextIngestionJobs['store']> | undefined;
      try {
        await this.current(client, row, attempt);
        let state = await this.stateFor(client, row.document_id, row.workspace_id);
        if (state && !sameTarget(state.processing_snapshot.vectorTarget, snapshot.vectorTarget)) throw new ManualTextJobError('INGEST_VECTOR_TARGET_CHANGED');
        const tokenizer = await manualTokenizer(this.config, snapshot);
        if (!row.planned) {
          await this.plan(client, row, attempt, state, tokenizer);
          state = await this.stateFor(client, row.document_id, row.workspace_id);
        }
        if (!state || state.canonical_content !== row.canonical_content) throw new ManualTextJobError('INGEST_SOURCE_SUPERSEDED');
        store = this.store(snapshot);
        if (state.pending_delete_ids.length) {
          await this.retire(store, state);
          await inTransaction(client, async () => {
            await this.current(client, row, attempt, true);
            await client.query("UPDATE note_index_state SET pending_delete_ids='{}' WHERE document_id=$1 AND workspace_id=$2", [row.document_id, row.workspace_id]);
          });
        }
        await this.indexPending(client, row, attempt, store, tokenizer);
        await inTransaction(client, async () => {
          await this.current(client, row, attempt, true);
          await client.query("UPDATE note_index_jobs SET status='ready',error_code=NULL,error_message=NULL,updated_at=now() WHERE idempotency_key=$1", [row.idempotency_key]);
        });
        return { digest: row.content_hash, bytes: Buffer.byteLength(row.canonical_content, 'utf8') };
      } catch (error) {
        const code = error instanceof ManualTextJobError ? error.code : 'INGEST_INDEX_FAILED';
        await client.query(`UPDATE note_index_jobs j SET status='failed',error_code=$8,error_message=$8,updated_at=now()
          FROM tasks t WHERE j.idempotency_key=$7 AND t.id=$1 AND t.workspace_id=$2 AND t.user_id=$3
            AND t.state='running' AND t.lease_owner=$4 AND t.version=$5 AND t.attempt_no=$6
            AND t.lease_until>clock_timestamp() AND j.status<>'ready'`, [...leaseParameters(attempt), row.idempotency_key, code]).catch(() => undefined);
        throw error;
      } finally { await store?.close?.(); }
    });
  }
}
