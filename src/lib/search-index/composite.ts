import { SearchIndexError, validateSearch, type HybridIndex, type KeywordIndex, type VectorIndex, type RecallHit, type SearchOptions, type VectorPoint, type OperationOptions } from './types.js';

export interface FusionOptions {
  readonly keywordCandidates: number;
  readonly vectorCandidates: number;
  readonly rrfK: number;
}

/** Rank fusion, not a model reranker. Duplicate physical IDs contribute once
 * per branch. No comparison of BM25 and vector raw scores across engines. */
export function reciprocalRankFusion(branches: readonly (readonly RecallHit[])[], limit: number, k: number): RecallHit[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(k) || k < 1) {
    throw new SearchIndexError('SEARCH_INDEX_FUSION_INVALID');
  }
  const combined = new Map<string, RecallHit>();
  for (const branch of branches) {
    const seen = new Set<string>();
    for (const hit of branch) {
      if (!hit.chunkKey || typeof hit.content !== 'string' || !Number.isFinite(hit.score)) throw new SearchIndexError('SEARCH_INDEX_RESPONSE_INVALID');
      if (seen.has(hit.chunkKey)) continue;
      seen.add(hit.chunkKey);
      const old = combined.get(hit.chunkKey);
      if (old && old.content !== hit.content) throw new SearchIndexError('SEARCH_INDEX_CONTENT_CONFLICT');
      const score = (old?.score ?? 0) + 1 / (k + seen.size);
      combined.set(hit.chunkKey, { ...hit, score });
    }
  }
  return [...combined.values()].sort((a, b) => b.score - a.score || a.chunkKey.localeCompare(b.chunkKey)).slice(0, limit);
}

/** Owns both supplied indexes. Production can independently bind Milvus vector
 * and Milvus/Elasticsearch keyword adapters. Writes are not distributed
 * transactions: await both branches, reject partial failures, then let the
 * existing durable build publication decide visibility. */
export function createCompositeHybridIndex(keyword: KeywordIndex, vector: VectorIndex, options: FusionOptions): HybridIndex {
  const fusion = Object.freeze({ ...options });
  if ([fusion.keywordCandidates, fusion.vectorCandidates].some(n => !Number.isSafeInteger(n) || n < 1 || n > 1000)
    || !Number.isSafeInteger(fusion.rrfK) || fusion.rrfK < 1) throw new SearchIndexError('SEARCH_INDEX_FUSION_INVALID');
  const both = async (operations: readonly (() => Promise<unknown>)[]) => {
    const results = await Promise.allSettled(operations.map(operation => Promise.resolve().then(operation)));
    const failed = results.find(r => r.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  };
  return {
    kind: 'hybrid',
    ensureReady: () => both([() => keyword.ensureReady(), () => vector.ensureReady()]),
    async upsert(points: readonly VectorPoint[], operation?: OperationOptions) {
      operation?.signal?.throwIfAborted();
      const texts = points.map(point => ({id:point.id,sourceId:point.sourceId,sourceType:point.sourceType,userId:point.userId,workspaceId:point.workspaceId,content:point.content}));
      await both([() => keyword.upsert(texts, operation), () => vector.upsert(points, operation)]);
    },
    deletePoints: (ids, operation) => both([() => keyword.deletePoints(ids, operation), () => vector.deletePoints(ids, operation)]),
    close: () => both([() => keyword.close(), () => vector.close()]),
    searchKeyword: (query, search) => keyword.searchKeyword(query, search),
    search: (embedding, search) => vector.search(embedding, search),
    async hybridSearch(embedding: readonly number[], query: string, search: SearchOptions) {
      validateSearch(search);
      const results = await Promise.allSettled([
        Promise.resolve().then(() => keyword.searchKeyword(query, { ...search, limit: Math.max(search.limit, fusion.keywordCandidates) })),
        Promise.resolve().then(() => vector.search(embedding, { ...search, limit: Math.max(search.limit, fusion.vectorCandidates) })),
      ]);
      const branches = results.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
      return reciprocalRankFusion(branches, search.limit, fusion.rrfK);
    },
  };
}
