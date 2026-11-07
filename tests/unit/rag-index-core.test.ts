import { describe, expect, it, vi } from 'vitest';
import { deleteVectors, indexChunks, type BoundVectorStoreAdapter, type EmbeddingAdapter, type IndexDependencies, type IndexRecord, type VectorTarget } from '../../src/lib/rag-indexing/index.js';

const record = (id: string, text = `text ${id}`): IndexRecord => ({ id, embeddingText: text, metadata: { externalTool: 'standalone', arbitraryId: id } });
const target = (): VectorTarget => ({ connectionId: 'test-only', database: 'db', collection: 'chunks' });
function dependencies(overrides: Partial<IndexDependencies> = {}): IndexDependencies & { vectorStoreAdapter: BoundVectorStoreAdapter; } {
  return {
    tokenizer: { id: 'test-whitespace', model: 'test-model', maxInputTokens: 8, count: text => text.trim().split(/\s+/u).length },
    embeddingAdapter: { model: 'test-model', dimensions: 2, embed: vi.fn<EmbeddingAdapter['embed']>(async texts => texts.map((_text, index) => [index + 1, 0.5])) },
    vectorStoreAdapter: { target: target(), upsert: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
    options: { batchSize: 2, concurrency: 2, maxRetries: 0, timeoutMs: 1000 },
    ...overrides,
  };
}

describe('independent RAG indexing library', () => {
  it('accepts another tool records without business repositories and preserves input/vector order', async () => {
    const deps = dependencies(); const rows = [record('a'), record('b')];
    const result = await indexChunks(rows, deps);
    expect(result).toMatchObject({ successCount: 2, failedCount: 0, model: 'test-model', dimensions: 2, target: target() });
    expect(deps.vectorStoreAdapter.upsert).toHaveBeenCalledWith([
      { ...rows[0], embedding: [1, 0.5] }, { ...rows[1], embedding: [2, 0.5] },
    ], { signal: expect.any(AbortSignal) });
    expect(result.items.map(item => item.id)).toEqual(['a', 'b']);
  });

  it('reports invalid and over-limit records separately without silently truncating them', async () => {
    const deps = dependencies(); const rows = [record('ok'), record('long', 'one two three four five six seven eight nine'), record('empty', '  ')];
    const result = await indexChunks(rows, deps);
    expect(result.items.map(item => [item.id, item.status, item.errorCode])).toEqual([
      ['ok', 'indexed', undefined], ['long', 'failed', 'INDEX_TEXT_TOO_LONG'], ['empty', 'failed', 'INDEX_RECORD_INVALID'],
    ]);
    expect(deps.embeddingAdapter.embed).toHaveBeenCalledTimes(1);
    expect(deps.embeddingAdapter.embed).toHaveBeenCalledWith(['text ok'], expect.any(Object));
  });

  it('rejects duplicate IDs and mismatched model/tokenizer before making provider calls', async () => {
    const deps = dependencies();
    await expect(indexChunks([record('a'), record('a')], deps)).rejects.toMatchObject({ code: 'INDEX_DUPLICATE_ID' });
    await expect(indexChunks([record('a')], { ...deps, tokenizer: { ...deps.tokenizer, model: 'another-model' } })).rejects.toMatchObject({ code: 'INDEX_MODEL_TOKENIZER_MISMATCH' });
    expect(deps.embeddingAdapter.embed).not.toHaveBeenCalled();
  });

  it.each([
    { batchSize: 0 }, { concurrency: 0 }, { maxRetries: 6 }, { timeoutMs: 0 }, { maxEmbeddingTokens: 9 },
  ])('rejects invalid bounded settings %j', async options => {
    const deps = dependencies({ options });
    await expect(indexChunks([record('a')], deps)).rejects.toMatchObject({ code: 'INDEX_OPTIONS_INVALID' });
    expect(deps.embeddingAdapter.embed).not.toHaveBeenCalled();
  });

  it.each<{vectors:number[][]}>([
    {vectors:[]}, {vectors:[[1]]}, {vectors:[[Number.NaN, 1]]}, {vectors:[[0, 0]]}, {vectors:[[1, 1], [2, 2]]},
  ])('rejects malformed embedding response $vectors without writing a vector', async ({vectors}) => {
    const deps = dependencies(); deps.embeddingAdapter.embed = vi.fn(async () => vectors);
    const result = await indexChunks([record('a')], deps);
    expect(result).toMatchObject({ successCount: 0, failedCount: 1 });
    expect(result.items[0]).toMatchObject({ stage: 'embedding', retryable: false });
    expect(deps.vectorStoreAdapter.upsert).not.toHaveBeenCalled();
  });

  it('retries only vector writing with the already computed vectors', async () => {
    const deps = dependencies({ options: { batchSize: 2, concurrency: 1, maxRetries: 1, timeoutMs: 1000 } });
    deps.vectorStoreAdapter.upsert = vi.fn().mockRejectedValueOnce(Object.assign(new Error('private provider error'), { retryable: true })).mockResolvedValue(undefined);
    const result = await indexChunks([record('a'), record('b')], deps);
    expect(result.successCount).toBe(2);
    expect(deps.embeddingAdapter.embed).toHaveBeenCalledTimes(1);
    expect(deps.vectorStoreAdapter.upsert).toHaveBeenCalledTimes(2);
  });

  it('keeps successful batches while returning a safe retryable failure for another batch', async () => {
    const deps = dependencies({ options: { batchSize: 1, concurrency: 2, maxRetries: 0, timeoutMs: 1000 } });
    deps.vectorStoreAdapter.upsert = vi.fn(async rows => { if (rows[0]?.id === 'b') throw new Error('https://secret:password@example.test complete-vector'); });
    const result = await indexChunks([record('a'), record('b'), record('c')], deps);
    expect(result.items.map(item => item.status)).toEqual(['indexed', 'failed', 'indexed']);
    expect(result.items[1]).toMatchObject({ stage: 'upsert', errorCode: 'INDEX_VECTOR_WRITE_FAILED', retryable: true });
    expect(JSON.stringify(result)).not.toContain('password');
    expect(JSON.stringify(result)).not.toContain('complete-vector');
  });

  it('bounds concurrent provider calls', async () => {
    const deps = dependencies({ options: { batchSize: 1, concurrency: 2, maxRetries: 0, timeoutMs: 1000 } });
    let active = 0, maximum = 0;
    deps.embeddingAdapter.embed = vi.fn(async texts => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5)); active -= 1;
      return texts.map(() => [1, 0.5]);
    });
    const result = await indexChunks(Array.from({ length: 7 }, (_, index) => record(String(index))), deps);
    expect(result.successCount).toBe(7); expect(maximum).toBe(2);
  });

  it('fails closed if a shared mutable adapter changes target while embedding', async () => {
    const original = target(); const deps = dependencies(); deps.vectorStoreAdapter = { ...deps.vectorStoreAdapter, target: original };
    deps.embeddingAdapter.embed = vi.fn(async () => { Object.assign(original, { collection: 'another-business' }); return [[1, 0.5]]; });
    const result = await indexChunks([record('a')], deps);
    expect(result.items[0]).toMatchObject({ status: 'failed', errorCode: 'INDEX_TARGET_CHANGED', retryable: false });
    expect(result.target.collection).toBe('chunks'); expect(deps.vectorStoreAdapter.upsert).not.toHaveBeenCalled();
  });

  it('aborts on timeout and stops queued batches without making late vector writes', async () => {
    const deps = dependencies({ options: { batchSize: 1, concurrency: 1, maxRetries: 2, timeoutMs: 5 } });
    let observedAbort = false;
    deps.embeddingAdapter.embed = vi.fn<EmbeddingAdapter['embed']>((_texts, options) => new Promise<number[][]>(resolve => {
      options?.signal?.addEventListener('abort', () => { observedAbort = true; resolve([[1, 0.5]]); }, { once: true });
    }));
    const result = await indexChunks([record('a'), record('b')], deps);
    expect(observedAbort).toBe(true); expect(result.failedCount).toBe(2);
    expect(result.items[0]?.errorCode).toBe('INDEX_OPERATION_TIMEOUT');
    expect(result.items[1]?.errorCode).toBe('INDEX_SCHEDULING_STOPPED');
    expect(deps.embeddingAdapter.embed).toHaveBeenCalledTimes(1); expect(deps.vectorStoreAdapter.upsert).not.toHaveBeenCalled();
  });

  it('snapshots metadata rather than letting callers mutate an in-flight record', async () => {
    const metadata = { upstream: { revision: 1 } }; const deps = dependencies();
    deps.embeddingAdapter.embed = vi.fn(async () => { metadata.upstream.revision = 2; return [[1, 0.5]]; });
    await indexChunks([{ ...record('a'), metadata }], deps);
    expect(deps.vectorStoreAdapter.upsert).toHaveBeenCalledWith([expect.objectContaining({ metadata: { upstream: { revision: 1 } } })], expect.any(Object));
  });

  it('deletes only explicit identities or a supplied nonempty scope in the bound target', async () => {
    const deps = dependencies();
    expect(await deleteVectors(deps.vectorStoreAdapter, { ids: ['a', 'a', 'b'] })).toMatchObject({ status: 'deleted', target: target() });
    expect(deps.vectorStoreAdapter.delete).toHaveBeenCalledWith({ ids: ['a', 'b'] }, expect.any(Object));
    const scope = { source_type: 'external', parent_id: 'whole-item', source_revision: 'old' };
    expect(await deleteVectors(deps.vectorStoreAdapter, { scope })).toMatchObject({ status: 'deleted' });
    expect(deps.vectorStoreAdapter.delete).toHaveBeenLastCalledWith({ scope }, expect.any(Object));
    await expect(deleteVectors(deps.vectorStoreAdapter, { ids: [] })).rejects.toMatchObject({ code: 'INDEX_DELETE_SELECTOR_INVALID' });
    await expect(deleteVectors(deps.vectorStoreAdapter, { scope: {} })).rejects.toMatchObject({ code: 'INDEX_DELETE_SELECTOR_INVALID' });
  });

  it('bounds delete ID batches and reports partial deletion as retryable', async () => {
    const deps=dependencies();
    deps.vectorStoreAdapter.delete=vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('provider failure'));
    const result=await deleteVectors(deps.vectorStoreAdapter,{ids:['a','b','c']},{batchSize:1,maxRetries:0});
    expect(result).toMatchObject({status:'failed',retryable:true,attempts:2,errorCode:'INDEX_VECTOR_DELETE_FAILED'});
    expect(deps.vectorStoreAdapter.delete).toHaveBeenNthCalledWith(1,{ids:['a']},expect.any(Object));
    expect(deps.vectorStoreAdapter.delete).toHaveBeenNthCalledWith(2,{ids:['b']},expect.any(Object));
    expect(deps.vectorStoreAdapter.delete).toHaveBeenCalledTimes(2);
  });
});
