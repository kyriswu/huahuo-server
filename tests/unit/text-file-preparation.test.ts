import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { env } from '../helpers.js';
import { downloadSourceBytes, prepareFileText, validateSourceUri } from '../../src/modules/rag/document-preparation.js';
import { RagIngestionRepository } from '../../src/modules/rag/repository.js';

const configuration = () => loadConfig('worker', { ...env, ALLOW_MOCK_PROVIDERS: 'true', RAG_PROVIDER_MODE: 'mock', RAG_SOURCE_ALLOWED_HOSTS: 'files.example' });
const fetched = (content: string, mime: string) => vi.fn<typeof fetch>(async () => new Response(content, { headers: { 'content-type': mime } }));

describe('native file text preparation', () => {
  it('retains exact Markdown text and only downloads the original source', async () => {
    const raw = '  # 标题\r\n\r\n原文😀  \r\n';
    const fetchImpl = fetched(raw, 'text/markdown');
    const result = await prepareFileText(configuration(), { id: 'fixture', uri: 'https://files.example/source.md' }, { fetchImpl });
    expect(result).toEqual({ content: raw, format: 'markdown' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://files.example/source.md');
  });

  it.each([['source.txt', 'text/plain'], ['source.csv', 'text/csv']])('keeps UTF-8 %s input unchanged', async (fileName, mime) => {
    const raw = '中文,emoji😀\r\n原文';
    await expect(prepareFileText(configuration(), { id: 'fixture', uri: `https://files.example/${fileName}` }, { fetchImpl: fetched(raw, mime) })).resolves.toEqual({ content: raw, format: 'text' });
  });

  it('rejects a PDF without submitting an external parse request', async () => {
    const fetchImpl = fetched('%PDF-1.7\n%%EOF', 'application/pdf');
    await expect(prepareFileText(configuration(), { id: 'fixture', uri: 'https://files.example/source.pdf' }, { fetchImpl })).rejects.toMatchObject({ code: 'RAG_FILE_TYPE_UNSUPPORTED', retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects file declarations that conflict with the actual bytes', async () => {
    await expect(prepareFileText(configuration(), { id: 'fixture', uri: 'https://files.example/source.txt' }, { fetchImpl: fetched('%PDF-1.7\n%%EOF', 'text/plain') })).rejects.toMatchObject({ code: 'RAG_FILE_TYPE_MISMATCH' });
    await expect(prepareFileText(configuration(), { id: 'fixture', uri: 'https://files.example/source.pdf' }, { fetchImpl: fetched('not a PDF', 'application/pdf') })).rejects.toMatchObject({ code: 'RAG_FILE_TYPE_MISMATCH' });
  });

  it('rejects binary or invalid UTF-8 text without inventing body content', async () => {
    await expect(prepareFileText(configuration(), { id: 'fixture', uri: 'https://files.example/source.txt' }, { fetchImpl: fetched('\0binary', 'text/plain') })).rejects.toMatchObject({ code: 'RAG_FILE_TYPE_MISMATCH' });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([255]).buffer, { headers: { 'content-type': 'text/plain' } }));
    await expect(prepareFileText(configuration(), { id: 'fixture', uri: 'https://files.example/source.txt' }, { fetchImpl })).rejects.toMatchObject({ code: 'RAG_SOURCE_INVALID_TEXT' });
  });

  it('rejects Office input even when its signed object path has no extension', async () => {
    const bytes = new Uint8Array(64); bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(bytes.buffer, { headers: { 'content-type': 'application/msword' } }));
    await expect(prepareFileText(configuration(), { id: 'office', uri: 'https://files.example/object' }, { fetchImpl })).rejects.toMatchObject({ code: 'RAG_FILE_TYPE_UNSUPPORTED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('enforces the full plaintext limit without truncating', async () => {
    const config = configuration(); config.rag.plainTextMaxChars = 5;
    await expect(prepareFileText(config, { id: 'fixture', uri: 'https://files.example/source.txt' }, { fetchImpl: fetched('123456', 'text/plain') })).rejects.toMatchObject({ code: 'RAG_PLAIN_TEXT_TOO_LARGE' });
  });

  it('prepares native text with all model providers disabled and no model credentials', async () => {
    const config = loadConfig('worker', { ...env, RAG_PROVIDER_MODE: 'disabled', RAG_SOURCE_ALLOWED_HOSTS: 'files.example' });
    const fetchImpl = fetched('纯文本原文', 'text/plain');
    await expect(prepareFileText(config, { id: 'fixture', uri: 'https://files.example/source.txt' }, { fetchImpl })).resolves.toEqual({ content: '纯文本原文', format: 'text' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([['source.pdf', 'application/pdf'], ['source.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['source.ppt', 'application/vnd.ms-powerpoint'], ['source.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']])('rejects %s at admission before opening a database transaction', async (fileName, mimeType) => {
    const config = configuration(); config.rag.enabled = true;
    const connect = vi.fn();
    const repository = new RagIngestionRepository({ connect } as unknown as pg.Pool, config.rag, config.appEnv, config.kb.documentCollection, config);
    await expect(repository.create({ userId: 'user', sessionId: 'session', traceId: 'trace' }, { fileName, mimeType, ossUrl: `https://files.example/${fileName}` })).rejects.toMatchObject({ statusCode: 400, code: 'RAG_FILE_TYPE_UNSUPPORTED' });
    expect(connect).not.toHaveBeenCalled();
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
    const repository = new RagIngestionRepository(pool, config.rag, config.appEnv, config.kb.documentCollection, config);
    const scope = { userId: 'user', sessionId: 'session', traceId: 'trace' };
    const input = { fileName: 'source.txt', mimeType: 'text/plain' };
    await expect(repository.create(scope, { ...input, ossUrl: 'not-a-url' })).rejects.toMatchObject({ statusCode: 400, code: 'RAG_SOURCE_URL_INVALID' });
    await expect(repository.create(scope, { ...input, ossUrl: 'https://files.example/a?X-Amz-Date=20000101T000000Z&X-Amz-Expires=1800' })).rejects.toMatchObject({ statusCode: 400, code: 'RAG_SOURCE_URL_EXPIRED' });
    expect(connect).not.toHaveBeenCalled();
    const date = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
    await expect(repository.create(scope, { ...input, ossUrl: `https://files.example/a?X-Amz-Date=${date}&X-Amz-Expires=1800` })).rejects.toBe(boundary);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
