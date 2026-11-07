import type { TokenCounter } from '../document-processing/types.js';

/** The adapter returns vectors in input order. Provider-specific index fields
 * must be checked and normalized by the embedding adapter before returning. */
export interface EmbeddingAdapter {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
}

export interface VectorTarget {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  readonly partition?: string;
}

export interface IndexRecord {
  readonly id: string;
  readonly embeddingText: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface VectorRecord extends IndexRecord { readonly embedding: number[]; }
export type VectorDeleteSelector =
  | { readonly ids: readonly string[]; readonly scope?: never }
  | { readonly scope: Readonly<Record<string, string | number | boolean>>; readonly ids?: never };

/** Construct one adapter per immutable target. Implementations must honor the
 * signal and must never select a target from record metadata or mutable globals. */
export interface BoundVectorStoreAdapter {
  readonly target: VectorTarget;
  upsert(records: readonly VectorRecord[], options?: { signal?: AbortSignal }): Promise<void>;
  delete(selector: VectorDeleteSelector, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface IndexOptions {
  batchSize?: number;
  concurrency?: number;
  timeoutMs?: number;
  maxRetries?: number;
  maxEmbeddingTokens?: number;
}

export interface IndexDependencies {
  embeddingAdapter: EmbeddingAdapter;
  vectorStoreAdapter: BoundVectorStoreAdapter;
  tokenizer: TokenCounter;
  options?: IndexOptions;
}

export interface IndexItemResult {
  id: string;
  ordinal: number;
  status: 'indexed' | 'failed';
  stage: 'validation' | 'embedding' | 'upsert';
  attempts: number;
  retryable: boolean;
  errorCode?: string;
}

export interface IndexResult {
  target: Readonly<VectorTarget>;
  model: string;
  dimensions: number;
  tokenizer: string;
  successCount: number;
  failedCount: number;
  items: IndexItemResult[];
}

export class IndexingError extends Error {
  constructor(readonly code: string, readonly retryable = false) {
    super(code);
    this.name = 'IndexingError';
  }
}

interface Settings { batchSize: number; concurrency: number; timeoutMs: number; maxRetries: number; maxEmbeddingTokens: number; }

function integer(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < minimum || actual > maximum) throw new IndexingError('INDEX_OPTIONS_INVALID');
  return actual;
}

function settings(options: IndexOptions | undefined, tokenizer: TokenCounter): Settings {
  if (!tokenizer.id || !tokenizer.model || !Number.isSafeInteger(tokenizer.maxInputTokens) || tokenizer.maxInputTokens < 1) throw new IndexingError('INDEX_TOKENIZER_INVALID');
  return {
    batchSize: integer(options?.batchSize, 16, 1, 512),
    concurrency: integer(options?.concurrency, 2, 1, 32),
    timeoutMs: integer(options?.timeoutMs, 30_000, 1, 300_000),
    maxRetries: integer(options?.maxRetries, 2, 0, 5),
    maxEmbeddingTokens: integer(options?.maxEmbeddingTokens, tokenizer.maxInputTokens, 1, tokenizer.maxInputTokens),
  };
}

function snapshotTarget(target: VectorTarget): Readonly<VectorTarget> {
  for (const value of [target.connectionId, target.database, target.collection, ...(target.partition === undefined ? [] : [target.partition])]) {
    if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new IndexingError('INDEX_TARGET_INVALID');
  }
  return Object.freeze({ connectionId: target.connectionId, database: target.database, collection: target.collection, ...(target.partition === undefined ? {} : { partition: target.partition }) });
}

function assertTarget(adapter: BoundVectorStoreAdapter, expected: VectorTarget): void {
  if (adapter.target.connectionId !== expected.connectionId || adapter.target.database !== expected.database || adapter.target.collection !== expected.collection || adapter.target.partition !== expected.partition) throw new IndexingError('INDEX_TARGET_CHANGED');
}

function validId(id: unknown): id is string { return typeof id === 'string' && id.trim().length > 0 && id.length <= 1024; }

function cloneMetadata(metadata: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new IndexingError('INDEX_METADATA_INVALID');
  const seen = new Set<object>();
  const clone = (value: unknown, depth: number): unknown => {
    if (depth > 16) throw new IndexingError('INDEX_METADATA_INVALID');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || seen.has(value)) throw new IndexingError('INDEX_METADATA_INVALID');
    seen.add(value);
    let copy: unknown;
    if (Array.isArray(value)) copy = Object.freeze(value.map(child => clone(child, depth + 1)));
    else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) throw new IndexingError('INDEX_METADATA_INVALID');
      copy = Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child, depth + 1)])));
    }
    seen.delete(value);
    return copy;
  };
  return clone(metadata, 0) as Readonly<Record<string, unknown>>;
}

