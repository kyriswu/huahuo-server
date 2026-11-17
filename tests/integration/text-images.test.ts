import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTestConfig as loadConfig } from '../sms-fixture.js';
import { migrate } from '../../src/db/migrate.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { StorageService } from '../../src/modules/storage/service.js';
import { ResourceClaims } from '../../src/modules/storage/resource-claims.js';
import { TextIngestionService } from '../../src/modules/text-ingestion/service.js';
import { TextIngestionSourceType } from '../../src/modules/text-ingestion/types.js';
import { textImageViews } from '../../src/modules/text-ingestion/image-view.js';
import { RagImageLinks } from '../../src/modules/rag/image-links.js';
import { ragImageKey, type RagImageRequest } from '../../src/modules/rag/query-service.js';
import { inputImages } from '../../src/lib/markdown-images.js';
import { kbImages } from '../../src/lib/kb-images.js';
import { buildApiServer } from '../../src/apps/api-server.js';
import { MockOssStorageAdapter, mockOssUploadConfig } from '../support/oss-upload.js';
import { fixtureScopeHeaders, insertFixtureUser, insertFixtureSession, testJwtEnv } from './jwt-fixture.js';

const url = process.env.TEST_DATABASE_MIGRATION_URL;
if (!url || !/^huahuo_test_/u.test(new URL(url).pathname.slice(1))) throw new Error('ISOLATED_TEST_DB_REQUIRED');
const directory = await mkdtemp(join(tmpdir(), 'text-images-'));
const config = mockOssUploadConfig(loadConfig('api-server', { ...process.env, ...testJwtEnv, APP_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: process.env.TEST_DATABASE_API_URL,
  APP_TOKEN_SECRET: 'text-image-test-'.repeat(5), APP_PUBLIC_BASE_URL: 'https://texts.test', ALLOW_MOCK_PROVIDERS: 'true', RAG_PROVIDER_MODE: 'mock',
  RAG_RERANK_PROVIDER: 'disabled', STORAGE_DRIVER: 'local', STORAGE_LOCAL_ROOT: directory }));
const root = poolFor(loadConfig('migrate', { DATABASE_URL: url })), pool = poolFor(config);
const adapter = new MockOssStorageAdapter(directory), storage = new StorageService(pool, config, adapter);
const claims = new ResourceClaims(config, storage.uploads);
const texts = new TextIngestionService(pool, config, claims), resolver = new RagImageLinks(pool, config, storage);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYa0AAAAASUVORK5CYII=', 'base64');
const sha = (content: string) => createHash('sha256').update(content).digest('hex');
const tag = (id: string) => `<KBIMAGE uuid="${id}" alt="图" />`;
async function fixture() {
  const userId = await insertFixtureUser(root), sessionId = randomUUID(), workspaceId = randomUUID();
  const bearer = await insertFixtureSession(root, userId, sessionId);
  await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'Text images',true,$3)", [workspaceId, userId, randomUUID()]);
  return { scope: { userId, sessionId, traceId: randomUUID() }, workspaceId, bearer };
}
async function image(f: Awaited<ReturnType<typeof fixture>>, workspaceId = f.workspaceId, mimeType = 'image/png') {
  const bytes = mimeType === 'image/png' ? png : Buffer.from('plain document');
  const upload = await storage.createUpload(f.scope, { fileName: mimeType === 'image/png' ? '图.png' : 'test.txt', mimeType, sizeBytes: BigInt(bytes.length), workspaceId }, randomUUID());
  await adapter.uploadPart(upload.uploadUrl, bytes);
  await storage.complete(f.scope, upload.uploadId, randomUUID());
  return upload.resourceId;
}
const refs = async (id: string) => (await root.query("SELECT resource_id FROM resource_refs WHERE ref_kind='text-image' AND ref_id_external=$1 ORDER BY resource_id", [id])).rows.map(row => row.resource_id);
const counts = async (workspaceId: string) => (await root.query(`SELECT
  (SELECT count(*)::int FROM text_ingestion_jobs WHERE workspace_id=$1) jobs,
  (SELECT count(*)::int FROM tasks WHERE workspace_id=$1 AND kind='text.ingest') tasks,
  (SELECT count(*)::int FROM resource_refs WHERE workspace_id=$1 AND ref_kind='text-image') pins`, [workspaceId])).rows[0];
beforeAll(async () => { await migrate(loadConfig('migrate', { DATABASE_URL: url })); });
afterAll(async () => { await storage.close();await Promise.all([pool.end(), root.end()]); await rm(directory, { recursive: true, force: true }); });

