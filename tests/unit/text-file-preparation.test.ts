import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { env } from '../helpers.js';
import type { StoragePort, StoredObject } from '../../src/modules/storage/port.js';
import type { ParsedDocument } from '../../src/modules/rag/types.js';
import { downloadSourceBytes, prepareFileText, validateSourceUri } from '../../src/modules/rag/document-preparation.js';
import { RagIngestionRepository } from '../../src/modules/rag/repository.js';

const configuration = () => loadConfig('worker', { ...env, ALLOW_MOCK_PROVIDERS: 'true', RAG_PROVIDER_MODE: 'mock', RAG_SOURCE_ALLOWED_HOSTS: 'files.example' });
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function memoryStorage() {
  const objects = new Map<string, Uint8Array>();
  let uploads = 0;
  const metadata = (key: string, mime: string): StoredObject => {
    const bytes = objects.get(key);
    if (!bytes) throw new Error('MISSING');
    return { bytes: bytes.length, sha256: hash(bytes), contentType: mime, durationSeconds: 0, version: key };
  };
  const storage: StoragePort = {
    async put(key, stream, mime, maxBytes) {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) { const bytes = Buffer.from(chunk); total += bytes.length; if (total > maxBytes) throw new Error('LIMIT'); chunks.push(bytes); }
      objects.set(key, Buffer.concat(chunks)); uploads += 1;
      return metadata(key, mime);
    },
    async stat(key, mime) { return metadata(key, mime); },
    async read(key) { const bytes = objects.get(key); if (!bytes) throw new Error('MISSING'); return Readable.from([bytes]); },
    async remove(key) { objects.delete(key); },
    async removeMany(keys) { for (const key of keys) objects.delete(key); },
  };
  return { storage, objects, get uploads() { return uploads; } };
}
const fetched = (content: string, mime: string) => vi.fn<typeof fetch>(async () => new Response(content, { headers: { 'content-type': mime } }));

