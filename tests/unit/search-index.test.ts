import { describe, it, expect, vi } from 'vitest';
import { createSearchIndex, requireIndexKind, type IndexFactories } from '../../src/lib/search-index/factory.js';
import { indexKeywordChunks } from '../../src/lib/search-index/keyword-indexing.js';
import { validateSearch, type IndexBinding, type KeywordIndex, type VectorIndex, type KeywordPoint, type VectorPoint, type SearchOptions } from '../../src/lib/search-index/types.js';

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
