import { afterEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  denseType: 'Float16Vector', dimension: '1024', indexed: true,
  close: vi.fn(async () => undefined),
}));
vi.mock('../../dist/config/config.js', () => ({
  loadConfig: (role: string) => {
    // Match the real loader's role invariant: the external gate runs as API.
    if (role !== process.env.SERVICE_ROLE) throw new Error('INVALID_CONFIG:SERVICE_ROLE');
    return { milvus: {}, kb: { contentAssetCollection: 'content_assets', documentCollection: 'documents' } };
  },
}));
vi.mock('../../dist/integrations/search-index/milvus.js', () => ({
  createMilvusClient: () => ({
    connectPromise: Promise.resolve(), closeConnection: fixtures.close,
    describeCollection: async ({ collection_name }: { collection_name: string }) => ({
      status: { error_code: 'Success' }, schema: { fields: collection_name === 'content_assets'
        ? [{ name: 'dense_vector', data_type: fixtures.denseType, type_params: [{ key: 'dim', value: fixtures.dimension }] }] : [] },
    }),
    describeIndex: async () => ({ status: { error_code: 'Success' }, index_descriptions:
      fixtures.indexed ? [
        { field_name: 'dense_vector', index_name: 'huahuo_dense_hnsw', state: 'Finished' },
        { field_name: 'sparse_vector', index_name: 'huahuo_sparse_bm25', state: 'Finished' },
      ] : [] }),
  }),
}));

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode; vi.unstubAllEnvs(); vi.restoreAllMocks();
  fixtures.denseType = 'Float16Vector'; fixtures.dimension = '1024'; fixtures.indexed = true;
});

describe('release external gate in its actual API role, simulated Milvus', () => {
  it.each(['ready', 'wrong-type', 'wrong-dimension', 'missing-index'] as const)('%s', async state => {
    vi.resetModules(); vi.stubEnv('SERVICE_ROLE', 'api-server'); fixtures.close.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    if (state === 'wrong-type') fixtures.denseType = 'FloatVector';
    if (state === 'wrong-dimension') fixtures.dimension = '2048';
    if (state === 'missing-index') fixtures.indexed = false;
    // @ts-expect-error reviewed portable JavaScript release check
    await import('../../scripts/release/changes/20261116-gateway-qwen37/verify-external.mjs');
    expect(fixtures.close).toHaveBeenCalledOnce();
    if (state === 'ready') { expect(process.exitCode).toBe(originalExitCode); expect(error).not.toHaveBeenCalled(); }
    else { expect(process.exitCode).toBe(1); expect(error).toHaveBeenCalledWith('QWEN_MILVUS_VERIFICATION_FAILED\n'); }
  });
});
