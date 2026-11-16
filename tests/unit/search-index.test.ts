import { describe, it, expect, vi } from 'vitest';
import { createSearchIndex, requireIndexKind, type IndexFactories } from '../../src/lib/search-index/factory.js';
import { createCompositeHybridIndex, reciprocalRankFusion } from '../../src/lib/search-index/composite.js';
import { indexKeywordChunks } from '../../src/lib/search-index/keyword-indexing.js';
import { SearchIndexError, validateSearch, type IndexBinding, type KeywordIndex, type VectorIndex, type KeywordPoint, type VectorPoint, type SearchOptions } from '../../src/lib/search-index/types.js';

// These adapters deliberately have no Milvus SDK, database/collection names,
// embedding provider, native hybrid method or business source-type enum.
class KeywordBackend implements KeywordIndex {
  readonly kind = 'keyword';
  readonly points = new Map<string, KeywordPoint>();
  async ensureReady() {}
  async upsert(points: readonly KeywordPoint[]) { for (const point of points) this.points.set(point.id, { ...point }); }
  async searchKeyword(query: string, options: SearchOptions) {
    validateSearch(options);
    return [...this.points.values()].filter(p => matches(p, options) && p.content.includes(query))
      .slice(0, options.limit).map((p, i) => ({ chunkKey: p.id, content: p.content, score: 100_000 - i }));
  }
  async deletePoints(ids: readonly string[]) { for (const id of ids) this.points.delete(id); }
  async close() {}
}
class VectorBackend implements VectorIndex {
  readonly kind = 'vector';
  readonly points = new Map<string, VectorPoint>();
  async ensureReady() {}
  async upsert(points: readonly VectorPoint[]) { for (const point of points) this.points.set(point.id, { ...point }); }
  async search(vector: readonly number[], options: SearchOptions) {
    validateSearch(options);
    return [...this.points.values()].filter(p => matches(p, options))
      .map(p => ({ chunkKey: p.id, content: p.content, score: vector.reduce((sum, v, i) => sum + v * (p.embedding[i] ?? 0), 0) }))
      .sort((a, b) => b.score - a.score).slice(0, options.limit);
  }
  async deletePoints(ids: readonly string[]) { for (const id of ids) this.points.delete(id); }
  async close() {}
}
function matches(p: KeywordPoint | VectorPoint, options: SearchOptions) {
  return p.userId === options.scope.userId && p.workspaceId === options.scope.workspaceId
    && options.scope.pointIds.includes(p.id)
    && (!options.filter?.sourceIds || options.filter.sourceIds.includes(p.sourceId))
    && (!options.filter?.sourceTypes || options.filter.sourceTypes.includes(p.sourceType));
}
const point = (id: string): VectorPoint => ({ id, sourceId: 'source', sourceType: 'future-business', userId: 'user', workspaceId: 'workspace', content: 'needle ' + id, embedding: [1, 0] });
const search: SearchOptions = { scope: { userId: 'user', workspaceId: 'workspace', pointIds: ['a', 'b', 'c'] }, limit: 3, filter: { sourceTypes: ['future-business'] } };
const fusion = { keywordCandidates: 10, vectorCandidates: 20, rrfK: 60 };

