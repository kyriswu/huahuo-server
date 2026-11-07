import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { assertCreateTextIngestionInput, assertManualTextEditable, assertTextIngestionContent, assertTextIngestionOrigin, assertUpdateTextIngestionInput } from '../../src/modules/text-ingestion/policy.js';
import { CreateTextIngestionSchema, TextIngestionJobSchema, UpdateTextIngestionSchema } from '../../src/modules/text-ingestion/schemas.js';
import { TEXT_INGESTION_MAX_CHARS, TextIngestionSourceType, type TextIngestionJob } from '../../src/modules/text-ingestion/types.js';

const externalSources = Object.values(TextIngestionSourceType).filter(source => source !== TextIngestionSourceType.MANUAL_INPUT);
const origin = 'https://assets.example.test/source.pdf?signature=fixture';
const manual = (content = '正文') => ({ source_type: TextIngestionSourceType.MANUAL_INPUT, raw_content: content });

describe('text ingestion source and edit policy', () => {
  it('uses six explicit strings instead of numeric enum values', () => {
    expect(Object.values(TextIngestionSourceType)).toEqual(['MANUAL_INPUT', 'WEB_CRAWL', 'IMAGE_OCR', 'MEDIA_ASR', 'BOOK_OCR', 'FILE_UPLOAD']);
  });

  it('preserves all source whitespace and Unicode when creating and editing manual text', () => {
    const content = '  标题\r\n\r\n重复段落🙂\n重复段落🙂\n  ';
    const create = manual(content), edit = { raw_content: content };
    assertCreateTextIngestionInput(create);
    assertCreateTextIngestionInput({ ...create, origin_resource_uri: null });
    assertUpdateTextIngestionInput(edit);
    expect(create.raw_content).toBe(content);
    expect(edit.raw_content).toBe(content);
    expect(() => assertManualTextEditable(TextIngestionSourceType.MANUAL_INPUT)).not.toThrow();
  });

  it.each(externalSources)('allows %s only with an original URI and rejects frontend edits or parsed text', source => {
    expect(() => assertCreateTextIngestionInput({ source_type: source, origin_resource_uri: origin })).not.toThrow();
    expect(() => assertCreateTextIngestionInput({ source_type: source })).toThrowError('TEXT_INGESTION_ORIGIN_INVALID');
    expect(() => assertCreateTextIngestionInput({ source_type: source, origin_resource_uri: origin, raw_content: 'forged provider text' })).toThrowError('TEXT_INGESTION_INPUT_INVALID');
    expect(() => assertManualTextEditable(source)).toThrowError('TEXT_INGESTION_SOURCE_READ_ONLY');
  });

  it('enforces the character limit in Unicode code points without truncation', () => {
    const exact = '🙂'.repeat(TEXT_INGESTION_MAX_CHARS);
    expect(() => assertTextIngestionContent(exact)).not.toThrow();
    expect(() => assertTextIngestionContent(exact + '文')).toThrowError('TEXT_INGESTION_CONTENT_TOO_LARGE');
    expect(() => assertTextIngestionContent('1234', 3)).toThrowError('TEXT_INGESTION_CONTENT_TOO_LARGE');
    expect(() => assertTextIngestionContent('123', 0)).toThrowError('TEXT_INGESTION_LIMIT_INVALID');
    expect(exact).toHaveLength(TEXT_INGESTION_MAX_CHARS * 2);
  });

  it.each([null, 123, '', ' \r\n\t'])('rejects absent, non-string or blank source text (%j)', value => {
    expect(() => assertCreateTextIngestionInput(manual(value as string))).toThrowError('TEXT_INGESTION_CONTENT_EMPTY');
    expect(() => assertUpdateTextIngestionInput({ raw_content: value })).toThrowError('TEXT_INGESTION_CONTENT_EMPTY');
  });

  it('rejects identity, provenance and execution state injection into either mutation', () => {
    for (const field of ['id', 'created_by', 'created_at', 'updated_at', 'ingest_status', 'error_msg', 'rag_chunk_version']) {
      expect(() => assertCreateTextIngestionInput({ ...manual(), [field]: 'forged' })).toThrowError('TEXT_INGESTION_INPUT_INVALID');
      expect(() => assertUpdateTextIngestionInput({ raw_content: 'text', [field]: 'forged' })).toThrowError('TEXT_INGESTION_INPUT_INVALID');
    }
    expect(() => assertUpdateTextIngestionInput({ raw_content: 'text', source_type: TextIngestionSourceType.MANUAL_INPUT })).toThrowError('TEXT_INGESTION_INPUT_INVALID');
    expect(() => assertCreateTextIngestionInput({ ...manual(), origin_resource_uri: origin })).toThrowError('TEXT_INGESTION_ORIGIN_INVALID');
    expect(() => assertCreateTextIngestionInput({ source_type: 'manual', raw_content: 'text' })).toThrowError('TEXT_INGESTION_SOURCE_INVALID');
  });

  it.each(['file:///tmp/doc.pdf', 'javascript:alert(1)', 'https://user:secret@assets.example.test/doc.pdf', 'https://assets.example.test/doc.pdf#fragment', ' https://assets.example.test/doc.pdf', 'https://'])('rejects unsupported origin syntax without making a network request (%s)', uri => {
    expect(() => assertTextIngestionOrigin(uri)).toThrowError('TEXT_INGESTION_ORIGIN_INVALID');
  });
});

describe('strict text ingestion API schemas', () => {
  it('accepts only user-writable fields and rejects server-owned fields rather than stripping them', async () => {
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
    app.post('/create', { schema: { body: CreateTextIngestionSchema } }, req => req.body);
    app.patch('/edit', { schema: { body: UpdateTextIngestionSchema } }, req => req.body);
    try {
      const text = ' \n原文🙂\n ';
      const accepted = await app.inject({ method: 'POST', url: '/create', payload: manual(text) });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toEqual(manual(text));
      for (const payload of [
        { ...manual(), created_by: 'forged-user' },
        { ...manual(), ingest_status: 'success' },
        { source_type: TextIngestionSourceType.WEB_CRAWL, origin_resource_uri: origin, raw_content: 'forged' },
        { source_type: TextIngestionSourceType.MANUAL_INPUT, raw_content: 123 },
      ]) expect((await app.inject({ method: 'POST', url: '/create', payload })).statusCode).toBe(400);
      for (const source_type of externalSources) expect((await app.inject({ method: 'POST', url: '/create', payload: { source_type, origin_resource_uri: origin } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'PATCH', url: '/edit', payload: { raw_content: text } })).json()).toEqual({ raw_content: text });
      expect((await app.inject({ method: 'PATCH', url: '/edit', payload: { raw_content: text, source_type: TextIngestionSourceType.MANUAL_INPUT } })).statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it('represents external pending content as null and publishes timestamps as integer milliseconds', async () => {
    const job: TextIngestionJob = {
      id: '11111111-1111-4111-8111-111111111111', source_type: TextIngestionSourceType.FILE_UPLOAD,
      raw_content: null, origin_resource_uri: origin, ingest_status: 'pending', error_msg: null,
      created_at: 1_799_999_999_123, updated_at: 1_799_999_999_123, created_by: '22222222-2222-4222-8222-222222222222',
    };
    const app = Fastify();
    app.get('/job', { schema: { response: { 200: TextIngestionJobSchema } } }, () => job);
    try {
      const result = await app.inject('/job');
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual(job);
      expect(Object.keys(result.json())).toHaveLength(9);
    } finally { await app.close(); }
  });
});
