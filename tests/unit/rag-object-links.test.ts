import type pg from 'pg';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/config/config.js';
import { RagIngestionRepository } from '../../src/modules/rag/repository.js';
import { AliyunOssStorageAdapter } from '../../src/integrations/object-storage/aliyun-oss.js';
import { testOssConfig } from '../support/oss-upload.js';

const sourceId = '8c527e3b-c3fd-44af-adcf-946b878655ea', runId = '93a94ca9-d3d7-4839-ac44-b36af825638f';
const artifact = `extractions/${sourceId}/${runId}/${'a'.repeat(64)}.json.gz`;
const scope = { userId: 'owner', sessionId: 'session', traceId: 'trace' };
function fixture(options: { found?: boolean; deleted?: boolean; artifact?: string; bucket?: string; key?: string } = {}) {
  const version = { id: 'version', deleted_at: options.deleted ? new Date() : null, parse_artifact_uri: options.artifact ?? artifact,
    processing_snapshot: { parser: { sourceResourceId: sourceId, parseRunId: runId } } };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM user_sessions')) return { rowCount: 1, rows: [{ id: scope.sessionId }] };
    if (sql.includes('FROM rag_ingestion_versions')) return { rowCount: options.found === false ? 0 : 1, rows: options.found === false ? [] : [version] };
    if (sql.includes('FROM rag_document_assets')) return { rowCount: 1, rows: [{ object_key: options.key ?? 'private/images/picture.png', mime_type: 'image/png', byte_size: '512', metadata: { bucket: options.bucket ?? 'fixture-assets' } }] };
    return { rowCount: 0, rows: [] };
  });
  const pool = { query, connect: async () => Object.assign(new EventEmitter(), { query, release: vi.fn() }) } as unknown as pg.Pool;
  const config = { storageDriver: 'aliyun-oss', storageAliyunOss: { bucket: 'fixture-assets', keyPrefix: 'private' } } as AppConfig;
  const storage = { signUrl: vi.fn(async (key: string) => `https://fixture-assets.test/private/${key}`), read: vi.fn(async () => { throw new Error('DOWNLOAD_PROXY_FORBIDDEN'); }) };
  return { repository: new RagIngestionRepository(pool, config), storage };
}

describe('RAG object downloads use direct signed URLs', () => {
  it('describes the gzip JSON object and signs response headers without reading or decompressing it', async () => {
    const { repository, storage } = fixture();
    const result = await repository.extraction(scope, 'job', storage);
    expect(result).toMatchObject({ url: `https://fixture-assets.test/private/${artifact}`, mimeType: 'application/json', contentEncoding: 'gzip' });
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
    expect(storage.signUrl).toHaveBeenCalledExactlyOnceWith(artifact, 900, { contentType: 'application/json', contentEncoding: 'gzip' });
    expect(storage.read).not.toHaveBeenCalled();
  });
  it('removes the configured root once and signs the scoped image without fetching its bytes', async () => {
    const { repository, storage } = fixture();
    const result = await repository.asset(scope, 'job', 'image', storage);
    expect(result).toMatchObject({ url: 'https://fixture-assets.test/private/images/picture.png', mimeType: 'image/png', sizeBytes: 512 });
    expect(storage.signUrl).toHaveBeenCalledExactlyOnceWith('images/picture.png', 900, { contentType: 'image/png' });
    expect(storage.read).not.toHaveBeenCalled();
  });
  it.each([{ found: false }, { deleted: true }])('never signs missing, foreign or deleted versions: %j', async options => {
    const { repository, storage } = fixture(options);
    await expect(repository.extraction(scope, 'job', storage)).rejects.toMatchObject({ code: 'RAG_INGESTION_NOT_FOUND' });
    await expect(repository.asset(scope, 'job', 'image', storage)).rejects.toMatchObject({ code: 'RAG_INGESTION_NOT_FOUND' });
    expect(storage.signUrl).not.toHaveBeenCalled(); expect(storage.read).not.toHaveBeenCalled();
  });
  it('rejects artifacts outside the frozen parse run and assets outside the receipt bucket or root', async () => {
    const wrongArtifact = fixture({ artifact: `extractions/${sourceId}/other/${'a'.repeat(64)}.json.gz` });
    await expect(wrongArtifact.repository.extraction(scope, 'job', wrongArtifact.storage)).rejects.toMatchObject({ code: 'DOCUMENT_EXTRACTION_STORAGE_UNAVAILABLE' });
    expect(wrongArtifact.storage.signUrl).not.toHaveBeenCalled();
    for (const options of [{ bucket: 'foreign' }, { key: 'other/image.png' }, { key: 'private/../image.png' }]) {
      const { repository, storage } = fixture(options);
      await expect(repository.asset(scope, 'job', 'image', storage)).rejects.toMatchObject({ code: 'DOCUMENT_ASSET_STORAGE_UNAVAILABLE' });
      expect(storage.signUrl).not.toHaveBeenCalled(); expect(storage.read).not.toHaveBeenCalled();
    }
  });
});

