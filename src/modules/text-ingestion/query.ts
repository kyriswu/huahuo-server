import type pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import type { VectorTarget } from '../../lib/rag-indexing/index.js';
import { assertScope, DomainError, transaction, type Scope } from '../identity/store.js';
import type { EmbeddingClient } from '../rag/adapters/embedding.js';
import { MilvusRepository, type MilvusSearchHit } from '../rag/adapters/milvus.js';
import { processingEmbedding, type FileProcessingSnapshot } from '../rag/processing-profile.js';
import type { RagQueryDependencies, RagQueryMode } from '../rag/query-service.js';
import { HttpRerankAdapter, MockRerankAdapter, type RagSearchCandidate, type RerankAdapter } from '../rag/search.js';
import { vectorConnectionId } from '../rag/vector-store.js';
import { storeIdentity } from '../../plugins/store-identity.js';

export interface TextIngestionQueryInput {
  query: string;
  mode?: RagQueryMode;
  topK?: number;
  documentKey?: string;
  documentId?: string;
}
export interface TextIngestionQueryResult { mode: RagQueryMode; query: string; results: Array<Record<string, unknown>>; }
interface ActiveJobRow {
  id: string;
  workspace_id: string;
  created_by: string;
  source_type: string;
  active_task_id: string;
  task_input: unknown;
  chunk_count: number;
}
interface ActiveBuild extends ActiveJobRow { snapshot: FileProcessingSnapshot; }
interface SearchGroup { target: VectorTarget; model: string; dimensions: number; workspaceId: string; builds: ActiveBuild[]; }
interface ChunkRow { chunk_key: string; parent_id: string; task_id: string; ordinal: number; content: string; source_hash: string; }
type VectorIndex = NonNullable<RagQueryDependencies['milvus']>;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** PostgreSQL authorizes published keys and supplies the content; Milvus only recalls. */
export class TextIngestionQueryService {
  private readonly indexes = new Map<string, VectorIndex>();
  private readonly rerank: RerankAdapter | undefined;

  constructor(private readonly pool: pg.Pool, private readonly config: AppConfig, private readonly dependencies: RagQueryDependencies = {}) {
    this.rerank = dependencies.rerank ?? (config.rag.rerankProvider === 'mock' ? new MockRerankAdapter()
      : config.rag.rerankProvider === 'http' && config.rag.rerankBaseUrl
        ? new HttpRerankAdapter({ baseUrl: config.rag.rerankBaseUrl, apiKey: config.rag.rerankApiKey, model: config.rag.rerankModel, timeoutMs: config.rag.rerankTimeoutMs })
        : undefined);
  }

  /** Injected clients belong to their caller; close only clients created here. */
  async close(): Promise<void> {
    for (const index of this.indexes.values()) await index.close();
    this.indexes.clear();
  }

  private snapshot(row: ActiveJobRow): FileProcessingSnapshot | undefined {
    let input: unknown = row.task_input;
    if (typeof input === 'string') {
      try { input = JSON.parse(input) as unknown; }
      catch { throw new DomainError(503, 'RAG_TARGET_SNAPSHOT_UNAVAILABLE'); }
    }
    const body = record(input), snapshot = record(body?.snapshot);
    if (body?.jobId !== row.id || !snapshot) throw new DomainError(503, 'RAG_TARGET_SNAPSHOT_UNAVAILABLE');
    const target = record(snapshot.vectorTarget), embedding = record(snapshot.embedding);
    // Another model's published index is outside this query, including its old target.
    if (typeof embedding?.profile === 'string' && embedding.profile && embedding.profile !== this.config.rag.embeddingProfile) return undefined;
    if (snapshot.version !== 'file-processing' || snapshot.providerMode !== this.config.rag.providerMode
      || snapshot.businessStore !== storeIdentity(this.config.databaseUrl) || !target || !embedding
      || target.connectionId !== vectorConnectionId(this.config)
      || typeof target.database !== 'string' || !target.database || target.database.length > 256
      || typeof target.collection !== 'string' || !target.collection || target.collection.length > 256 || target.partition !== undefined
      || embedding.baseUrl !== this.config.rag.embeddingBaseUrl) throw new DomainError(503, 'RAG_TARGET_UNAVAILABLE');
    if (typeof embedding.model !== 'string' || !embedding.model || !Number.isSafeInteger(embedding.dimensions) || Number(embedding.dimensions) < 1
      || typeof embedding.profile !== 'string' || !embedding.profile) throw new DomainError(503, 'RAG_INDEX_PROFILE_INVALID');
    return snapshot as unknown as FileProcessingSnapshot;
  }

