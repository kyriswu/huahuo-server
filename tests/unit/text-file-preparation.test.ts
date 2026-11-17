import type pg from 'pg';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { env } from '../helpers.js';
import { sourceFromUrl, sourceMetadataFromUrl, validateSourceUri } from '../../src/modules/rag/document-preparation.js';
import { RagIngestionRepository } from '../../src/modules/rag/repository.js';
import { ProcessingNodes } from '../../src/modules/processing-nodes/service.js';
import { TextIngestionService } from '../../src/modules/text-ingestion/service.js';

const configuration = () => {
  const config = loadConfig('worker', { ...env, RAG_PROVIDER_MODE: 'disabled', RAG_SOURCE_ALLOWED_HOSTS: 'files.example' });
  config.rag.enabled = true;
  return config;
};
const scope = { userId: 'user', sessionId: 'session', traceId: 'trace' };
const files = [
  ['source.txt', 'text/plain'], ['source.md', 'text/markdown'], ['source.csv', 'text/csv'],
  ['source.pdf', 'application/pdf'], ['source.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
] as const;

describe('external file URL metadata', () => {
  it.each(files)('passes %s metadata without fetching or parsing source bytes', (fileName, mimeType) => {
    const fetchImpl = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('SOURCE_FETCH_FORBIDDEN'));
    try {
      const url = `https://files.example/${fileName}?signature=opaque`;
      expect(sourceFromUrl(url, configuration())).toEqual({ url, fileName, mimeType });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { fetchImpl.mockRestore(); }
  });

  it('decodes the filename and leaves unknown format detection to the external parser', () => {
    expect(sourceFromUrl('https://files.example/%E8%B5%84%E6%96%99.MD', configuration())).toMatchObject({ fileName: '资料.MD', mimeType: 'text/markdown' });
    expect(sourceFromUrl('https://files.example/opaque-object?signature=fixture', configuration())).toMatchObject({ fileName: 'opaque-object', mimeType: 'application/octet-stream' });
  });

  it.each(['bad%escape.txt', 'folder%2Ffile.md', 'bad%00name.txt'])('rejects invalid decoded filename %s', name => {
    expect(() => sourceFromUrl(`https://files.example/${name}`, configuration())).toThrow('RAG_FILE_NAME_INVALID');
  });

  it('understands signed TTL dates and rejects expired or malformed sources before dispatch', () => {
    const config = configuration();
    const date = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
    expect(validateSourceUri(`https://files.example/a?X-Amz-Date=${date}&X-Amz-Expires=1800`, config).hostname).toBe('files.example');
    expect(() => validateSourceUri('https://files.example/a?X-Tos-Date=20000101T000000Z&X-Tos-Expires=1800', config)).toThrow('RAG_SOURCE_URL_EXPIRED');
    expect(() => validateSourceUri('https://files.example/a?Expires=1', config)).toThrow('RAG_SOURCE_URL_EXPIRED');
    expect(() => validateSourceUri('https://person:password@files.example/a', config)).toThrow('RAG_SOURCE_URL_INVALID');
    expect(() => validateSourceUri('file:///private.txt', config)).toThrow('RAG_SOURCE_URL_INVALID');
    expect(() => validateSourceUri('https://files.example.attacker.test/source.txt', config)).toThrow('RAG_SOURCE_HOST_NOT_ALLOWED');
  });

  it('accepts valid OSS V4 URLs and rejects expired or incomplete signatures', () => {
    const config = configuration(), date = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
    const query = `x-oss-signature-version=OSS4-HMAC-SHA256&x-oss-date=${date}&x-oss-expires=1800`;
    expect(validateSourceUri(`https://files.example/a?${query}`, config).hostname).toBe('files.example');
    for (const parameters of [
      'x-oss-date=20000101T000000Z&x-oss-expires=1800',
      `x-oss-date=${date}&x-oss-expires=0`, `x-oss-date=${date}&x-oss-expires=invalid`,
      `x-oss-date=${date}`, 'x-oss-expires=1800', 'x-oss-signature-version=OSS4-HMAC-SHA256',
    ]) expect(() => validateSourceUri(`https://files.example/a?${parameters}`, config)).toThrow('RAG_SOURCE_URL_EXPIRED');
  });

  it('reads accepted source metadata independently of dispatch policy for remote-job recovery', () => {
    const url = 'https://previous-host.example/source.md?Expires=1';
    expect(sourceMetadataFromUrl(url)).toEqual({ url, fileName: 'source.md', mimeType: 'text/markdown' });
    expect(() => sourceFromUrl(url, configuration())).toThrow('RAG_SOURCE_HOST_NOT_ALLOWED');
  });
});

describe('external parser admission', () => {
  it('reports an unavailable node before invoking a parser when the registered catalog is empty', async () => {
    const query = vi.fn(async () => ({ rowCount: 0, rows: [] }));
    const tx = Object.assign(new EventEmitter(), { query, release: vi.fn() });
    const pool = { connect: vi.fn(async () => tx) } as unknown as pg.Pool;
    const factory = vi.fn(), execute = vi.fn();
    const nodes = new ProcessingNodes(pool, configuration(), factory);
    await expect(nodes.withNode('document', { requestId: 'file-request', fingerprint: 'a'.repeat(64) }, execute))
      .rejects.toMatchObject({ statusCode: 503, code: 'PROCESSING_NODE_UNAVAILABLE' });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(factory).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    await nodes.close();
  });

  it('admits manual input without an external parser or model credentials', async () => {
    const boundary = new Error('DB_BOUNDARY'), connect = vi.fn(async () => { throw boundary; });
    const service = new TextIngestionService({ connect } as unknown as pg.Pool, configuration());
    await expect(service.create(scope, { source_type: 'MANUAL_INPUT', raw_content: '手动原文' }, 'manual-key')).rejects.toBe(boundary);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it.each(files)('admits externally parsed %s without a local format parser or model credentials', async (fileName, mimeType) => {
    const boundary = new Error('DB_BOUNDARY'), connect = vi.fn(async () => { throw boundary; });
    const pool = { connect } as unknown as pg.Pool, config = configuration();
    await expect(new RagIngestionRepository(pool, config).create(scope, { fileName, mimeType, ossUrl: `https://files.example/${fileName}` })).rejects.toBe(boundary);
    await expect(new TextIngestionService(pool, config).create(scope, { source_type: 'FILE_UPLOAD', origin_resource_uri: `https://files.example/${fileName}` }, 'file-key')).rejects.toBe(boundary);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('applies the same signed-URL policy to both file entrypoints', async () => {
    const config = configuration(), boundary = new Error('DB_BOUNDARY');
    const connect = vi.fn(async () => { throw boundary; }), pool = { connect } as unknown as pg.Pool;
    const repository = new RagIngestionRepository(pool, config), service = new TextIngestionService(pool, config);
    const expired = 'https://files.example/a?X-Amz-Date=20000101T000000Z&X-Amz-Expires=1800';
    await expect(repository.create(scope, { fileName: 'source.txt', mimeType: 'text/plain', ossUrl: expired })).rejects.toMatchObject({ statusCode: 400, code: 'RAG_SOURCE_URL_EXPIRED' });
    await expect(service.create(scope, { source_type: 'FILE_UPLOAD', origin_resource_uri: expired }, 'file-key')).rejects.toMatchObject({ statusCode: 400, code: 'RAG_SOURCE_URL_EXPIRED' });
    expect(connect).not.toHaveBeenCalled();
  });
});
