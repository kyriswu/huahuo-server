import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/config.js';
import { migrate } from '../../src/db/migrate.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { AssetService } from '../../src/modules/assets/service.js';
import { StorageService } from '../../src/modules/storage/service.js';
import { LocalStorageAdapter, type StoragePort } from '../../src/modules/storage/port.js';
import { noteImageViews } from '../../src/modules/assets/note-image-view.js';
import { buildApiServer } from '../../src/apps/api-server.js';
import { RagImageLinks } from '../../src/modules/rag/image-links.js';
import { ragImageKey, type RagImageRequest } from '../../src/modules/rag/query-service.js';
import { RagIngestionRepository } from '../../src/modules/rag/repository.js';
import { TextIngestionService } from '../../src/modules/text-ingestion/service.js';
import { TextIngestionSourceType } from '../../src/modules/text-ingestion/types.js';
import { insertFixtureUser, insertFixtureSession, testJwtEnv } from './jwt-fixture.js';
import { unseal } from '../../src/lib/crypto.js';

const url = process.env.TEST_DATABASE_MIGRATION_URL;
if (!url || !/^huahuo_test_/u.test(new URL(url).pathname.slice(1))) throw new Error('ISOLATED_TEST_DB_REQUIRED');
const directory = await mkdtemp(join(tmpdir(), 'note-images-'));
const config = loadConfig('api-server', { ...process.env, ...testJwtEnv, APP_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: process.env.TEST_DATABASE_API_URL,
  APP_TOKEN_SECRET: 'note-image-test-'.repeat(5), APP_PUBLIC_BASE_URL: 'https://notes.test', ALLOW_MOCK_PROVIDERS: 'true', RAG_PROVIDER_MODE: 'mock',
  RAG_RERANK_PROVIDER: 'disabled', RAG_SOURCE_ALLOWED_HOSTS: 'fixture.test', STORAGE_DRIVER: 'local', STORAGE_LOCAL_ROOT: directory });
config.kb.noteEnabled=true;
const root = poolFor(loadConfig('migrate', { DATABASE_URL: url })), pool = poolFor(config);
const adapter = new LocalStorageAdapter(directory), storage = new StorageService(pool, config, adapter), assets = new AssetService(pool, config.appTokenSecret!, config);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYa0AAAAASUVORK5CYII=', 'base64');
async function fixture() {
  const userId = await insertFixtureUser(root), sessionId = randomUUID(), workspaceId = randomUUID();
  const bearer = await insertFixtureSession(root, userId, sessionId);
  await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'Images',true,$3)", [workspaceId, userId, randomUUID()]);
  return { scope: { userId, sessionId, traceId: randomUUID() }, workspaceId, bearer };
}
async function image(f: Awaited<ReturnType<typeof fixture>>, workspaceId = f.workspaceId, mimeType = 'image/png') {
  const bytes = mimeType === 'image/png' ? png : Buffer.from('plain document');
  const upload = await storage.createUpload(f.scope, { sourceScene: 'note_image', fileName: mimeType === 'image/png' ? '图.png' : 'test.txt', mimeType, sizeBytes: BigInt(bytes.length), durationSeconds: 0, workspaceId }, randomUUID());
  await storage.put(upload.uploadId, upload.headers['X-Upload-Capability'], Readable.from([bytes]));
  await storage.complete(f.scope, upload.uploadId, randomUUID()); return upload.resourceId;
}
const sha = (content: string) => createHash('sha256').update(content).digest('hex');
const counts = async (id: string, workspaceId: string) => (await root.query(`SELECT
  (SELECT count(*)::int FROM note_part_revisions WHERE note_id=$1) revisions,
  (SELECT count(*)::int FROM content_jobs WHERE note_id=$1) tags,
  (SELECT count(*)::int FROM kb_note_hybrid_builds WHERE source_id=$1) builds,
  (SELECT next_cursor FROM workspace_content_state WHERE workspace_id=$2) cursor`, [id, workspaceId])).rows[0];
beforeAll(async () => {await migrate(loadConfig('migrate', { DATABASE_URL: url }));await root.query(`UPDATE runtime_configuration SET "values"="values"||'{"features.noteIndexing":true}'::jsonb,revision=revision+1`);});
afterAll(async () => { await root.query(`UPDATE runtime_configuration SET "values"="values"-'features.noteIndexing',revision=revision+1`);await Promise.all([pool.end(), root.end()]); await rm(directory, { recursive: true, force: true }); });