  private async activeBuilds(scope: Scope, documentKey?: string): Promise<ActiveBuild[]> {
    const rows = await transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      return (await tx.query<ActiveJobRow>(`SELECT j.id,j.workspace_id,j.created_by,j.source_type,j.active_task_id,i.body AS task_input,
          (SELECT count(*)::int FROM text_ingestion_chunks c WHERE c.parent_id=j.id AND c.task_id=j.active_task_id AND c.index_status='ready') AS chunk_count
        FROM text_ingestion_jobs j
        JOIN workspaces w ON w.id=j.workspace_id AND w.user_id=j.created_by AND w.state='ready'
        JOIN tasks t ON t.id=j.active_task_id AND t.user_id=j.created_by AND t.workspace_id=j.workspace_id
        JOIN task_inputs i ON i.id=t.input_id AND i.user_id=t.user_id AND i.workspace_id=t.workspace_id
        WHERE j.created_by=$1 AND j.active_task_id IS NOT NULL AND ($2::text IS NULL OR j.id::text=$2)
        ORDER BY j.created_at DESC,j.id`, [scope.userId, documentKey ?? null])).rows;
    });
    if (documentKey && !rows.length) throw new DomainError(404, 'RAG_DOCUMENT_NOT_FOUND');
    const builds: ActiveBuild[] = [];
    for (const row of rows) {
      const snapshot = this.snapshot(row);
      if (snapshot && Number(row.chunk_count) > 0) builds.push({ ...row, snapshot });
    }
    return builds;
  }

  private groups(builds: ActiveBuild[]): SearchGroup[] {
    const groups = new Map<string, SearchGroup>();
    for (const build of builds) {
      const { vectorTarget: target, embedding } = build.snapshot;
      const key = JSON.stringify([target.connectionId, target.database, target.collection, embedding.model, embedding.dimensions, build.workspace_id]);
      const group = groups.get(key) ?? { target: Object.freeze({ ...target }), model: embedding.model, dimensions: embedding.dimensions, workspaceId: build.workspace_id, builds: [] };
      group.builds.push(build); groups.set(key, group);
    }
    return [...groups.values()];
  }

  private index(target: VectorTarget): VectorIndex {
    if (this.dependencies.milvus) return this.dependencies.milvus;
    if (this.config.rag.providerMode !== 'live') throw new DomainError(503, 'RAG_SEARCH_UNAVAILABLE');
    const key = JSON.stringify([target.connectionId, target.database, target.collection]);
    let index = this.indexes.get(key);
    if (!index) {
      index = new MilvusRepository({ ...this.config.milvus, database: target.database, collection: target.collection, createIfMissing: false });
      this.indexes.set(key, index);
    }
    return index;
  }

  private async hydrate(scope: Scope, group: SearchGroup, hits: MilvusSearchHit[], mode: RagQueryMode): Promise<RagSearchCandidate[]> {
    const uniqueHits = new Map<string, MilvusSearchHit>();
    for (const hit of hits) {
      if (hit.state !== 'ready' || !hit.chunkKey || !finite(hit.score)) continue;
      const old = uniqueHits.get(hit.chunkKey);
      if (!old || hit.score > old.score) uniqueHits.set(hit.chunkKey, hit);
    }
    if (!uniqueHits.size) return [];
    const rows = await transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      return (await tx.query<ChunkRow>(`SELECT c.chunk_key,c.parent_id,c.task_id,c.ordinal,c.content,c.source_hash
        FROM text_ingestion_chunks c
        JOIN text_ingestion_jobs j ON j.id=c.parent_id AND j.active_task_id=c.task_id
        JOIN workspaces w ON w.id=j.workspace_id AND w.user_id=j.created_by AND w.state='ready'
        JOIN jsonb_to_recordset($4::jsonb) AS allowed(parent_id uuid,task_id uuid)
          ON allowed.parent_id=c.parent_id AND allowed.task_id=c.task_id
        WHERE j.created_by=$1 AND j.workspace_id=$2 AND c.index_status='ready' AND c.chunk_key=ANY($3::text[])`,
      [scope.userId, group.workspaceId, [...uniqueHits.keys()], JSON.stringify(group.builds.map(build => ({ parent_id: build.id, task_id: build.active_task_id })))])).rows;
    });
    const byBuild = new Map(group.builds.map(build => [`${build.id}:${build.active_task_id}`, build]));
    const candidates: RagSearchCandidate[] = [];
    for (const row of rows) {
      const build = byBuild.get(`${row.parent_id}:${row.task_id}`), hit = uniqueHits.get(row.chunk_key);
      if (!build || !hit) continue;
      if (!row.source_hash) throw new DomainError(503, 'RAG_INDEX_SOURCE_INVALID');
      candidates.push({
        chunkKey: row.chunk_key, documentKey: row.parent_id, parentId: row.parent_id,
        content: row.content, chunkIndex: Number(row.ordinal), chunkCount: Number(build.chunk_count),
        denseScore: mode === 'dense' ? hit.score : 0, keywordScore: mode === 'keyword' ? hit.score : 0,
        rrfScore: mode === 'hybrid' ? hit.score : 0,
        embeddingProfile: build.snapshot.embedding.profile, indexBuildId: row.task_id,
        metadata: { versionId: row.task_id, sourceRevision: row.source_hash, ingestionSourceType: build.source_type },
      });
    }
    return candidates;
  }

  async query(scope: Scope, input: TextIngestionQueryInput): Promise<TextIngestionQueryResult> {
    const query = input.query?.trim(), mode = input.mode ?? 'hybrid', documentKey = input.documentKey ?? input.documentId;
    if (!query || query.length > 2000) throw new DomainError(400, 'RAG_QUERY_INVALID');
    if (!['dense', 'keyword', 'hybrid'].includes(mode)) throw new DomainError(400, 'RAG_QUERY_MODE_INVALID');
    if (documentKey && !/^[A-Za-z0-9._:-]{1,128}$/u.test(documentKey)) throw new DomainError(400, 'RAG_DOCUMENT_KEY_INVALID');
    const topK = Math.max(1, Math.min(50, Number.isInteger(input.topK) ? input.topK! : 10));
    const limit = Math.max(topK, mode === 'dense' ? this.config.milvus.denseCandidates : mode === 'keyword' ? this.config.milvus.bm25Candidates : this.config.milvus.hybridCandidates);
    const builds = await this.activeBuilds(scope, documentKey);
    let candidates: RagSearchCandidate[] = [];
    const score = (candidate: RagSearchCandidate) => mode === 'dense' ? candidate.denseScore : mode === 'keyword' ? candidate.keywordScore : candidate.rrfScore;
    const vectors = new Map<string, number[]>();
    try {
      for (const group of this.groups(builds)) {
        const index = this.index(group.target);
        await index.ensureReady(group.dimensions);
        const options = { dimensions: group.dimensions, limit, scope: {
          userId: scope.userId, workspaceId: group.workspaceId, sourceType: 'text' as const,
          versions: group.builds.map(build => ({ documentId: build.id, versionId: build.active_task_id, embeddingProfile: build.snapshot.embedding.profile, indexBuildId: build.active_task_id })),
        } };
        let hits: MilvusSearchHit[];
        if (mode === 'keyword') hits = await index.searchKeyword(query, options);
        else {
          const key = JSON.stringify([group.model, group.dimensions]);
          let vector = vectors.get(key);
          if (!vector) {
            const embedding: EmbeddingClient = this.dependencies.embedding ?? processingEmbedding(this.config, group.model, group.dimensions);
            if (embedding.model !== group.model || embedding.dimensions !== group.dimensions) throw new DomainError(503, 'RAG_INDEX_PROFILE_INVALID');
            const result = await embedding.embed([query]);
            vector = result[0];
            if (result.length !== 1 || !vector || vector.length !== group.dimensions || vector.some(value => !finite(value))) throw new DomainError(503, 'RAG_SEARCH_UNAVAILABLE');
            vectors.set(key, vector);
          }
          hits = mode === 'dense' ? await index.search(vector, options) : await index.hybridSearch(vector, query, options);
        }
        candidates.push(...await this.hydrate(scope, group, hits, mode));
        candidates.sort((a, b) => score(b) - score(a));
        const seen = new Set<string>();
        candidates = candidates.filter(candidate => { if (seen.has(candidate.chunkKey)) return false; seen.add(candidate.chunkKey); return true; }).slice(0, limit);
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(503, 'RAG_SEARCH_UNAVAILABLE');
    }

    if (this.rerank && candidates.length) {
      try {
        const authoritative = new Map(candidates.map(candidate => [candidate.chunkKey, { ...candidate, metadata: { ...candidate.metadata } }]));
        const ranked = await this.rerank.rerank(query, candidates);
        const byKey = new Map<string, RagSearchCandidate>();
        for (const result of ranked) {
          const original = authoritative.get(result.chunkKey);
          if (!original || !finite(result.rerankScore)) throw new DomainError(503, 'RAG_RERANK_UNAVAILABLE');
          const previous = byKey.get(result.chunkKey);
          if (!previous || result.rerankScore > previous.rerankScore!) byKey.set(result.chunkKey, { ...original, rerankScore: result.rerankScore });
        }
        candidates = [...byKey.values()].sort((a, b) => b.rerankScore! - a.rerankScore!);
      } catch { throw new DomainError(503, 'RAG_RERANK_UNAVAILABLE'); }
    }
    const results: Array<Record<string, unknown>> = [];
    for (const candidate of candidates.slice(0, topK)) {
      const content = this.dependencies.resolveAssets ? await this.dependencies.resolveAssets(candidate.content, candidate.parentId, scope) : candidate.content;
      results.push({ ...candidate, content, chunkId: candidate.chunkKey, uniqKey: candidate.chunkKey,
        sourceType: 'text', sourceRevision: candidate.metadata?.sourceRevision, ingestionSourceType: candidate.metadata?.ingestionSourceType,
        chunkOrdinal: candidate.chunkIndex,
        evidence: { child: content }, context: null,
      });
    }
    return { mode, query, results };
  }
}
