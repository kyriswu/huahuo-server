/** Storage/search capabilities, independent of business entities and engines. */
export type IndexKind = 'keyword' | 'vector' | 'hybrid';

/** Opaque connection identity and logical index. Adapters map these to their
 * own database/collection, index/alias, routing and connection configuration. */
export interface IndexBinding {
  readonly connectionId: string;
  readonly index: string;
  readonly namespace?: string;
}

export interface TextPoint {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceType: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly content: string;
}
export interface KeywordPoint extends TextPoint { readonly embedding?: never; }
export interface VectorPoint extends TextPoint { readonly embedding: readonly number[]; }
export type IndexPoint = KeywordPoint | VectorPoint;

/** Supplied by the owning service after authorization/version checks. An empty
 * point set is invalid, never shorthand for searching all tenant data. */
export interface RecallScope {
  readonly userId: string;
  readonly workspaceId: string;
  readonly pointIds: readonly string[];
}
/** Allowlisted metadata conditions. No raw engine expression or query DSL. */
export interface RecallFilter {
  readonly sourceIds?: readonly string[];
  readonly sourceTypes?: readonly string[];
}
export interface OperationOptions { readonly signal?: AbortSignal; }
export interface SearchOptions extends OperationOptions {
  readonly scope: RecallScope;
  readonly limit: number;
  readonly filter?: RecallFilter;
}
/** Scores order results from this search only; scores from different engines
 * or retrieval methods are not assumed to be on a common scale. */
export interface RecallHit { chunkKey: string; score: number; content: string; }

export interface IndexLifecycle {
  ensureReady(): Promise<void>;
  /** Idempotent by stable IDs. Success makes removals visible to later search. */
  deletePoints(ids: readonly string[], options?: OperationOptions): Promise<void>;
  close(): Promise<void>;
}
export interface KeywordReader {
  searchKeyword(query: string, options: SearchOptions): Promise<RecallHit[]>;
}
export interface VectorReader {
  search(vector: readonly number[], options: SearchOptions): Promise<RecallHit[]>;
}
/** Upsert is idempotent by ID. Resolve only when every item succeeded and is
 * visible to subsequent search. Partial bulk errors must reject. Rejection or
 * cancellation may follow a partial write; it is not evidence of rollback.
 * Callers publish durable builds only after success. */
export interface KeywordIndex extends IndexLifecycle, KeywordReader {
  readonly kind: 'keyword';
  upsert(points: readonly KeywordPoint[], options?: OperationOptions): Promise<void>;
}
export interface VectorIndex extends IndexLifecycle, VectorReader {
  readonly kind: 'vector';
  upsert(points: readonly VectorPoint[], options?: OperationOptions): Promise<void>;
}
/** Can be engine-native or composed from independent keyword/vector indexes.
 * Fusion returns candidates; model reranking remains a separate layer. */
export interface HybridIndex extends IndexLifecycle, KeywordReader, VectorReader {
  readonly kind: 'hybrid';
  upsert(points: readonly VectorPoint[], options?: OperationOptions): Promise<void>;
  hybridSearch(vector: readonly number[], query: string, options: SearchOptions): Promise<RecallHit[]>;
}
export type SearchIndex = KeywordIndex | VectorIndex | HybridIndex;

export class SearchIndexError extends Error {
  constructor(readonly code: string, readonly retryable = false, options?: ErrorOptions) {
    super(code, options);
    this.name = 'SearchIndexError';
  }
}

export function validateScope(scope: RecallScope): void {
  if (!scope || typeof scope.userId !== 'string' || !scope.userId.trim()
    || typeof scope.workspaceId !== 'string' || !scope.workspaceId.trim()
    || !Array.isArray(scope.pointIds) || !scope.pointIds.length
    || scope.pointIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw new SearchIndexError('SEARCH_INDEX_SCOPE_REQUIRED');
  }
}
export function validateSearch(options: SearchOptions): void {
  validateScope(options?.scope);
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
    throw new SearchIndexError('SEARCH_INDEX_LIMIT_INVALID');
  }
  if (options.filter !== undefined) {
    const filter = options.filter;
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)
      || Object.keys(filter).some(key => !['sourceIds', 'sourceTypes'].includes(key))) {
      throw new SearchIndexError('SEARCH_INDEX_FILTER_INVALID');
    }
    for (const values of Object.values(filter)) {
      if (!Array.isArray(values) || !values.length || values.some(v => typeof v !== 'string' || !v.trim())) {
        throw new SearchIndexError('SEARCH_INDEX_FILTER_INVALID');
      }
    }
  }
  options.signal?.throwIfAborted();
}