describe('portable index capabilities and provider selection', () => {
  it('runs keyword writes/search/delete through a class adapter with no vector or Milvus operations', async () => {
    const keyword = new KeywordBackend(), nativeHybrid = vi.fn();
    const factory = vi.fn((_binding: Readonly<IndexBinding>) => { void _binding; return keyword; });
    const binding = { connectionId: 'alternative-keyword-connection', index: 'logical-search-alias' };
    const index = createSearchIndex('keyword', binding, { keyword: factory, hybrid: nativeHybrid });
    expect(Object.isFrozen(factory.mock.calls[0]![0])).toBe(true);
    await index.ensureReady();
    const { embedding: ignored, ...text } = point('a'); void ignored;
    const writes = await indexKeywordChunks([text], index, { batchSize: 1 });
    expect(writes[0]!.status).toBe('indexed');
    await index.upsert([text]); expect(keyword.points.size).toBe(1);
    expect((await index.searchKeyword('needle', search)).map(h => h.chunkKey)).toEqual(['a']);
    await index.deletePoints(['a']); await index.deletePoints(['a']);
    expect(await index.searchKeyword('needle', search)).toEqual([]);
    expect(nativeHybrid).not.toHaveBeenCalled();
    expect(index).not.toHaveProperty('search'); expect(index).not.toHaveProperty('hybridSearch');
  });

  it('requires explicit providers and rejects wrong capabilities without fallback', () => {
    const binding = { connectionId: 'connection', index: 'index' };
    expect(() => createSearchIndex('keyword', binding, {})).toThrow('SEARCH_INDEX_PROVIDER_NOT_CONFIGURED');
    expect(() => createSearchIndex('keyword', binding, { keyword: () => new VectorBackend() } as unknown as IndexFactories)).toThrow('SEARCH_INDEX_CAPABILITY_MISMATCH');
    expect(() => requireIndexKind(new KeywordBackend(), 'hybrid')).toThrow('SEARCH_INDEX_CAPABILITY_MISMATCH');
  });

  it('keeps both tenant dimensions, authorized IDs and metadata conditions conjunctive', async () => {
    const index = new KeywordBackend();
    const rows = [point('a'), { ...point('b'), userId: 'another-user' }, { ...point('c'), workspaceId: 'another-workspace' }, { ...point('d'), sourceId: 'another-source' }];
    await index.upsert(rows.map(({ embedding: ignored, ...text }) => { void ignored; return text; }));
    expect((await index.searchKeyword('needle', { ...search, scope: { ...search.scope, pointIds: ['a', 'b', 'c', 'd'] }, filter: { sourceIds: ['source'] } })).map(h => h.chunkKey)).toEqual(['a']);
    expect(() => validateSearch({ ...search, scope: { ...search.scope, pointIds: [] } })).toThrow('SEARCH_INDEX_SCOPE_REQUIRED');
    expect(() => validateSearch({ ...search, filter: { raw: 'true' } } as unknown as SearchOptions)).toThrow('SEARCH_INDEX_FILTER_INVALID');
    expect(() => validateSearch({ ...search, filter: { sourceTypes: [] } })).toThrow('SEARCH_INDEX_FILTER_INVALID');
    expect(() => validateSearch({ ...search, limit: 0 })).toThrow('SEARCH_INDEX_LIMIT_INVALID');
  });
});

