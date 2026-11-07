import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingAdapter } from '../../src/lib/rag-indexing/index.js';
import { cachedEmbedding } from '../../src/modules/rag/embedding-cache.js';
import { LocalStorageAdapter, type StoragePort } from '../../src/modules/storage/port.js';

let directory: string;
let storage: LocalStorageAdapter;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'huahuo-embedding-cache-')); storage = new LocalStorageAdapter(directory); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const vectors = [[0.1, 0.2], [0.3, 0.4]]; // Small synthetic responses, no model call.
const texts = ['first prepared text', 'second prepared text'];
const scope = JSON.stringify(['file', 'shared-id', 'revision-1', 'target-1']);
function provider() {
  const embed = vi.fn<EmbeddingAdapter['embed']>().mockResolvedValue(vectors);
  return { model: 'explicit-test-model', dimensions: 2, embed };
}

describe('business Embedding stage artifact', () => {
  it('recovers vectors from actual storage after constructing a new Worker wrapper', async () => {
    const first = provider(); const put = vi.spyOn(storage, 'put');
    expect(await cachedEmbedding(first, storage, scope).embed(texts)).toEqual(vectors);
    expect(first.embed).toHaveBeenCalledExactlyOnceWith(texts, undefined);
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0]?.[0]).toMatch(/^rag\/index-artifacts\/[a-f0-9]{64}\.json$/u);
    const restarted = provider();
    expect(await cachedEmbedding(restarted, storage, scope).embed(texts)).toEqual(vectors);
    expect(restarted.embed).not.toHaveBeenCalled();
  });

  it('does not reuse another source, revision, model, dimension or prepared text', async () => {
    const original = provider(); await cachedEmbedding(original, storage, scope).embed(texts);
    for (const changed of [JSON.stringify(['note', 'shared-id', 'revision-1', 'target-1']), JSON.stringify(['file', 'shared-id', 'revision-2', 'target-1']), JSON.stringify(['file', 'shared-id', 'revision-1', 'target-2'])]) {
      const next = provider(); await cachedEmbedding(next, storage, changed).embed(texts); expect(next.embed).toHaveBeenCalledOnce();
    }
    const changedText = provider(); await cachedEmbedding(changedText, storage, scope).embed(['changed prepared text', texts[1]!]); expect(changedText.embed).toHaveBeenCalledOnce();
    const changedModel = { ...provider(), model: 'different-test-model' }; await cachedEmbedding(changedModel, storage, scope).embed(texts); expect(changedModel.embed).toHaveBeenCalledOnce();
    const changedDimensions = { ...provider(), dimensions: 3 }; changedDimensions.embed.mockResolvedValue([[1, 2, 3], [4, 5, 6]]);
    await cachedEmbedding(changedDimensions, storage, scope).embed(texts); expect(changedDimensions.embed).toHaveBeenCalledOnce();
  });

  it('never treats a corrupt artifact as a successful Embedding response', async () => {
    const put = vi.spyOn(storage, 'put'); await cachedEmbedding(provider(), storage, scope).embed(texts);
    const key = put.mock.calls[0]![0];
    await writeFile(join(directory, key), '{broken-json');
    const recovering = provider();
    expect(await cachedEmbedding(recovering, storage, scope).embed(texts)).toEqual(vectors);
    expect(recovering.embed).toHaveBeenCalledOnce();
    const nextRestart = provider();
    expect(await cachedEmbedding(nextRestart, storage, scope).embed(texts)).toEqual(vectors);
    expect(nextRestart.embed).not.toHaveBeenCalled();
  });

  it('honors an aborted request before reading a valid cache or making a provider request', async () => {
    await cachedEmbedding(provider(), storage, scope).embed(texts);
    const read = vi.spyOn(storage, 'read'); const adapter = provider();
    const controller = new AbortController(); controller.abort();
    await expect(cachedEmbedding(adapter, storage, scope).embed(texts, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled(); expect(adapter.embed).not.toHaveBeenCalled();
  });

  it.each<{ reason: string; result: number[][] }>([
    { reason: 'count', result: [[1, 2]] },
    { reason: 'dimensions', result: [[1, 2, 3], [4, 5, 6]] },
    { reason: 'NaN', result: [[1, Number.NaN], [2, 3]] },
    { reason: 'Infinity', result: [[1, 2], [3, Number.POSITIVE_INFINITY]] },
    { reason: 'zero vector', result: [[0, 0], [2, 3]] },
  ])('does not persist an invalid provider $reason response', async ({ result }) => {
    const adapter = provider(); adapter.embed.mockResolvedValue(result); const put = vi.spyOn(storage, 'put');
    await expect(cachedEmbedding(adapter, storage, scope).embed(texts)).rejects.toThrow('EMBEDDING_RESPONSE_INVALID');
    expect(put).not.toHaveBeenCalled();
    expect((await readdir(directory, { recursive: true })).filter(file => file.endsWith('.json'))).toEqual([]);
  });

  it('bounds artifact reads and closes the stream before retrying through the provider', async () => {
    let iteratorClosed = false;
    const large = Readable.from((async function* () {
      try { const chunk = Buffer.alloc(1024 * 1024, 32); for (let i = 0; i < 40; i += 1) yield chunk; }
      finally { iteratorClosed = true; }
    })());
    const bounded: StoragePort = {
      read: async () => large,
      put: (key, input, type, maxBytes) => storage.put(key, input, type, maxBytes),
      stat: (key, type) => storage.stat(key, type),
      remove: key => storage.remove(key),
    };
    const adapter = provider();
    expect(await cachedEmbedding(adapter, bounded, scope).embed(texts)).toEqual(vectors);
    expect(adapter.embed).toHaveBeenCalledOnce();
    expect(iteratorClosed).toBe(true); expect(large.destroyed).toBe(true);
  });
});
