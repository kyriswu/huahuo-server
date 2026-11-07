import { TextIngestionQueryService } from '../text-ingestion/query.js';
import type pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import { DomainError, assertScope, transaction, type Scope } from '../identity/store.js';
import { DeterministicEmbeddingClient, EmbeddingError, OpenAICompatibleEmbeddingClient, type EmbeddingClient } from './adapters/embedding.js';
import { MilvusError, MilvusRepository, type MilvusSearchHit, type MilvusSearchScope } from './adapters/milvus.js';
import { vectorConnectionId } from './vector-store.js';
import { processingEmbedding } from './processing-profile.js';
import type { VectorTarget } from '../../lib/rag-indexing/index.js';
import { HttpRerankAdapter, MockRerankAdapter, RerankError, type RagSearchCandidate, type RerankAdapter } from './search.js';

export type RagQueryMode = 'dense' | 'keyword' | 'hybrid';

export interface RagQueryInput {
  query: string;
  mode?: RagQueryMode;
  topK?: number;
  documentKey?: string;
  documentId?: string;
  sourceType?: 'file'|'note'|'text';
}

interface VersionRow { id: string; workspace_id: string; user_id: string; status: string; embedding_model: string; embedding_dimension: number; child_count: number; document_key: string; source_pk: string; embedding_profile: string; index_build_id: string; active: boolean; processing_snapshot: { providerMode: string; vectorTarget: VectorTarget; embedding: { model: string; dimensions: number; profile: string; baseUrl?:string } } | null; }
interface FileSearchGroup { target: VectorTarget; model: string; dimensions: number; versions: VersionRow[]; }
interface NoteSearchRow {
  document_id: string;
  workspace_id: string;
  task_id: string;
  chunk_count: number;
  ready_ids: string[];
  processing_snapshot: NonNullable<VersionRow['processing_snapshot']>;
}
interface NoteChunkRow { chunk_id: string; text: string; chunk_index: number; }
interface ChildRow {
  id: string;
  parent_id:string;
  source_type:string;
  source_revision:string;
  version_id: string;
  document_key: string;
  chunk_key: string;
  chunk_count: number;
  embedding_profile: string;
  index_build_id: string;
  milvus_id?: string | null;
  ordinal: number;
  content: string;
  embedding_text: string;
  token_count: number;
  metadata: unknown;
}

export interface RagQueryDependencies {
  embedding?: EmbeddingClient;
  milvus?: Pick<MilvusRepository, 'ensureReady' | 'search' | 'searchKeyword' | 'hybridSearch' | 'close'>;
  rerank?: RerankAdapter;
  resolveTextAssets?: (content: string, parentId: string, scope: Scope) => Promise<string>;
  resolveAssets?: (content: string, versionId: string, scope: Scope) => Promise<string>;
}

function clampTopK(value: number | undefined): number { return Math.max(1, Math.min(50, Number.isInteger(value) ? value! : 10)); }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function finite(value: unknown): number { const number = Number(value); return Number.isFinite(number) ? number : 0; }

// Select the latest intent before testing its status, so a queued save hides
// the previous index even before its Worker claims the task.
const readyNoteJob = `JOIN LATERAL (
  SELECT j.task_id,j.status FROM note_index_jobs j
  WHERE j.document_id=n.note_id AND j.workspace_id=n.workspace_id
  ORDER BY j.created_at DESC,j.idempotency_key DESC LIMIT 1
) job ON job.status='ready'`;

export class RagQueryService {
  private readonly textIngestion: TextIngestionQueryService;
  private readonly embedding: EmbeddingClient | undefined;
  private readonly milvus: RagQueryDependencies['milvus'];
  private readonly rerank: RerankAdapter | undefined;
  private readonly injectedMilvus: boolean;