function failure(error: unknown, fallback: string): IndexingError {
  if (error instanceof IndexingError) return error;
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; retryable?: unknown };
    if (typeof candidate.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/u.test(candidate.code)) return new IndexingError(candidate.code, candidate.retryable !== false);
    return new IndexingError(fallback, candidate.retryable !== false);
  }
  return new IndexingError(fallback, true);
}

/** The timeout stops scheduling further work, including retries. This also
 * bounds in-flight calls if a faulty adapter does not honor cancellation. */
async function timed<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new IndexingError('INDEX_OPERATION_TIMEOUT', true)); }, timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function retry<T>(operation: (signal: AbortSignal) => Promise<T>, config: Settings, attempts: { count: number }, fallback: string): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    attempts.count += 1;
    try { return await timed(operation, config.timeoutMs); }
    catch (error) {
      const mapped = failure(error, fallback);
      if (!mapped.retryable || mapped.code === 'INDEX_OPERATION_TIMEOUT' || attempt >= config.maxRetries) throw mapped;
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(100 * 2 ** attempt, 1000)));
    }
  }
}

function validateVectors(vectors: number[][], count: number, dimensions: number): void {
  if (!Array.isArray(vectors) || vectors.length !== count) throw new IndexingError('INDEX_EMBEDDING_COUNT_MISMATCH');
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)) || vector.every(value => value === 0)) throw new IndexingError('INDEX_EMBEDDING_INVALID');
  }
}

/** No parser, repository, source selection or business status mutation occurs
 * here. Successful batches remain successful when another batch fails. */
export async function indexChunks(records: readonly IndexRecord[], dependencies: IndexDependencies): Promise<IndexResult> {
  const { embeddingAdapter, vectorStoreAdapter, tokenizer } = dependencies;
  const config = settings(dependencies.options, tokenizer);
  const target = snapshotTarget(vectorStoreAdapter.target);
  if (!embeddingAdapter.model || embeddingAdapter.model !== tokenizer.model || !Number.isSafeInteger(embeddingAdapter.dimensions) || embeddingAdapter.dimensions < 1) throw new IndexingError('INDEX_MODEL_TOKENIZER_MISMATCH');
  if (!Array.isArray(records)) throw new IndexingError('INDEX_RECORDS_INVALID');
  const seen = new Set<string>();
  for (const record of records) {
    if (record && validId(record.id)) {
      if (seen.has(record.id)) throw new IndexingError('INDEX_DUPLICATE_ID');
      seen.add(record.id);
    }
  }
  const items: IndexItemResult[] = new Array(records.length);
  const ready: Array<{ record: IndexRecord; ordinal: number }> = [];
  // Tokenization is local and sequential: avoid retaining an unbounded set of
  // tokenizer promises or whole-document vectors.
  for (const [ordinal, record] of records.entries()) {
    try {
      if (!record || !validId(record.id) || typeof record.embeddingText !== 'string' || !record.embeddingText.trim()) throw new IndexingError('INDEX_RECORD_INVALID');
      const metadata = cloneMetadata(record.metadata);
      const count = await tokenizer.count(record.embeddingText);
      if (!Number.isSafeInteger(count) || count < 1) throw new IndexingError('INDEX_TOKEN_COUNT_INVALID');
      if (count > config.maxEmbeddingTokens) throw new IndexingError('INDEX_TEXT_TOO_LONG');
      ready.push({ ordinal, record: Object.freeze({ id: record.id, embeddingText: record.embeddingText, metadata }) });
    } catch (error) {
      const mapped = failure(error, 'INDEX_VALIDATION_FAILED');
      items[ordinal] = { id: typeof record?.id === 'string' ? record.id : '', ordinal, status: 'failed', stage: 'validation', attempts: 0, retryable: mapped.retryable, errorCode: mapped.code };
    }
  }
  let cursor = 0;
  let stopScheduling = false;
  const worker = async (): Promise<void> => {
    while (!stopScheduling && cursor < ready.length) {
      const offset = cursor; cursor += config.batchSize;
      const batch = ready.slice(offset, offset + config.batchSize);
      const attempts = { count: 0 };
      let stage: 'embedding' | 'upsert' = 'embedding';
      try {
        assertTarget(vectorStoreAdapter, target);
        const vectors = await retry(signal => embeddingAdapter.embed(batch.map(row => row.record.embeddingText), { signal }), config, attempts, 'INDEX_EMBEDDING_FAILED');
        validateVectors(vectors, batch.length, embeddingAdapter.dimensions);
        stage = 'upsert';
        const rows = batch.map((row, index) => ({ ...row.record, embedding: vectors[index]! }));
        // A failed vector write reuses this batch's valid embeddings.
        await retry(signal => { assertTarget(vectorStoreAdapter, target); return vectorStoreAdapter.upsert(rows, { signal }); }, config, attempts, 'INDEX_VECTOR_WRITE_FAILED');
        for (const row of batch) items[row.ordinal] = { id: row.record.id, ordinal: row.ordinal, status: 'indexed', stage, attempts: attempts.count, retryable: false };
      } catch (error) {
        const mapped = failure(error, 'INDEX_BATCH_FAILED');
        if (mapped.code === 'INDEX_OPERATION_TIMEOUT' || mapped.code === 'INDEX_TARGET_CHANGED') stopScheduling = true;
        for (const row of batch) items[row.ordinal] = { id: row.record.id, ordinal: row.ordinal, status: 'failed', stage, attempts: attempts.count, retryable: mapped.retryable, errorCode: mapped.code };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.concurrency, Math.ceil(ready.length / config.batchSize)) }, worker));
  for (const { record, ordinal } of ready) if (!items[ordinal]) items[ordinal] = { id: record.id, ordinal, status: 'failed', stage: 'embedding', attempts: 0, retryable: true, errorCode: 'INDEX_SCHEDULING_STOPPED' };
  const successCount = items.filter(item => item.status === 'indexed').length;
  return { target, model: embeddingAdapter.model, dimensions: embeddingAdapter.dimensions, tokenizer: tokenizer.id, items, successCount, failedCount: items.length - successCount };
}

