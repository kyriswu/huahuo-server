import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MilvusConfig } from '../../src/config/config.js';
import type { VectorRecord } from '../../src/lib/rag-indexing/index.js';
import { createBusinessVectorStore, vectorConnectionId } from '../../src/modules/rag/vector-store.js';
import { config as baseConfig } from '../helpers.js';

const calls = vi.hoisted(() => ({
  constructor: vi.fn<(config: MilvusConfig) => void>(),
  upsert: vi.fn<(collection: string, rows: unknown) => Promise<void>>().mockResolvedValue(undefined),
  delete: vi.fn<(collection: string, selector: unknown) => Promise<void>>().mockResolvedValue(undefined),
  close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock('../../src/modules/rag/adapters/milvus.js', () => ({
  MilvusRepository: class {
    constructor(private readonly config: MilvusConfig) { calls.constructor(config); }
    async upsert(rows: unknown) { await calls.upsert(this.config.collection, rows); }
    async deleteVectors(selector: unknown) { await calls.delete(this.config.collection, selector); }
    async close() { await calls.close(); }
  },
}));

function settings() {
  const value = baseConfig(); value.rag.providerMode = 'live';
  Object.assign(value.milvus, { address: 'test.invalid:19530', database: 'default', collection: 'not-a-business-default' });
  return value;
}
function row(source: string): VectorRecord {
  return { id: `${source}-shared-id-r1-c0`, embeddingText: 'prepared model input', embedding: [1, 0, 0, 0], metadata: { parent_id: 'shared-id', source_type: source, content: 'body from its own repository', user_id: 'test-user', workspace_id: 'test-workspace', embedding_profile: 'test-profile', ...(source === 'note' ? {} : { source_revision: 'r1', ordinal: 0, index_build_id: `${source}-build` }) } };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('immutable business vector target binding', () => {
  it('rejects missing targets, unknown connections and unsupported partitions', () => {
    const config = settings(); const target = { connectionId: vectorConnectionId(config), database: 'one-business-db', collection: 'one-business-collection' };
    for (const invalid of [{ ...target, connectionId: 'unknown' }, { ...target, database: '' }, { ...target, collection: '' }, { ...target, partition: 'unregistered' }]) {
      expect(() => createBusinessVectorStore(config, invalid)).toThrow('VECTOR_TARGET_UNAVAILABLE');
    }
    expect(calls.constructor).not.toHaveBeenCalled();
  });

  it('fingerprints the actual connection address and transport separately from database/collection', () => {
    const first = settings(); const second = settings();
    expect(vectorConnectionId(first)).toBe(vectorConnectionId(second));
    second.milvus.database = 'different-db'; second.milvus.collection = 'different-collection';
    expect(vectorConnectionId(first)).toBe(vectorConnectionId(second));
    second.milvus.address = 'other.invalid:19530'; expect(vectorConnectionId(first)).not.toBe(vectorConnectionId(second));
    second.milvus.address = first.milvus.address; second.milvus.tls = !first.milvus.tls; expect(vectorConnectionId(first)).not.toBe(vectorConnectionId(second));
  });

  it('keeps concurrent businesses with the same whole-source ID in their own immutable targets', async () => {
    const config = settings();
    const pdfTarget = { connectionId: vectorConnectionId(config), database: 'pdf-database', collection: 'pdf-collection' };
    const noteTarget = { connectionId: vectorConnectionId(config), database: 'note-database', collection: 'note-collection' };
    const pdf = createBusinessVectorStore(config, pdfTarget); const note = createBusinessVectorStore(config, noteTarget);
    pdfTarget.collection = 'mutated-after-binding'; noteTarget.database = 'mutated-after-binding';
    await Promise.all([pdf.upsert([row('file')]), note.upsert([row('note')])]);
    expect(Object.isFrozen(pdf.target)).toBe(true);
    expect(pdf.target).toMatchObject({ database: 'pdf-database', collection: 'pdf-collection' });
    expect(note.target).toMatchObject({ database: 'note-database', collection: 'note-collection' });
    expect(calls.constructor.mock.calls.map(([bound]) => [bound.database, bound.collection])).toEqual([['pdf-database', 'pdf-collection'], ['note-database', 'note-collection']]);
    expect(calls.upsert).toHaveBeenCalledWith('pdf-collection', [expect.objectContaining({ documentId: 'shared-id', documentVersion: 'r1', chunk: expect.objectContaining({ id: 'file-shared-id-r1-c0', parentId: 'shared-id', sourceType: 'file', sourceRevision: 'r1' }) })]);
    expect(calls.upsert).toHaveBeenCalledWith('note-collection', [expect.objectContaining({ documentId: 'shared-id', documentVersion: '', indexBuildId: '', chunk: expect.objectContaining({ id: 'note-shared-id-r1-c0', parentId: 'shared-id', sourceType: 'note', sourceRevision: '' }) })]);
    const selector = { ids: ['note-shared-id-r1-c0'] };
    await note.delete(selector); expect(calls.delete).toHaveBeenCalledExactlyOnceWith('note-collection', selector);
    await pdf.close(); await note.close(); expect(calls.close).toHaveBeenCalledTimes(2);
  });

  it.each(['parent_id', 'source_type', 'source_revision'])('rejects missing whole-source metadata %s', async field => {
    const config = settings(); const store = createBusinessVectorStore(config, { connectionId: vectorConnectionId(config), database: 'db', collection: 'chunks' });
    const input = row('file'); const metadata = { ...input.metadata }; delete metadata[field];
    await expect(store.upsert([{ ...input, metadata }])).rejects.toThrow(`VECTOR_METADATA_REQUIRED:${field}`);
    expect(calls.upsert).not.toHaveBeenCalled();
  });

  it('honors caller cancellation before vector writes and never constructs live clients in explicit Mock mode', async () => {
    const config = settings(); config.rag.providerMode = 'mock';
    const store = createBusinessVectorStore(config, { connectionId: vectorConnectionId(config), database: 'mock-db', collection: 'mock-collection' });
    expect(calls.constructor).not.toHaveBeenCalled();
    const abort = new AbortController(); abort.abort();
    await expect(store.upsert([row('note')], { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(store.upsert([row('note')])).resolves.toBeUndefined();
    expect(calls.upsert).not.toHaveBeenCalled();
  });
});