  constructor(private readonly pool: pg.Pool, private readonly config: AppConfig, dependencies: RagQueryDependencies = {}) {
    this.textIngestion = new TextIngestionQueryService(pool,config,{...dependencies,resolveAssets:dependencies.resolveTextAssets});
    this.embedding = dependencies.embedding ?? this.defaultEmbedding();
    this.injectedMilvus = dependencies.milvus !== undefined;
    this.milvus = dependencies.milvus ?? (config.rag.providerMode === 'live' ? new MilvusRepository(config.milvus) : undefined);
    this.rerank = dependencies.rerank ?? (config.rag.rerankProvider === 'mock'
      ? new MockRerankAdapter()
      : config.rag.rerankProvider === 'http' && config.rag.rerankBaseUrl
        ? new HttpRerankAdapter({ baseUrl: config.rag.rerankBaseUrl, apiKey: config.rag.rerankApiKey, model: config.rag.rerankModel, timeoutMs: config.rag.rerankTimeoutMs })
        : undefined);
    this.resolveAssets = dependencies.resolveAssets;
  }

  /** Close process-scoped external clients during application shutdown only. */
  async close(): Promise<void> {
    await this.textIngestion.close();
    await this.milvus?.close();
  }

  private readonly resolveAssets?: (content: string, versionId: string, scope: Scope) => Promise<string>;

  private defaultEmbedding(): EmbeddingClient | undefined {
    if (this.config.rag.providerMode === 'disabled') return undefined;
    if (this.config.rag.providerMode === 'mock') return new DeterministicEmbeddingClient(this.config.rag.embeddingDimensions);
    if (!this.config.rag.embeddingBaseUrl || !this.config.rag.embeddingApiKey) return undefined;
    return new OpenAICompatibleEmbeddingClient({
      baseUrl: this.config.rag.embeddingBaseUrl,
      apiKey: this.config.rag.embeddingApiKey,
      model: this.config.rag.embeddingModel,
      dimensions: this.config.rag.embeddingDimensions,
      sendDimensions: this.config.rag.embeddingSendDimensions,
      timeoutMs: this.config.rag.embeddingTimeoutMs,
      maxRetries: this.config.rag.embeddingMaxRetries,
    });
  }

  private async versions(scope: Scope, input: RagQueryInput): Promise<VersionRow[]> {
    const key = input.documentKey ?? input.documentId;
    const activeProfile = this.config.rag.embeddingProfile;
    return transaction(this.pool, async (tx) => {
      await assertScope(tx, scope);
      const query = `SELECT v.id,v.workspace_id,v.user_id,v.status,v.embedding_model,v.embedding_dimension,v.child_count,
                            v.document_key,v.source_pk,v.embedding_profile,v.index_build_id,v.active,
                            v.processing_snapshot
                       FROM rag_ingestion_versions v
                       JOIN workspaces w ON w.id=v.workspace_id AND w.user_id=v.user_id AND w.is_default=true AND w.state='ready'
                      WHERE v.user_id=$1 AND v.status='SUCCEEDED' AND v.deleted_at IS NULL
                        AND v.active=true AND v.embedding_profile=$2
                        AND v.embedding_status='ready' AND v.index_status='ready'
                        ${key ? '' : 'AND v.processing_snapshot IS NOT NULL'}
                        ${key ? 'AND (v.id::text=$3 OR v.document_key=$3 OR v.source_pk=$3)' : ''}
                      ORDER BY v.created_at DESC`;
      const params = [scope.userId, activeProfile, ...(key ? [key] : [])];
      const result = await tx.query<VersionRow>(query, params);
      if (key && !result.rowCount) throw new DomainError(404, 'RAG_DOCUMENT_NOT_FOUND');
      return result.rows;
    });
  }

  /** A task's stored target remains the source of truth after configuration changes. */
  private fileGroups(versions: VersionRow[]): FileSearchGroup[] {
    const groups = new Map<string, FileSearchGroup>();
    for (const version of versions) {
      const snapshot = version.processing_snapshot;
      if (!snapshot) throw new DomainError(503, 'RAG_TARGET_SNAPSHOT_UNAVAILABLE');
      if (!snapshot.vectorTarget || !snapshot.embedding) throw new DomainError(503, 'RAG_TARGET_UNAVAILABLE');
      const target = snapshot.vectorTarget;
      const model = snapshot.embedding.model;
      const dimensions = snapshot.embedding.dimensions;
      if (!target || target.connectionId !== vectorConnectionId(this.config) || !target.database || !target.collection || target.partition
        || snapshot.providerMode !== this.config.rag.providerMode || snapshot.embedding.baseUrl!==this.config.rag.embeddingBaseUrl) throw new DomainError(503, 'RAG_TARGET_UNAVAILABLE');
      if (!model || !Number.isSafeInteger(dimensions) || dimensions < 1
        || model !== version.embedding_model || dimensions !== Number(version.embedding_dimension)
        || snapshot.embedding.profile !== version.embedding_profile) throw new DomainError(503, 'RAG_INDEX_PROFILE_INVALID');
      const frozenTarget = Object.freeze({ ...target });
      const key = JSON.stringify([frozenTarget.connectionId, frozenTarget.database, frozenTarget.collection, model, dimensions, version.workspace_id]);
      const group = groups.get(key) ?? { target: frozenTarget, model, dimensions, versions: [] };
      group.versions.push(version); groups.set(key, group);
    }
    return [...groups.values()];
  }