describe('shared file text preparation', () => {
  it('retains exact Markdown text without calling a document service or storing fake assets', async () => {
    const raw = '  # 标题\r\n\r\n原文😀  \r\n';
    const memory = memoryStorage(), parse = vi.fn();
    const result = await prepareFileText(configuration(), memory.storage, { id: 'fixture', uri: 'https://files.example/source.md' }, { fetchImpl: fetched(raw, 'text/markdown'), parser: { parse } });
    expect(result).toEqual({ content: raw, format: 'markdown' });
    expect(parse).not.toHaveBeenCalled();
    expect(memory.uploads).toBe(0);
  });

  it('keeps image binding, orphan assets and all OCR in one manifest and uploads duplicate bytes once', async () => {
    const memory = memoryStorage();
    const png = new Uint8Array([1, 2, 3]);
    const markdown = '# 图片\n\n![poster](images/poster.png)';
    const parsed: ParsedDocument = {
      source: { fileName: 'source.pdf', mimeType: 'application/pdf', sha256: 'test' },
      blocks: [], markdown, rawMarkdown: markdown, parserProvider: 'fixture', parserVersion: 'fixture',
      artifacts: {
        assets: ['poster', 'orphan'].map(name => ({ path: `images/${name}.png`, bytes: png, mimeType: 'image/png', assetType: 'image', sha256: hash(png) })),
        contentListV2: [{ type: 'image', image_source: { path: 'images/poster.png' }, caption: '原图说明' }],
        model: [{ image_path: 'images/poster.png', ocr_text: '图中关键词' }, { page_index: 1, ocr_text: '未绑定OCR😀' }],
      },
    };
    const parser = { parse: vi.fn(async () => parsed) };
    const input = { id: 'fixture', uri: 'https://files.example/source.pdf' };
    const result = await prepareFileText(configuration(), memory.storage, input, { fetchImpl: fetched('%PDF-1.7\n%%EOF', 'application/pdf'), parser });
    expect(result.content).toContain('asset://images/poster.png');
    expect(result.content).toContain('图中关键词');
    expect(result.content).toContain('未绑定OCR😀');
    expect(result.format).toBe('markdown');
    const manifest = JSON.parse(Buffer.from(memory.objects.get(result.artifactUri!)!).toString('utf8')) as { assets: Array<{ sourceAssetKey: string; objectKey: string }>; diagnostics: { orphanAssets: string[]; unresolvedOcr: Array<{ text: string }> }; rawMarkdownUri: string };
    expect(manifest.assets.map(asset => asset.sourceAssetKey)).toEqual(['images/poster.png', 'images/orphan.png']);
    expect(new Set(manifest.assets.map(asset => asset.objectKey)).size).toBe(1);
    expect(manifest.diagnostics.orphanAssets).toEqual(['images/orphan.png']);
    expect(manifest.diagnostics.unresolvedOcr).toEqual([{ text: '未绑定OCR😀', pageNo: 2 }]);
    expect(Buffer.from(memory.objects.get(manifest.rawMarkdownUri)!).toString('utf8')).toBe(markdown);
    expect(memory.uploads).toBe(3); // one shared image, original Markdown and manifest
    const replay = await prepareFileText(configuration(), memory.storage, input, { fetchImpl: fetched('%PDF-1.7\n%%EOF', 'application/pdf'), parser });
    expect(replay).toEqual(result);
    expect(memory.uploads).toBe(3);
  });

  it('rejects a declaration that conflicts with sniffed file bytes', async () => {
    const parser = { parse: vi.fn() };
    await expect(prepareFileText(configuration(), memoryStorage().storage, { id: 'fixture', uri: 'https://files.example/source.txt' }, { fetchImpl: fetched('%PDF-1.7\n%%EOF', 'text/plain'), parser })).rejects.toMatchObject({ code: 'RAG_FILE_TYPE_MISMATCH' });
    expect(parser.parse).not.toHaveBeenCalled();
    await expect(prepareFileText(configuration(), memoryStorage().storage, { id: 'fixture', uri: 'https://files.example/source.pdf' }, { fetchImpl: fetched('not a PDF', 'application/pdf'), parser })).rejects.toMatchObject({ code: 'RAG_FILE_TYPE_MISMATCH' });
  });

  it('does not treat an arbitrary binary payload as text', async () => {
    await expect(prepareFileText(configuration(), memoryStorage().storage, { id: 'fixture', uri: 'https://files.example/source.txt' }, { fetchImpl: fetched('\0binary', 'text/plain') })).rejects.toMatchObject({ code: 'RAG_FILE_TYPE_MISMATCH' });
  });

  it('uses a verified Office container and MIME when a signed object path has no extension', async () => {
    const bytes = new Uint8Array(64); bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const parse = vi.fn(async (input: { mimeType: string }): Promise<ParsedDocument> => ({
      source: { fileName: 'object', mimeType: input.mimeType, sha256: hash(bytes) },
      blocks: [], markdown: 'Office 文本', rawMarkdown: 'Office 文本', artifacts: {}, parserProvider: 'fixture', parserVersion: 'fixture',
    }));
    const result = await prepareFileText(configuration(), memoryStorage().storage, { id: 'office', uri: 'https://files.example/object' }, {
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(bytes.buffer, { headers: { 'content-type': 'application/msword' } })), parser: { parse },
    });
    expect(parse).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'application/msword' }));
    expect(result.content).toBe('Office 文本');
  });

  it('enforces the full plaintext limit without truncating', async () => {
    const config = configuration(); config.rag.plainTextMaxChars = 5;
    await expect(prepareFileText(config, memoryStorage().storage, { id: 'fixture', uri: 'https://files.example/source.txt' }, { fetchImpl: fetched('123456', 'text/plain') })).rejects.toMatchObject({ code: 'RAG_PLAIN_TEXT_TOO_LARGE' });
  });

  it('rejects Mock mode in production before any download or service call', async () => {
    const config = configuration(); config.appEnv = 'production';
    const fetchImpl = fetched('ignored', 'text/plain');
    await expect(prepareFileText(config, memoryStorage().storage, { id: 'fixture', uri: 'https://files.example/source.txt' }, { fetchImpl })).rejects.toMatchObject({ code: 'TEXT_SOURCE_ADAPTER_UNAVAILABLE' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('bounded source downloading', () => {
  it('checks redirected hosts before issuing the second request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    await expect(downloadSourceBytes('https://files.example/source.txt', configuration(), fetchImpl)).rejects.toMatchObject({ code: 'RAG_SOURCE_HOST_NOT_ALLOWED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops a chunked body once the bound is crossed and cancels its stream', async () => {
    const config = configuration(); config.rag.maxSourceBytes = 3;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])); }, cancel });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(stream));
    await expect(downloadSourceBytes('https://files.example/source.txt', config, fetchImpl)).rejects.toMatchObject({ code: 'RAG_SOURCE_TOO_LARGE' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps the timeout active while receiving the body', async () => {
    const config = configuration(); config.rag.downloadTimeoutMs = 10;
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ cancel })));
    await expect(downloadSourceBytes('https://files.example/source.txt', config, fetchImpl)).rejects.toMatchObject({ code: 'RAG_SOURCE_TIMEOUT', retryable: true });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('understands signed TTL dates and rejects expired or malformed sources before fetch', async () => {
    const config = configuration();
    const date = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
    expect(validateSourceUri(`https://files.example/a?X-Amz-Date=${date}&X-Amz-Expires=1800`, config).hostname).toBe('files.example');
    expect(() => validateSourceUri('https://files.example/a?X-Tos-Date=20000101T000000Z&X-Tos-Expires=1800', config)).toThrow('RAG_SOURCE_URL_EXPIRED');
    expect(() => validateSourceUri('https://files.example/a?Expires=1', config)).toThrow('RAG_SOURCE_URL_EXPIRED');
    expect(() => validateSourceUri('https://person:password@files.example/a', config)).toThrow('RAG_SOURCE_URL_INVALID');
    expect(() => validateSourceUri('file:///private.txt', config)).toThrow('RAG_SOURCE_URL_INVALID');
  });

  it('uses the same signed-URL policy at the existing file ingestion entrypoint', async () => {
    const config = configuration(); config.rag.enabled = true;
    const boundary = new Error('DB_BOUNDARY');
    const connect = vi.fn(async () => { throw boundary; });
    const pool = { connect } as unknown as pg.Pool;
    const repository = new RagIngestionRepository(pool, config.rag, config.appEnv, config.milvus.collection, config);
    const scope = { userId: 'user', sessionId: 'session', traceId: 'trace' };
    const input = { fileName: 'source.pdf', mimeType: 'application/pdf' };
    await expect(repository.create(scope, { ...input, ossUrl: 'not-a-url' })).rejects.toMatchObject({ statusCode: 400, code: 'RAG_SOURCE_URL_INVALID' });
    await expect(repository.create(scope, { ...input, ossUrl: 'https://files.example/a?X-Amz-Date=20000101T000000Z&X-Amz-Expires=1800' })).rejects.toMatchObject({ statusCode: 400, code: 'RAG_SOURCE_URL_EXPIRED' });
    expect(connect).not.toHaveBeenCalled();
    const date = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
    await expect(repository.create(scope, { ...input, ossUrl: `https://files.example/a?X-Amz-Date=${date}&X-Amz-Expires=1800` })).rejects.toBe(boundary);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
