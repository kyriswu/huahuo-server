import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config/config.js';
import { createMilvusClient, createMilvusKeywordIndex, createMilvusVectorIndex, createMilvusHybridIndex } from '../../src/integrations/search-index/milvus.js';
import type { KeywordIndex, VectorIndex, HybridIndex, VectorPoint, SearchOptions } from '../../src/lib/search-index/types.js';
import { configureTestMilvus } from '../support/milvus.js';

// Standalone adapter tests run only against the runner's local ephemeral Milvus.
// They never add collections to a configured shared/cloud Milvus database.
const enabled = process.env.TEST_MILVUS_MODE === 'local' && Boolean(process.env.TEST_MILVUS_ADDRESS);
describe.skipIf(!enabled)('portable search adapters on real ephemeral Milvus', () => {
  const prefix = 'huahuo_test_ports_' + randomUUID().replaceAll('-', '');
  const names = { keyword: prefix + '_keyword', vector: prefix + '_vector', hybrid: prefix + '_hybrid' };
  let client:ReturnType<typeof createMilvusClient>,keyword:KeywordIndex,vector:VectorIndex,native:HybridIndex;
  beforeAll(async () => {
    const database = process.env.TEST_DATABASE_MIGRATION_URL!;
    if (!database || !/^huahuo_test_/.test(new URL(database).pathname.slice(1))) throw new Error('ISOLATED_DATABASE_REQUIRED');
    const config = loadConfig('migrate', { DATABASE_URL: database });
    configureTestMilvus(config);
    if (!config.milvus.address?.startsWith('127.0.0.1:')) throw new Error('EPHEMERAL_LOCAL_MILVUS_REQUIRED');
    client = createMilvusClient(config.milvus);
    const common = { ...config.milvus, dimensions: 4, maxContentChars: 2000, createIfMissing: true };
    keyword = createMilvusKeywordIndex({ ...common, collection: names.keyword });
    vector = createMilvusVectorIndex({ ...common, collection: names.vector });
    native = createMilvusHybridIndex({ ...common, collection: names.hybrid });
    await Promise.all([keyword.ensureReady(), vector.ensureReady(), native.ensureReady()]);
  }, 60_000);
  afterAll(async () => {
    try {
      await Promise.all([keyword?.close(), vector?.close(), native?.close()]);
      if(!client)return;
      for (const name of Object.values(names)) {
        if (!name.startsWith(prefix + '_')) throw new Error('TEST_COLLECTION_OWNERSHIP_REQUIRED');
        const exists = await client.hasCollection({ collection_name: name });
        if (exists.value) {
          const dropped = await client.dropCollection({ collection_name: name });
          expect(String(dropped.error_code)).toBe('Success');
        }
      }
    } finally { await client?.closeConnection(); }
  }, 30_000);
  const scopeFor = (ids: readonly string[]): SearchOptions => ({ scope: { userId: 'user', workspaceId: 'workspace', pointIds: ids }, limit: 10 });
  const point = (id: string): VectorPoint => ({ id, userId: 'user', workspaceId: 'workspace', sourceId: 'source', sourceType: 'future-business', content: 'spectroscope needle ' + id, embedding: [1, 0, 0, 0] });

  it('creates keyword-only, vector-only and native hybrid storage independently of business names', async () => {
    const fields = async (name: string) => (await client.describeCollection({ collection_name: name })).schema.fields.map(f => f.name);
    expect(await fields(names.keyword)).toContain('sparse_vector'); expect(await fields(names.keyword)).not.toContain('dense_vector');
    expect(await fields(names.vector)).toContain('dense_vector'); expect(await fields(names.vector)).not.toContain('sparse_vector');
    expect(await fields(names.hybrid)).toEqual(expect.arrayContaining(['sparse_vector', 'dense_vector']));
  });

  it('preserves keyword visibility, stable IDs, scope/filter isolation and idempotent deletion', async () => {
    const a = point('keyword-a'), foreign = { ...point('keyword-b'), userId: 'other-user' };
    const texts = [a, foreign].map(p => ({ id: p.id, userId: p.userId, workspaceId: p.workspaceId, sourceId: p.sourceId, sourceType: p.sourceType, content: p.content }));
    await keyword.upsert(texts); await keyword.upsert(texts);
    const options = { ...scopeFor(texts.map(p => p.id)), filter: { sourceTypes: ['future-business'], sourceIds: ['source'] } };
    expect((await keyword.searchKeyword('spectroscope', options)).map(h => h.chunkKey)).toEqual(['keyword-a']);
    expect(await keyword.searchKeyword('spectroscope', { ...options, filter: { sourceTypes: ['different-business'] } })).toEqual([]);
    await keyword.deletePoints(['keyword-a']); await keyword.deletePoints(['keyword-a']);
    expect(await keyword.searchKeyword('spectroscope', options)).toEqual([]);
  });

  it('supports native hybrid with tenant isolation', async () => {
    const points = [point('hybrid-a'), { ...point('hybrid-b'), userId: 'other-user' }];
    await native.upsert(points);
    const options = scopeFor(points.map(p => p.id));
    expect((await native.hybridSearch([1, 0, 0, 0], 'spectroscope', options)).map(h => h.chunkKey)).toEqual(['hybrid-a']);

  });
});