  private fileIndex(target: VectorTarget): { index: NonNullable<RagQueryDependencies['milvus']>; owned: boolean } {
    if (this.injectedMilvus && this.milvus) return { index: this.milvus, owned: false };
    if (this.config.rag.providerMode !== 'live') throw new DomainError(503, 'RAG_SEARCH_UNAVAILABLE');
    if (target.database === this.config.milvus.database && target.collection === this.config.milvus.collection && this.milvus) return { index: this.milvus, owned: false };
    return { index: new MilvusRepository({ ...this.config.milvus, database: target.database, collection: target.collection, createIfMissing: false }), owned: true };
  }

  private candidate(row: ChildRow, score: number, scoreKind: RagQueryMode): RagSearchCandidate {
    if (!row.parent_id || row.parent_id !== row.version_id || row.source_type !== 'file' || !row.source_revision) throw new DomainError(503, 'RAG_INDEX_SOURCE_INVALID');
    return {
      chunkKey: row.chunk_key,
      documentKey: row.document_key,
      parentId: row.parent_id,
      content: row.content,
      chunkIndex: Number(row.ordinal),
      chunkCount: Number(row.chunk_count),
      // Native hybrid returns only the fused score. Zero branch-score slots do
      // not represent measured dense/BM25 scores; no second search is issued.
      denseScore: scoreKind === 'dense' ? score : 0,
      keywordScore: scoreKind === 'keyword' ? score : 0,
      rrfScore: scoreKind === 'hybrid' ? score : 0,
      embeddingProfile: row.embedding_profile,
      indexBuildId: row.index_build_id,
      metadata: { versionId: row.version_id, sourceType:row.source_type, sourceRevision:row.source_revision, raw: row.metadata },
    };
  }

  private async loadRows(scope: Scope, versions: VersionRow[], hits: MilvusSearchHit[], scoreKind: RagQueryMode): Promise<RagSearchCandidate[]> {
    if (!hits.length) return [];
    return transaction(this.pool, async (tx) => {
      await assertScope(tx, scope);
      const result = await tx.query<ChildRow>(
        `SELECT c.id,c.version_id,c.document_key,c.chunk_key,c.chunk_count,c.embedding_profile,c.index_build_id,
                c.ordinal,c.content,c.embedding_text,c.token_count,c.metadata,
                c.parent_id,c.source_type,c.source_revision
           FROM rag_child_chunks c
           JOIN rag_ingestion_versions v ON v.id=c.version_id
           JOIN jsonb_to_recordset($4::jsonb)
                AS allowed(version_id uuid,document_key text,embedding_profile text,index_build_id text)
             ON allowed.version_id=c.version_id AND allowed.document_key=c.document_key
            AND allowed.embedding_profile=c.embedding_profile AND allowed.index_build_id=c.index_build_id
          WHERE v.user_id=$1 AND v.workspace_id=$2 AND v.status='SUCCEEDED' AND v.active=true AND v.deleted_at IS NULL
            AND v.document_key=c.document_key AND v.embedding_profile=c.embedding_profile AND v.index_build_id=c.index_build_id
            AND c.embedding_status='ready' AND c.index_status='ready'
            AND c.chunk_key = ANY($3::text[])`,
        [scope.userId, versions[0]!.workspace_id, hits.map((hit) => hit.chunkKey), JSON.stringify(versions.map((version) => ({ version_id: version.id, document_key: version.document_key, embedding_profile: version.embedding_profile, index_build_id: version.index_build_id })))],
      );
      const byKey = new Map<string, ChildRow>();
      for (const row of result.rows) byKey.set(row.chunk_key, row);
      const seen = new Set<string>();
      return [...hits].sort((left, right) => finite(right.score) - finite(left.score)).flatMap((hit) => {
        const row = byKey.get(hit.chunkKey);
        if (!row || seen.has(row.chunk_key)) return [];
        seen.add(row.chunk_key);
        return [this.candidate(row, finite(hit.score), scoreKind)];
      });
    });
  }