describe('RAG uploaded source version binding', () => {
  function sourceFixture(objectVersion: string | null) {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM user_sessions')) return { rowCount: 1, rows: [{ id: scope.sessionId }] };
      if (sql.includes('FROM workspaces')) return { rowCount: 1, rows: [{ id: 'workspace' }] };
      if (sql.includes('FROM resources')) return { rowCount: 1, rows: [{ object_key: sourceId, object_version: objectVersion, sha256: null, size_bytes: '42', mime_type: 'application/pdf', storage_driver: 'aliyun-oss', storage_bucket: testOssConfig.bucket }] };
      if (sql.includes('FROM rag_ingestion_versions')) return { rowCount: 1, rows: [{ id: 'version', task_id: 'job', source_file_name: 'source.pdf', source_mime_type: 'application/pdf', status: 'RECEIVED' }] };
      return { rowCount: 0, rows: [] };
    });
    const pool = { query, connect: async () => Object.assign(new EventEmitter(), { query, release: vi.fn() }) } as unknown as pg.Pool;
    const config = { appEnv: 'test', storageDriver: 'aliyun-oss', storageAliyunOss: testOssConfig, processingNodes: { enabled: true },
      kb: { documentCollection: 'fixture' }, rag: { enabled: true, sourceAllowedHosts: [`${testOssConfig.bucket}.oss-cn-beijing.aliyuncs.com`] } } as AppConfig;
    const repository = new RagIngestionRepository(pool, config);
    return (ossUrl: string) => repository.create(scope, { ossUrl, fileName: 'source.pdf', mimeType: 'application/pdf', sourceResourceId: sourceId, parseRunId: runId });
  }
  it('accepts the unchanged locally signed URL for the resource version', async () => {
    const signer = new AliyunOssStorageAdapter(testOssConfig);
    const url = await signer.signUrl(sourceId, 900, { version: 'oss-version:fixture-version' });
    await expect(sourceFixture('oss-version:fixture-version')(url)).resolves.toMatchObject({ jobId: 'job', reused: true });
  });
  it.each([
    ['oss-version:fixture-version', ''],
    ['oss-version:fixture-version', '?versionId=other'],
    ['oss-version:fixture-version', '?versionId=fixture-version&versionId=other'],
    ['etag:fixture-etag', '?versionId=fixture-version'],
    [null, '?versionId=fixture-version'],
  ])('rejects source version mismatch: resource=%s query=%s', async (version, query) => {
    const url = `https://${testOssConfig.bucket}.oss-cn-beijing.aliyuncs.com/${testOssConfig.keyPrefix}/${sourceId}${query}`;
    await expect(sourceFixture(version)(url)).rejects.toMatchObject({ code: 'RAG_SOURCE_RESOURCE_MISMATCH' });
  });
});