export interface DeleteResult { target: Readonly<VectorTarget>; status: 'deleted' | 'failed'; attempts: number; retryable: boolean; errorCode?: string; }

/** Explicit selectors are evaluated only inside the caller's bound target.
 * Adapters translate scope keys to their own supported filter schema. */
export async function deleteVectors(adapter: BoundVectorStoreAdapter, selector: VectorDeleteSelector, options: Pick<IndexOptions, 'batchSize' | 'timeoutMs' | 'maxRetries'> = {}): Promise<DeleteResult> {
  const target = snapshotTarget(adapter.target);
  if (!selector || typeof selector !== 'object' || Array.isArray(selector) || Object.keys(selector).length !== 1 || Object.keys(selector).some(key => key !== 'ids' && key !== 'scope')) throw new IndexingError('INDEX_DELETE_SELECTOR_INVALID');
  let frozen: VectorDeleteSelector;
  if ('ids' in selector && selector.ids !== undefined) {
    if ('scope' in selector || !Array.isArray(selector.ids) || !selector.ids.length || selector.ids.some(id => !validId(id))) throw new IndexingError('INDEX_DELETE_SELECTOR_INVALID');
    frozen = Object.freeze({ ids: Object.freeze([...new Set(selector.ids)]) });
  } else {
    const scope = selector.scope;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) || !Object.keys(scope).length || Object.entries(scope).some(([key, value]) => !key.trim() || !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)) || (typeof value === 'string' && !value.trim()))) throw new IndexingError('INDEX_DELETE_SELECTOR_INVALID');
    frozen = Object.freeze({ scope: Object.freeze({ ...scope }) });
  }
  const config: Settings = { batchSize: integer(options.batchSize, 128, 1, 512), concurrency: 1, timeoutMs: integer(options.timeoutMs, 30_000, 1, 300_000), maxRetries: integer(options.maxRetries, 2, 0, 5), maxEmbeddingTokens: 1 };
  const attempts = { count: 0 };
  try {
    if (frozen.ids) {
      // Deletion is idempotent: a partial failure can retry the original stable
      // IDs. Keep request size bounded without inventing a new cleanup queue.
      for (let offset = 0; offset < frozen.ids.length; offset += config.batchSize) {
        const batch = Object.freeze({ ids: Object.freeze(frozen.ids.slice(offset, offset + config.batchSize)) });
        await retry(signal => { assertTarget(adapter, target); return adapter.delete(batch, { signal }); }, config, attempts, 'INDEX_VECTOR_DELETE_FAILED');
      }
    } else await retry(signal => { assertTarget(adapter, target); return adapter.delete(frozen, { signal }); }, config, attempts, 'INDEX_VECTOR_DELETE_FAILED');
    return { target, status: 'deleted', attempts: attempts.count, retryable: false };
  } catch (error) {
    const mapped = failure(error, 'INDEX_VECTOR_DELETE_FAILED');
    return { target, status: 'failed', attempts: attempts.count, retryable: mapped.retryable, errorCode: mapped.code };
  }
}