  private async queryManual(scope: Scope, input: RagQueryInput, query: string, mode: RagQueryMode, topK: number) {
    const limit = Math.max(topK, mode === 'dense' ? this.config.milvus.denseCandidates : mode === 'keyword' ? this.config.milvus.bm25Candidates : this.config.milvus.hybridCandidates);
    const notes = await transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      const result = await tx.query<NoteSearchRow>(`SELECT s.document_id,s.workspace_id,s.processing_snapshot,job.task_id,chunks.ready_ids,chunks.chunk_count
        FROM note_index_state s
        JOIN notes n ON n.note_id=s.document_id AND n.workspace_id=s.workspace_id
        JOIN workspaces w ON w.id=s.workspace_id
        ${readyNoteJob}
        JOIN LATERAL (
          SELECT array_agg(c.chunk_id ORDER BY c.chunk_index) AS ready_ids,
            count(*) AS chunk_count
          FROM document_ingestion_chunks c WHERE c.document_id=s.document_id AND c.workspace_id=s.workspace_id
          HAVING bool_and(c.index_status='ready')
        ) chunks ON chunks.ready_ids IS NOT NULL
        WHERE w.user_id=$1 AND w.state='ready' AND n.state='active' AND n.processing_status='ready'
          AND ($2::text IS NULL OR s.document_id::text=$2)
        ORDER BY n.updated_at DESC LIMIT 50`, [scope.userId, input.documentKey ?? input.documentId ?? null]);
      return result.rows;
    });
    let candidates: RagSearchCandidate[] = [];
    const vectors = new Map<string, number[]>();
    const score = (candidate: RagSearchCandidate) => mode === 'dense' ? candidate.denseScore : mode === 'keyword' ? candidate.keywordScore : candidate.rrfScore;
    for (const note of notes) {
      const snapshot = note.processing_snapshot;
      const target = snapshot?.vectorTarget;
      const embedding = snapshot?.embedding;
      if (!target || !embedding || snapshot.providerMode !== this.config.rag.providerMode
        || embedding.baseUrl !== this.config.rag.embeddingBaseUrl
        || target.connectionId !== vectorConnectionId(this.config) || !target.database || !target.collection || target.partition) {
        throw new DomainError(503, 'RAG_TARGET_UNAVAILABLE');
      }
      if (!embedding.model || !embedding.profile || !Number.isSafeInteger(embedding.dimensions) || embedding.dimensions < 1) {
        throw new DomainError(503, 'RAG_INDEX_PROFILE_INVALID');
      }
      const { index, owned } = this.fileIndex(target);
      try {
        await index.ensureReady(embedding.dimensions);
        const searchScope: MilvusSearchScope = {
          userId: scope.userId, workspaceId: note.workspace_id, sourceType: 'note',
          note: { documentId: note.document_id, embeddingProfile: embedding.profile, chunkIds: note.ready_ids },
        };
        const options = { scope: searchScope, limit, dimensions: embedding.dimensions };
        let hits: MilvusSearchHit[];
        if (mode === 'keyword') hits = await index.searchKeyword(query, options);
        else {
          const key = JSON.stringify([embedding.model, embedding.dimensions]);
          let vector = vectors.get(key);
          if (!vector) {
            const embedder = embedding.model === this.config.rag.embeddingModel && embedding.dimensions === this.config.rag.embeddingDimensions
              ? this.embedding : processingEmbedding(this.config, embedding.model, embedding.dimensions);
            if (!embedder) throw new DomainError(503, 'RAG_DENSE_SEARCH_UNAVAILABLE');
            vector = (await embedder.embed([query]))[0]!;
            vectors.set(key, vector);
          }
          hits = mode === 'dense' ? await index.search(vector, options) : await index.hybridSearch(vector, query, options);
        }
        const ready = new Set(note.ready_ids);
        const scores = new Map<string, number>();
        for (const hit of hits) {
          if (hit.state !== 'ready' || !ready.has(hit.chunkKey)) continue;
          const value = finite(hit.score);
          scores.set(hit.chunkKey, Math.max(value, scores.get(hit.chunkKey) ?? -Infinity));
        }
        if (!scores.size) continue;
        // Check authorization and readiness again after Milvus. An edit can
        // retire a point while the recall request is in flight.
        const records = await transaction(this.pool, async tx => {
          await assertScope(tx, scope);
          const result = await tx.query<NoteChunkRow>(`SELECT c.chunk_id,c.text,c.chunk_index
            FROM document_ingestion_chunks c
            JOIN notes n ON n.note_id=c.document_id AND n.workspace_id=c.workspace_id
            JOIN workspaces w ON w.id=c.workspace_id
            ${readyNoteJob}
            WHERE c.document_id=$1 AND c.workspace_id=$2 AND c.chunk_id=ANY($3::text[])
              AND c.index_status='ready' AND n.state='active' AND n.processing_status='ready'
              AND w.user_id=$4 AND w.state='ready' AND job.task_id=$5`, [note.document_id, note.workspace_id, [...scores.keys()], scope.userId, note.task_id]);
          return result.rows;
        });
        for (const chunk of records) {
          const value = scores.get(chunk.chunk_id);
          if (value === undefined) continue;
          candidates.push({
            chunkKey: chunk.chunk_id, documentKey: note.document_id, parentId: note.document_id,
            content: chunk.text, chunkIndex: chunk.chunk_index, chunkCount: Number(note.chunk_count),
            denseScore: mode === 'dense' ? value : 0, keywordScore: mode === 'keyword' ? value : 0,
            rrfScore: mode === 'hybrid' ? value : 0,
          });
        }
        candidates.sort((left, right) => score(right) - score(left));
        candidates = candidates.slice(0, limit);
      } finally { if (owned) await index.close(); }
    }
    let ranked = candidates;
    if (this.rerank && candidates.length) {
      ranked = await this.rerank.rerank(query, candidates);
      const current = await transaction(this.pool, async tx => {
        await assertScope(tx, scope);
        const result = await tx.query<{ note_id: string; task_id: string }>(`SELECT n.note_id,job.task_id FROM notes n
          JOIN workspaces w ON w.id=n.workspace_id
          ${readyNoteJob}
          WHERE n.note_id=ANY($1::uuid[]) AND w.user_id=$2 AND w.state='ready'
            AND n.state='active' AND n.processing_status='ready'`,
        [[...new Set(ranked.map(candidate => candidate.documentKey))], scope.userId]);
        return new Map(result.rows.map(row => [row.note_id, row.task_id]));
      });
      const recalled = new Map(notes.map(note => [note.document_id, note.task_id]));
      ranked = ranked.filter(candidate => {
        const task = recalled.get(candidate.documentKey);
        return task !== undefined && current.get(candidate.documentKey) === task;
      });
    }
    return { mode, query, results: ranked.slice(0, topK).map(candidate => ({
      ...candidate, chunkId: candidate.chunkKey, sourceType: 'note', evidence: { child: candidate.content }, context: null,
    })) };
  }

  async query(scope: Scope, input: RagQueryInput): Promise<{ mode: RagQueryMode; query: string; results: Array<Record<string, unknown>> }> {
    const query = input.query?.trim();
    if (!query || query.length > 2000) throw new DomainError(400, 'RAG_QUERY_INVALID');
    const mode = input.mode ?? 'hybrid';
    if (!['dense', 'keyword', 'hybrid'].includes(mode)) throw new DomainError(400, 'RAG_QUERY_MODE_INVALID');
    const documentKey = input.documentKey ?? input.documentId;
    if (documentKey && !/^[A-Za-z0-9._:-]{1,128}$/u.test(documentKey)) throw new DomainError(400, 'RAG_DOCUMENT_KEY_INVALID');
    const topK = clampTopK(input.topK);
    if(input.sourceType==='text')return this.textIngestion.query(scope,input);
    if(input.sourceType==='note'){
      try{return await this.queryManual(scope,input,query,mode,topK);}
      catch(error){if(error instanceof DomainError)throw error;if(error instanceof RerankError)throw new DomainError(503,'RAG_RERANK_UNAVAILABLE');throw new DomainError(503,'RAG_SEARCH_UNAVAILABLE');}
    }
    const versions = await this.versions(scope, input);
    if (!versions.length) return { mode, query, results: [] };
    const limit = Math.max(topK, mode === 'dense' ? this.config.milvus.denseCandidates : mode === 'keyword' ? this.config.milvus.bm25Candidates : this.config.milvus.hybridCandidates);
    let candidates: RagSearchCandidate[] = [];
    try {
      if (!this.milvus && this.config.rag.providerMode !== 'live') throw new DomainError(503, 'RAG_SEARCH_UNAVAILABLE');
      const vectors = new Map<string, number[]>();
      for (const group of this.fileGroups(versions)) {
        const { index, owned } = this.fileIndex(group.target);
        try {
          await index.ensureReady(group.dimensions);
          const searchScope: MilvusSearchScope = {
            userId: scope.userId,
            workspaceId: group.versions[0]!.workspace_id,
            sourceType: 'file',
            versions: group.versions.map(version => ({ documentId: version.document_key, versionId: version.id, embeddingProfile: version.embedding_profile, indexBuildId: version.index_build_id })),
          };
          let hits: MilvusSearchHit[];
          if (mode === 'keyword') hits = await index.searchKeyword(query, { limit, scope: searchScope });
          else {
            const modelKey = JSON.stringify([group.model, group.dimensions]);
            let vector = vectors.get(modelKey);
            if (!vector) {
              const embedder = group.model === this.config.rag.embeddingModel && group.dimensions === this.config.rag.embeddingDimensions
                ? this.embedding : processingEmbedding(this.config, group.model, group.dimensions);
              if (!embedder) throw new DomainError(503, 'RAG_DENSE_SEARCH_UNAVAILABLE');
              vector = (await embedder.embed([query]))[0]!; vectors.set(modelKey, vector);
            }
            hits = mode === 'hybrid'
              ? await index.hybridSearch(vector, query, { limit, dimensions: group.dimensions, scope: searchScope })
              : await index.search(vector, { limit, dimensions: group.dimensions, scope: searchScope });
          }
          candidates.push(...await this.loadRows(scope, group.versions, hits.filter(hit => hit.state === 'ready'), mode));
          // Selecting the best native scores across bound targets is not RRF
          // fusion. No ranks or per-route scores are recomputed in Node.
          const score = (candidate: RagSearchCandidate) => mode === 'dense' ? candidate.denseScore : mode === 'keyword' ? candidate.keywordScore : candidate.rrfScore;
          candidates.sort((left, right) => score(right) - score(left));
          const seen = new Set<string>();
          candidates = candidates.filter(candidate => { if (seen.has(candidate.chunkKey)) return false; seen.add(candidate.chunkKey); return true; }).slice(0, limit);
        } finally { if (owned) await index.close(); }
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof MilvusError || error instanceof EmbeddingError) throw new DomainError(503, 'RAG_SEARCH_UNAVAILABLE');
      throw new DomainError(503, 'RAG_SEARCH_UNAVAILABLE');
    }
    if (this.rerank && candidates.length) {
      try { candidates = await this.rerank.rerank(query, candidates); }
      catch (error) { if (error instanceof RerankError) throw new DomainError(503, 'RAG_RERANK_UNAVAILABLE'); throw error; }
    }
    const final = candidates.slice(0, topK);
    const resolved = await Promise.all(final.map(async candidate=>{
      const versionId=text(candidate.metadata?.versionId)||candidate.documentKey;
      const content=this.resolveAssets?await this.resolveAssets(candidate.content,versionId,scope):candidate.content;
      return {...candidate,chunkId:candidate.chunkKey,uniqKey:candidate.chunkKey,sourceType:'file',sourceRevision:candidate.metadata?.sourceRevision,documentVersionId:versionId,chunkOrdinal:candidate.chunkIndex,content,rerankScore:candidate.rerankScore??(mode==='dense'?candidate.denseScore:mode==='keyword'?candidate.keywordScore:candidate.rrfScore),evidence:{child:content},context:null};
    }));
    return { mode, query, results: resolved };
  }
}