describe('canonical Note images with real isolated PostgreSQL and local storage', () => {
  it('normalizes owned playback URLs before hashing/idempotency and derives references without a client list', async () => {
    const f = await fixture(), id = await image(f), key = randomUUID();
    const temporary = (await storage.playback(f.scope, id)).url;
    const markdown = `😀 标题\r\n![图](<${temporary}> "说明")\r\n`;
    const note = await assets.createNote(f.scope, f.workspaceId, { title: '图文', parts: { raw: markdown } }, key);
    const canonical = markdown.replace(temporary, `asset://${id}`);
    expect(note.parts.raw).toMatchObject({ contentMarkdown: canonical, contentSha256: sha(canonical) });
    expect(note.resourceRefs).toMatchObject([{ resourceId: id, usage: 'inline-image', anchor: 'raw' }]);
    const replay = await assets.createNote(f.scope, f.workspaceId, { title: '图文', parts: { raw: markdown.replace(temporary, temporary.replace(/playbackToken=.*/u, 'playbackToken=expired-signature')) } }, key);
    expect(replay.noteId).toBe(note.noteId);
    const before = await counts(note.noteId, f.workspaceId);
    const same = await assets.updateNote(f.scope, f.workspaceId, note.noteId, { parts: { raw: markdown } }, note.etag, randomUUID());
    expect(same.etag).toBe(note.etag); expect(await counts(note.noteId, f.workspaceId)).toEqual(before);
  });
  it('resolves configured OSS object paths through owned records rather than guessing filename UUIDs', async () => {
    const f = await fixture(), id = await image(f);
    const ossConfig = { ...config, storageAliyunOss: { endpoint: 'https://oss-cn-beijing.aliyuncs.com', region: 'cn-beijing', bucket: 'fixture-assets', keyPrefix: 'private/dev', accessKeyId: 'fixture', accessKeySecret: 'fixture', secure: true, timeoutMs: 1000, maxBytes: 1000 } };
    const service = new AssetService(pool, config.appTokenSecret!, ossConfig);
    const note = await service.createNote(f.scope, f.workspaceId, { title: 'OSS', parts: { raw: `<img src="https://fixture-assets.oss-cn-beijing.aliyuncs.com/private/dev/${id}?Expires=0&amp;Signature=old">` } }, randomUUID());
    expect(note.parts.raw!.contentMarkdown).toBe(`<img src="asset://${id}">`);
    await expect(service.createNote(f.scope, f.workspaceId, { title: 'bad', parts: { raw: `![x](https://fixture-assets.oss-cn-beijing.aliyuncs.com/wrong/${id})` } }, randomUUID())).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    const external = `![外链](https://other.test/${id}?Signature=external)`;
    expect((await service.createNote(f.scope, f.workspaceId, { title: '外链', parts: { raw: external } }, randomUUID())).parts.raw!.contentMarkdown).toBe(external);
  });
  it('rejects foreign, other-workspace, missing and non-image resources without partial writes', async () => {
    const a = await fixture(), b = await fixture(), foreign = await image(b), document = await image(a, a.workspaceId, 'text/plain');
    const otherWorkspace = randomUUID();
    await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'Other',false,$3)", [otherWorkspace, a.scope.userId, randomUUID()]);
    const other = await image(a, otherWorkspace);
    for (const id of [foreign, other, randomUUID()]) await expect(assets.createNote(a.scope, a.workspaceId, { title: 'bad', parts: { raw: `![x](asset://${id})` } }, randomUUID())).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(assets.createNote(a.scope, a.workspaceId, { title: 'bad', parts: { raw: `![x](asset://${document})` } }, randomUUID())).rejects.toMatchObject({ code: 'NOTE_RESOURCE_NOT_IMAGE' });
    for (const target of ['data:image/png;base64,AA', 'file:///private/image.png', 'asset://not-a-uuid']) await expect(assets.createNote(a.scope, a.workspaceId, { title: 'bad', parts: { raw: `![x](${target})` } }, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    expect((await root.query('SELECT count(*)::int n FROM notes WHERE workspace_id=$1', [a.workspaceId])).rows[0].n).toBe(0);
  });
  it('syncs current references on edits but retains historical images and only revises changed parts', async () => {
    const f = await fixture(), first = await image(f), next = await image(f);
    const note = await assets.createNote(f.scope, f.workspaceId, { title: '历史', parts: { raw: `![图](asset://${first})`, outline: '不变' } }, randomUUID());
    const edited = await assets.updateNote(f.scope, f.workspaceId, note.noteId, { parts: { raw: `![图](asset://${next})`, outline: '不变' } }, note.etag, randomUUID());
    expect(edited.parts.outline!.partRevisionId).toBe(note.parts.outline!.partRevisionId);
    expect(edited.resourceRefs.map(ref => ref.resourceId)).toEqual([next]);
    const pins = (await root.query('SELECT ref_kind,ref_id_external FROM resource_refs WHERE resource_id=$1', [first])).rows;
    expect(pins).toEqual([{ ref_kind: 'note_revision', ref_id_external: note.parts.raw!.partRevisionId }]);
    expect((await assets.notePart(f.scope, f.workspaceId, note.noteId, 'raw', note.parts.raw!.partRevisionId)).contentMarkdown).toContain(first);
    await expect(storage.remove(f.scope, f.workspaceId, first, randomUUID())).rejects.toMatchObject({ code: 'RESOURCE_REFERENCED' });
    const empty = await assets.updateNote(f.scope, f.workspaceId, note.noteId, { parts: { raw: '删除当前图' } }, edited.etag, randomUUID());
    expect(empty.resourceRefs).toEqual([]);
    expect((await root.query('SELECT count(*)::int n FROM note_part_revisions WHERE note_id=$1', [note.noteId])).rows[0].n).toBe(5);
  });
  it('applies declared attachment changes atomically with ownership checks', async () => {
    const f = await fixture(), attachment = await image(f, f.workspaceId, 'text/plain'), foreign = await image(await fixture());
    const note = await assets.createNote(f.scope, f.workspaceId, { title: '附件', parts: { raw: '正文' }, resourceRefs: [{ resourceId: attachment, usage: 'original' }] }, randomUUID());
    await expect(assets.updateNote(f.scope, f.workspaceId, note.noteId, { title: '不能写入', resourceRefs: [{ resourceId: foreign, usage: 'original' }] }, note.etag, randomUUID())).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect((await assets.getNote(f.scope, f.workspaceId, note.noteId)).title).toBe('附件');
    const cleared = await assets.updateNote(f.scope, f.workspaceId, note.noteId, { resourceRefs: [] }, note.etag, randomUUID());
    expect(cleared.resourceRefs).toEqual([]);
    expect((await storage.remove(f.scope, f.workspaceId, attachment, randomUUID())).status).toBe('delete_pending');
  });
  it('renders fresh URLs outside stored receipts and never reads image bytes to create a view', async () => {
    const f = await fixture(), id = await image(f), original = `![图](asset://${id})`, api = await buildApiServer({ config });
    try {
      const response = await api.inject({ method: 'POST', url: `/api/v1/workspaces/${f.workspaceId}/notes`, headers: { authorization: `Bearer ${f.bearer}`, 'idempotency-key': randomUUID() }, payload: { title: '编辑视图', parts: { raw: original } } });
      expect(response.statusCode, response.body).toBe(200);
      const note = response.json().data;
      expect(note.parts.raw.contentMarkdown).toBe(original); expect(note.parts.raw.displayMarkdown).toContain('playbackToken=');
      expect(note.parts.raw.imageLinks).toMatchObject([{ resourceId: id }]); expect(response.headers['cache-control']).toBe('no-store');
      const receipts = await root.query('SELECT response_cipher FROM api_idempotency WHERE scope=$1', [`${f.scope.userId}:${f.workspaceId}`]);
      expect(receipts.rows).toHaveLength(1);
      expect(JSON.stringify(unseal(receipts.rows[0].response_cipher, config.appTokenSecret!))).not.toContain('playbackToken=');
      const noReads = vi.spyOn(adapter, 'read');
      await noteImageViews(storage, f.scope, f.workspaceId, [await assets.getNote(f.scope, f.workspaceId, note.noteId)]);
      expect(noReads).not.toHaveBeenCalled(); noReads.mockRestore();
    } finally { await api.close(); }
  });
  it('signs only selected owned file receipts and strips the OSS root prefix exactly once', async () => {
    const f = await fixture(), other = await fixture(), id = randomUUID(), unused = randomUUID(), revision = sha('canonical');
    const created = await new RagIngestionRepository(pool,config).create(f.scope, { ossUrl: 'https://fixture.test/a.md', fileName: 'a.md', mimeType: 'text/markdown' });
    await root.query("UPDATE rag_ingestion_versions SET status='SUCCEEDED',content_hash=$2 WHERE id=$1", [created.documentVersionId, revision]);
    for (const assetId of [id, unused]) await root.query(`INSERT INTO rag_document_assets(id,version_id,object_key,sha256,mime_type,byte_size,asset_type,source_asset_key,asset_ref,source_path,upload_status,metadata)
      VALUES($1::uuid,$2,$3,$4,'image/png',1,'image',$1::text,$1::text,$3,'ready',$5::jsonb)`, [assetId, created.documentVersionId, `private/dev/images/${assetId}.png`, sha(assetId), JSON.stringify({ bucket: 'fixture-assets' })]);
    const signUrl = vi.fn(async (key: string) => `https://signed.test/${key}`), read = vi.fn(() => { throw new Error('ORIGINAL_IMAGE_READ'); });
    const port = { signUrl, read } as unknown as StoragePort;
    const ossConfig = { ...config, storageDriver: 'aliyun-oss' as const, storageAliyunOss: { endpoint: 'https://oss-cn-beijing.aliyuncs.com', region: 'cn-beijing', bucket: 'fixture-assets', keyPrefix: 'private/dev', accessKeyId: 'fixture', accessKeySecret: 'fixture', secure: true, timeoutMs: 1000, maxBytes: 1000 } };
    const resolver = new RagImageLinks(pool, ossConfig, new StorageService(pool, ossConfig, port));
    const request: RagImageRequest = { sourceType: 'file', sourceId: created.documentVersionId, workspaceId: f.workspaceId, sourceRevision: revision, resourceId: id };
    expect((await resolver.resolve(f.scope, [request, request])).get(ragImageKey(request))?.url).toContain(`images/${id}.png`);
    expect(signUrl).toHaveBeenCalledExactlyOnceWith(`images/${id}.png`, 900); expect(read).not.toHaveBeenCalled();
    expect((await resolver.resolve(other.scope, [request])).size).toBe(0);
    expect((await resolver.resolve(f.scope, [{ ...request, workspaceId: other.workspaceId }])).size).toBe(0);
    expect(signUrl).toHaveBeenCalledTimes(1);
    signUrl.mockRejectedValueOnce(new Error('PREVIEW_SIGNING_UNAVAILABLE'));
    expect((await resolver.resolve(f.scope, [request])).size).toBe(0); expect(read).not.toHaveBeenCalled();
  });
  it('reads one bounded text parse manifest and signs only its selected, context-matching receipt', async () => {
    const f = await fixture(), foreign = await fixture(), id = randomUUID(), unused = randomUUID(), revision = sha('text canonical');
    const job = await new TextIngestionService(pool, config).create(f.scope, { source_type: TextIngestionSourceType.FILE_UPLOAD, origin_resource_uri: 'https://fixture.test/file.pdf' }, randomUUID());
    const task = (await root.query('SELECT t.id,t.input_id FROM text_ingestion_jobs j JOIN tasks t ON t.id=j.current_task_id WHERE j.id=$1', [job.id])).rows[0];
    const prefix = `extractions/${job.id}/${task.id}`, canonicalUri = `${prefix}/${revision}.md`, manifestUri = `${prefix}/${sha('receipts')}.assets.json`;
    await root.query('UPDATE task_inputs SET body=$2 WHERE id=$1', [task.input_id, JSON.stringify({ snapshot: { parser: { sourceResourceId: job.id, parseRunId: task.id } } })]);
    await root.query("UPDATE text_ingestion_jobs SET ingest_status='success',raw_content='text canonical',content_hash=$2,artifact_uri=$3 WHERE id=$1", [job.id, revision, canonicalUri]);
    await root.query('UPDATE tasks SET external_reference=$2 WHERE id=$1', [task.id, 'xberg-complete:' + Buffer.from(JSON.stringify({ phase: 'complete', canonicalUri, manifestUri })).toString('base64url')]);
    const receipts = [id, unused].map(resourceId => ({ resource_id: resourceId, uuid: resourceId, source_resource_id: job.id, parse_run_id: task.id, bucket: 'fixture-assets', object_key: `private/dev/images/${resourceId}.png`, mime_type: 'image/png' }));
    const read = vi.fn(async (key: string) => { expect(key).toBe(manifestUri); return Readable.from([JSON.stringify(receipts)]); }), signUrl = vi.fn(async (key: string) => `https://signed.test/${key}`);
    const ossConfig = { ...config, storageDriver: 'aliyun-oss' as const, storageAliyunOss: { endpoint: 'https://oss-cn-beijing.aliyuncs.com', region: 'cn-beijing', bucket: 'fixture-assets', keyPrefix: 'private/dev', accessKeyId: 'fixture', accessKeySecret: 'fixture', secure: true, timeoutMs: 1000, maxBytes: 1000 } };
    const resolver = new RagImageLinks(pool, ossConfig, new StorageService(pool, ossConfig, { read, signUrl } as unknown as StoragePort));
    const request: RagImageRequest = { sourceType: 'text', sourceId: job.id, workspaceId: f.workspaceId, sourceRevision: revision, resourceId: id };
    expect((await resolver.resolve(f.scope, [request, request])).size).toBe(1);
    expect(read).toHaveBeenCalledTimes(1); expect(signUrl).toHaveBeenCalledExactlyOnceWith(`images/${id}.png`, 900);
    expect((await resolver.resolve(foreign.scope, [request])).size).toBe(0);
    expect((await resolver.resolve(f.scope, [{ ...request, sourceRevision: sha('stale') }])).size).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);
    await root.query('UPDATE tasks SET external_reference=$2 WHERE id=$1', [task.id, 'xberg-complete:' + Buffer.from(JSON.stringify({ phase: 'complete', canonicalUri, manifestUri: 'other-user/manifest.assets.json' })).toString('base64url')]);
    expect((await resolver.resolve(f.scope, [request])).size).toBe(0); expect(read).toHaveBeenCalledTimes(1);
  });
});
