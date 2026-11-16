import { SearchIndexError, type IndexBinding, type IndexKind, type KeywordIndex, type VectorIndex, type HybridIndex } from './types.js';

interface IndexByKind { keyword: KeywordIndex; vector: VectorIndex; hybrid: HybridIndex; }
export type IndexFactories = { [K in IndexKind]?: (binding: Readonly<IndexBinding>) => IndexByKind[K] };

export function requireIndexKind<K extends IndexKind>(index: KeywordIndex | VectorIndex | HybridIndex, kind: K): IndexByKind[K] {
  if (index.kind !== kind) throw new SearchIndexError('SEARCH_INDEX_CAPABILITY_MISMATCH');
  return index as IndexByKind[K];
}

/** Composition root supplies each capability independently. No implicit
 * provider fallback: a keyword factory can use Elasticsearch while vector
 * and native hybrid factories continue to use Milvus. */
export function createSearchIndex<K extends IndexKind>(kind: K, binding: IndexBinding, factories: IndexFactories): IndexByKind[K] {
  if (typeof binding.connectionId !== 'string' || !binding.connectionId.trim()
    || typeof binding.index !== 'string' || !binding.index.trim()
    || binding.namespace !== undefined && (typeof binding.namespace !== 'string' || !binding.namespace.trim())) {
    throw new SearchIndexError('SEARCH_INDEX_BINDING_INVALID');
  }
  const factory = factories[kind];
  if (!factory) throw new SearchIndexError('SEARCH_INDEX_PROVIDER_NOT_CONFIGURED');
  const index = factory(Object.freeze({ ...binding }));
  return requireIndexKind(index, kind);
}