describe('application-side hybrid retrieval', () => {
  it('retrieves independently from keyword/vector engines and fuses by rank instead of raw score', async () => {
    const keyword = new KeywordBackend(), vector = new VectorBackend();
    await keyword.upsert([point('a'), point('b')].map(({ embedding: ignored, ...text }) => { void ignored; return text; }));
    await vector.upsert([point('b'), { ...point('c'), embedding: [0.5, 0] }]);
    const keywordRead = vi.spyOn(keyword, 'searchKeyword'), vectorRead = vi.spyOn(vector, 'search');
    const hybrid = createCompositeHybridIndex(keyword, vector, fusion);
    const result = await hybrid.hybridSearch([1, 0], 'needle', search);
    expect(result.map(h => h.chunkKey)).toEqual(['b', 'a', 'c']);
    expect(result[0]!.score).toBeCloseTo(1 / 62 + 1 / 61);
    expect(keywordRead.mock.calls[0]![1]).toMatchObject({ scope: search.scope, filter: search.filter, limit: 10 });
    expect(vectorRead.mock.calls[0]![1]).toMatchObject({ scope: search.scope, filter: search.filter, limit: 20 });
    // Embedding, canonical-body hydration and model reranking stay outside here.
    expect((await hybrid.searchKeyword('needle', search)).map(h => h.chunkKey)).toEqual(['a', 'b']);
    expect((await hybrid.search([1, 0], search)).map(h => h.chunkKey)).toEqual(['b', 'c']);
  });

  it('fans writes out with stable IDs and excludes vectors from keyword payloads', async () => {
    const keyword = new KeywordBackend(), vector = new VectorBackend(), hybrid = createCompositeHybridIndex(keyword, vector, fusion);
    await hybrid.upsert([point('a')]); await hybrid.upsert([point('a')]);
    expect(keyword.points.size).toBe(1); expect(vector.points.size).toBe(1);
    expect(keyword.points.get('a')).not.toHaveProperty('embedding');
    expect(vector.points.get('a')!.embedding).toEqual([1, 0]);
    await hybrid.deletePoints(['a']); await hybrid.deletePoints(['a']);
    expect(keyword.points.size).toBe(0); expect(vector.points.size).toBe(0);
  });

  it('awaits both writes and rejects partial failure so a caller cannot publish success early', async () => {
    const keyword = new KeywordBackend(), vector = new VectorBackend();
    const failure = vi.spyOn(keyword, 'upsert').mockRejectedValueOnce(new SearchIndexError('KEYWORD_BULK_PARTIAL_FAILURE', true));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const write = vector.upsert.bind(vector);
    vi.spyOn(vector, 'upsert').mockImplementationOnce(async points => { await gate; await write(points); });
    const hybrid = createCompositeHybridIndex(keyword, vector, fusion);
    let completed = false;
    const pending = hybrid.upsert([point('a')]).then(() => { completed = true; return 'published'; }, error => { completed = true; return (error as SearchIndexError).code; });
    await vi.waitFor(() => expect(failure).toHaveBeenCalledTimes(1)); expect(completed).toBe(false);
    release(); expect(await pending).toBe('KEYWORD_BULK_PARTIAL_FAILURE');
    expect(vector.points.has('a')).toBe(true); expect(keyword.points.has('a')).toBe(false);
    await hybrid.upsert([point('a')]); expect(vector.points.size).toBe(1); expect(keyword.points.size).toBe(1);
  });

  it('does not silently degrade a failed branch and waits for the other reader before releasing resources', async () => {
    const keyword = new KeywordBackend(), vector = new VectorBackend();
    vi.spyOn(keyword, 'searchKeyword').mockRejectedValue(new SearchIndexError('KEYWORD_UNAVAILABLE', true));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const other = vi.spyOn(vector, 'search').mockImplementation(async () => { await gate; return []; });
    const hybrid = createCompositeHybridIndex(keyword, vector, fusion);
    let completed = false;
    const pending = hybrid.hybridSearch([1, 0], 'needle', search).then(() => 'unexpected success', error => { completed = true; return (error as SearchIndexError).code; });
    await vi.waitFor(() => expect(other).toHaveBeenCalledTimes(1)); expect(completed).toBe(false);
    release(); expect(await pending).toBe('KEYWORD_UNAVAILABLE');
  });

  it('attempts cleanup/close on both owned engines even if one fails', async () => {
    const keyword = new KeywordBackend(), vector = new VectorBackend();
    vi.spyOn(keyword, 'close').mockRejectedValue(new Error('close failed'));
    const other = vi.spyOn(vector, 'close');
    await expect(createCompositeHybridIndex(keyword, vector, fusion).close()).rejects.toThrow('close failed');
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('deduplicates within each branch and rejects conflicting evidence for one physical ID', () => {
    const hit = { chunkKey: 'a', score: 9, content: 'same body' };
    expect(reciprocalRankFusion([[hit, hit], [hit]], 3, 60)).toEqual([{ ...hit, score: 2 / 61 }]);
    expect(() => reciprocalRankFusion([[hit], [{ ...hit, content: 'different body' }]], 3, 60)).toThrow('SEARCH_INDEX_CONTENT_CONFLICT');
    expect(() => reciprocalRankFusion([[{ ...hit, score: Number.NaN }]], 3, 60)).toThrow('SEARCH_INDEX_RESPONSE_INVALID');
  });
});