describe('manual text image canonicalization with isolated PostgreSQL', () => {
  it('claims a completed file only with its owning business transaction and pins the exact object version', async () => {
    const f = await fixture(), id = await image(f, f.workspaceId, 'text/plain');
    const sourceUrl = (await storage.playback(f.scope, id)).url;
    const fileConfig = { ...config, processingNodes: { ...config.processingNodes, enabled: true },
      rag: { ...config.rag, sourceAllowedHosts: [new URL(sourceUrl).hostname] } };
    const service = new TextIngestionService(pool, fileConfig, claims);
    expect((await root.query('SELECT resource_id FROM resources WHERE resource_id=$1', [id])).rows).toEqual([]);
    const wrongVersion = new URL(sourceUrl); wrongVersion.searchParams.set('versionId', 'wrong-version');
    await expect(service.create(f.scope, { source_type: TextIngestionSourceType.FILE_UPLOAD, origin_resource_uri: wrongVersion.toString() }, randomUUID()))
      .rejects.toMatchObject({ code: 'RESOURCE_URL_INVALID' });
    expect((await root.query('SELECT resource_id FROM resources WHERE resource_id=$1', [id])).rows).toEqual([]);
    expect((await storage.uploads.get(id))?.status).toBe('completed');
    const job = await service.create(f.scope, { source_type: TextIngestionSourceType.FILE_UPLOAD, origin_resource_uri: sourceUrl }, randomUUID());
    expect((await root.query("SELECT resource_id FROM resource_refs WHERE ref_kind='text-source' AND ref_id_external=$1", [job.id])).rows)
      .toEqual([{ resource_id: id }]);
    expect((await root.query('SELECT file_name,mime_type FROM resources WHERE resource_id=$1', [id])).rows)
      .toEqual([{ file_name: 'test.txt', mime_type: 'text/plain' }]);
    expect(await storage.uploads.get(id)).toBeUndefined();
  });

  it('normalizes before hashing/idempotency and deduplicates image pins without reading bytes', async () => {
    const f = await fixture(), id = await image(f), key = randomUUID(), temporary = (await storage.playback(f.scope, id)).url;
    const raw = `😀 正文\r\n![图](<${temporary}>)\r\n![图](asset://${id})`;
    const read = vi.spyOn(adapter, 'read');
    try {
      const created = await texts.create(f.scope, { source_type: TextIngestionSourceType.MANUAL_INPUT, raw_content: raw }, key);
      const canonical = `😀 正文\r\n${tag(id)}\r\n${tag(id)}`;
      expect(created.raw_content).toBe(canonical);
      expect((await root.query('SELECT content_hash FROM text_ingestion_jobs WHERE id=$1', [created.id])).rows[0].content_hash).toBe(sha(canonical));
      expect(await refs(created.id)).toEqual([id]);
      const replay = await texts.create(f.scope, { source_type: TextIngestionSourceType.MANUAL_INPUT, raw_content: raw.replace(/x-oss-date=[^&#>\s)]+/u, 'x-oss-date=20000101T000000Z') }, key);
      expect(replay).toEqual(created);
      expect(await counts(f.workspaceId)).toEqual({ jobs: 1, tasks: 1, pins: 1 });
      await expect(texts.create(f.scope, { source_type: TextIngestionSourceType.MANUAL_INPUT, raw_content: `${canonical}\nchanged` }, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });

  it('replaces current pins atomically, keeps canonical no-op updates and replays stable', async () => {
    const f = await fixture(), first = await image(f), next = await image(f);
    const created = await texts.create(f.scope, { source_type: TextIngestionSourceType.MANUAL_INPUT, raw_content: `![图](asset://${first})` }, randomUUID());
    const initial = await texts.get(f.scope, created.id), before = await counts(f.workspaceId);
    const same = await texts.update(f.scope, created.id, { raw_content: `![图](<${(await storage.playback(f.scope, first)).url}>)` }, randomUUID(), initial.etag);
    expect(same.raw_content).toBe(tag(first));
    expect((await texts.get(f.scope, created.id)).etag).toBe(initial.etag);
    expect(await counts(f.workspaceId)).toEqual(before);
    const key = randomUUID(), temporary = (await storage.playback(f.scope, next)).url;
    const updated = await texts.update(f.scope, created.id, { raw_content: `![图](<${temporary}>)` }, key, initial.etag);
    expect(updated.raw_content).toBe(tag(next));
    expect(await refs(created.id)).toEqual([next]);
    expect((await root.query('SELECT content_hash FROM text_ingestion_jobs WHERE id=$1', [created.id])).rows[0].content_hash).toBe(sha(tag(next)));
    expect(await texts.update(f.scope, created.id, { raw_content: `![图](<${temporary.replace(/x-oss-date=[^&#>\s)]+/u, 'x-oss-date=20000101T000000Z')}>)` }, key, initial.etag)).toEqual(updated);
    expect(await counts(f.workspaceId)).toEqual({ jobs: 1, tasks: 2, pins: 1 });
    await expect(texts.update(f.scope, created.id, { raw_content: 'stale write' }, randomUUID(), initial.etag)).rejects.toMatchObject({ code: 'TEXT_INGESTION_CHANGED' });
    await expect(storage.remove(f.scope, f.workspaceId, next, randomUUID())).rejects.toMatchObject({ code: 'RESOURCE_REFERENCED' });
    expect((await storage.remove(f.scope, f.workspaceId, first, randomUUID())).status).toBe('delete_pending');
    const current = await texts.get(f.scope, created.id);
    await texts.update(f.scope, created.id, { raw_content: '图片已移除' }, randomUUID(), current.etag);
    expect(await refs(created.id)).toEqual([]);
    expect((await storage.remove(f.scope, f.workspaceId, next, randomUUID())).status).toBe('delete_pending');
  });

  it('rejects foreign/workspace/non-image/missing resources and unsupported URLs without partial state', async () => {
    const f = await fixture(), foreign = await image(await fixture()), document = await image(f, f.workspaceId, 'text/plain');
    const otherWorkspace = randomUUID();
    await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'Other',false,$3)", [otherWorkspace, f.scope.userId, randomUUID()]);
    const other = await image(f, otherWorkspace);
    for (const id of [foreign, other, randomUUID()]) await expect(texts.create(f.scope, { source_type: TextIngestionSourceType.MANUAL_INPUT, raw_content: tag(id) }, randomUUID())).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(texts.create(f.scope, { source_type: TextIngestionSourceType.MANUAL_INPUT, raw_content: tag(document) }, randomUUID())).rejects.toMatchObject({ code: 'NOTE_RESOURCE_NOT_IMAGE' });
    for (const target of ['data:image/png;base64,AA', 'file:///tmp/image.png', 'asset://not-a-uuid', `https://other.test/${randomUUID()}`]) {
      await expect(texts.create(f.scope, { source_type: TextIngestionSourceType.MANUAL_INPUT, raw_content: `![图](${target})` }, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(await counts(f.workspaceId)).toEqual({ jobs: 0, tasks: 0, pins: 0 });
    const id = await image(f), created = await texts.create(f.scope, { source_type: TextIngestionSourceType.MANUAL_INPUT, raw_content: tag(id) }, randomUUID());
    const current = await texts.get(f.scope, created.id), before = await counts(f.workspaceId);
    await expect(texts.update(f.scope, created.id, { raw_content: tag(foreign) }, randomUUID(), current.etag)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(await texts.get(f.scope, created.id)).toEqual(current);
    expect(await counts(f.workspaceId)).toEqual(before);
    expect(await refs(created.id)).toEqual([id]);
  });

  it('hydrates only current owned pinned manual images and uses no artifact/image reads', async () => {
    const f = await fixture(), other = await fixture(), id = await image(f), unused = await image(f);
    const created = await texts.create(f.scope, { source_type: TextIngestionSourceType.MANUAL_INPUT, raw_content: tag(id) }, randomUUID());
    await root.query("UPDATE text_ingestion_jobs SET ingest_status='success' WHERE id=$1", [created.id]);
    const request: RagImageRequest = { sourceType: 'text', sourceId: created.id, workspaceId: f.workspaceId, sourceRevision: sha(tag(id)), resourceId: id };
    const read = vi.spyOn(adapter, 'read');
    try {
      const selected = await resolver.resolve(f.scope, [request, request, { ...request, resourceId: unused }]);
      expect(selected.size).toBe(1);
      expect(selected.get(ragImageKey(request))?.url).toContain(`fixture-assets.oss-cn-beijing.aliyuncs.com/uploads/${id}?`);
      expect((await resolver.resolve(other.scope, [request])).size).toBe(0);
      expect((await resolver.resolve(f.scope, [{ ...request, workspaceId: other.workspaceId }, { ...request, sourceRevision: sha('old') }])).size).toBe(0);
      const current = await texts.get(f.scope, created.id);
      await texts.update(f.scope, created.id, { raw_content: tag(unused) }, randomUUID(), current.etag);
      expect((await resolver.resolve(f.scope, [request])).size).toBe(0);
      await root.query("UPDATE text_ingestion_jobs SET ingest_status='success' WHERE id=$1", [created.id]);
      const next = { ...request, sourceRevision: sha(tag(unused)), resourceId: unused };
      expect((await resolver.resolve(f.scope, [request, next, { ...next, resourceId: id }])).size).toBe(1);
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });

  it('preserves canonical OCR bytes and ignores code examples when deriving pins', async () => {
    const f = await fixture(), id = await image(f), literal = randomUUID();
    const content = `\`<KBIMAGE uuid="${literal}" />\`\n\n<KBIMAGE uuid="${id}" alt="图">OCR 原文\r\n</KBIMAGE>`;
    const created = await texts.create(f.scope, { source_type: TextIngestionSourceType.MANUAL_INPUT, raw_content: content }, randomUUID());
    expect(created.raw_content).toBe(content);
    expect(await refs(created.id)).toEqual([id]);
    expect((await root.query('SELECT content_hash FROM text_ingestion_jobs WHERE id=$1', [created.id])).rows[0].content_hash).toBe(sha(content));
  });

  it('returns editable Markdown over HTTP and restores repeated-image OCR metadata on unchanged saves', async () => {
    const f = await fixture(), id = await image(f);
    const first = `<KBIMAGE uuid="${id}" alt="图一" page="1" width="200"><![CDATA[OCR一\r\n第二行]]></KBIMAGE>`;
    const second = `<KBIMAGE uuid="${id}" alt="图二" page="2" width="400"><![CDATA[OCR二]]></KBIMAGE>`;
    const original = `${first}\n${second}`;
    const created = await texts.create(f.scope, { source_type: TextIngestionSourceType.MANUAL_INPUT, raw_content: original }, randomUUID());
    const api = await buildApiServer({ config });
    try {
      const get = await api.inject({ method: 'GET', url: `/api/v1/text-ingestions/${created.id}`, headers: fixtureScopeHeaders(f.bearer) });
      expect(get.statusCode, get.body).toBe(200);
      const editable = get.json().data.raw_content as string, parsed = inputImages(editable);
      expect(editable).not.toContain('<KBIMAGE'); expect(editable).not.toContain('OCR一'); expect(editable).not.toContain('<span>');
      expect(parsed.map(image => image.kind)).toEqual(['html', 'html']); // Standard Markdown HTML retains explicit dimensions.
      expect(parsed.map(image => image.width)).toEqual(['200', '400']);
      expect(parsed.map(image => new URL(image.url).hash)).toEqual([`#kbimage=${sha(first)}`, `#kbimage=${sha(second)}`]);
      const expired = editable.replace(/x-oss-date=[^&#>\s)]+/gu, 'x-oss-date=20000101T000000Z');
      const saved = await api.inject({ method: 'PATCH', url: `/api/v1/text-ingestions/${created.id}`, headers: { ...fixtureScopeHeaders(f.bearer), 'if-match': get.headers.etag!, 'idempotency-key': randomUUID() }, payload: { raw_content: expired } });
      expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().data.raw_content).not.toContain('<KBIMAGE');
      expect(get.headers['cache-control']).toBe('no-store'); expect(saved.headers['cache-control']).toBe('no-store');
      expect((await texts.get(f.scope, created.id)).data.raw_content).toBe(original);
      expect((await texts.get(f.scope, created.id)).etag).toBe(get.headers.etag);
      expect(await counts(f.workspaceId)).toEqual({ jobs: 1, tasks: 1, pins: 1 });
      expect((await root.query('SELECT content_hash FROM text_ingestion_jobs WHERE id=$1', [created.id])).rows[0].content_hash).toBe(sha(original));
      const list = await api.inject({ method: 'GET', url: '/api/v1/text-ingestions', headers: fixtureScopeHeaders(f.bearer) });
      expect(list.json().data.items[0].raw_content).not.toContain('<KBIMAGE');
    } finally { await api.close(); }
  });

  it('keeps image instances attached to their OCR after edits and replays the original request after origins change', async () => {
    const f = await fixture(), id = await image(f), otherImage = await image(f);
    const first = `<KBIMAGE uuid="${id}" alt="图一" page="1"><![CDATA[OCR一]]></KBIMAGE>`;
    const second = `<KBIMAGE uuid="${id}" alt="图二" page="2"><![CDATA[OCR二]]></KBIMAGE>`;
    const created = await texts.create(f.scope, { source_type: TextIngestionSourceType.MANUAL_INPUT, raw_content: `${first}\n${second}` }, randomUUID());
    const initial = await texts.get(f.scope, created.id), view = (await textImageViews(storage, f.scope, [initial.data]))[0]!;
    const edit = view.raw_content!.split('\n').reverse().join('\n').replace('图一', '改后的图一'), key = randomUUID();
    const updated = await texts.update(f.scope, created.id, { raw_content: edit }, key, initial.etag);
    const images = kbImages(updated.raw_content!);
    expect(images.map(image => image.alt)).toEqual(['图二', '改后的图一']);
    expect(updated.raw_content!.slice(images[0]!.nodeStart, images[0]!.nodeEnd)).toBe(second);
    expect(updated.raw_content!.slice(images[1]!.nodeStart, images[1]!.nodeEnd)).toContain('page="1"');
    expect(updated.raw_content!.slice(images[1]!.contentStart, images[1]!.contentEnd)).toBe('<![CDATA[OCR一]]>');
    const current = await texts.get(f.scope, created.id), before = await counts(f.workspaceId);
    expect(await texts.update(f.scope, created.id, { raw_content: edit.replace(/x-oss-date=[^&#>\s)]+/gu, 'x-oss-date=20000101T000000Z') }, key, initial.etag)).toEqual(updated);
    expect(await counts(f.workspaceId)).toEqual(before);
    await expect(texts.update(f.scope, created.id, { raw_content: edit }, randomUUID(), initial.etag)).rejects.toMatchObject({ code: 'TEXT_INGESTION_CHANGED' });
    await expect(texts.update(f.scope, created.id, { raw_content: edit }, randomUUID(), current.etag)).rejects.toMatchObject({ code: 'NOTE_IMAGE_ORIGIN_NOT_FOUND' });
    const forged = view.raw_content!.replaceAll(`/resources/${id}/`, `/resources/${otherImage}/`);
    await expect(texts.update(f.scope, created.id, { raw_content: forged }, randomUUID(), current.etag)).rejects.toMatchObject({ code: 'NOTE_IMAGE_ORIGIN_NOT_FOUND' });
    expect((await texts.get(f.scope, created.id)).data.raw_content).toBe(updated.raw_content);
    expect(await refs(created.id)).toEqual([id]);
  });

  it('accepts expanded editable URLs near the canonical limit but still rejects oversized stored prose', async () => {
    const f = await fixture(), id = await image(f), canonical = `${'x'.repeat(49_920)}\n${tag(id)}`;
    expect(canonical.length).toBeLessThanOrEqual(50_000);
    const created = await texts.create(f.scope, { source_type: TextIngestionSourceType.MANUAL_INPUT, raw_content: canonical }, randomUUID());
    const api = await buildApiServer({ config });
    try {
      const get = await api.inject({ method: 'GET', url: `/api/v1/text-ingestions/${created.id}`, headers: fixtureScopeHeaders(f.bearer) });
      const editable = get.json().data.raw_content as string;
      expect(editable.length).toBeGreaterThan(50_000);
      const saved = await api.inject({ method: 'PATCH', url: `/api/v1/text-ingestions/${created.id}`, headers: { ...fixtureScopeHeaders(f.bearer), 'if-match': get.headers.etag!, 'idempotency-key': randomUUID() }, payload: { raw_content: editable } });
      expect(saved.statusCode, saved.body).toBe(200);
      expect((await texts.get(f.scope, created.id)).data.raw_content).toBe(canonical);
      const oversized = await api.inject({ method: 'PATCH', url: `/api/v1/text-ingestions/${created.id}`, headers: { ...fixtureScopeHeaders(f.bearer), 'if-match': get.headers.etag!, 'idempotency-key': randomUUID() }, payload: { raw_content: 'x'.repeat(50_001) } });
      expect(oversized.statusCode, oversized.body).toBe(413);
      const oversizedCreate = await api.inject({ method: 'POST', url: '/api/v1/text-ingestions', headers: { ...fixtureScopeHeaders(f.bearer), 'idempotency-key': randomUUID() }, payload: { source_type: TextIngestionSourceType.MANUAL_INPUT, raw_content: 'x'.repeat(50_001) } });
      expect(oversizedCreate.statusCode, oversizedCreate.body).toBe(413);
      expect((await texts.get(f.scope, created.id)).data.raw_content).toBe(canonical);
      expect(await counts(f.workspaceId)).toEqual({ jobs: 1, tasks: 1, pins: 1 });
    } finally { await api.close(); }
  });
});
