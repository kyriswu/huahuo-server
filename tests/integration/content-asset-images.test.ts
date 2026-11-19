import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTestConfig as loadConfig } from '../sms-fixture.js';
import { migrate } from '../../src/db/migrate.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { ContentAssetService } from '../../src/modules/content-assets/service.js';
import { StorageService } from '../../src/modules/storage/service.js';
import { ResourceClaims } from '../../src/modules/storage/resource-claims.js';
import type { StoragePort } from '../../src/modules/storage/port.js';
import { MockOssStorageAdapter, mockOssUploadConfig } from '../support/oss-upload.js';
import { contentAssetImageViews } from '../../src/modules/content-assets/content-asset-image-view.js';
import { buildApiServer } from '../../src/apps/api-server.js';
import { RagImageLinks } from '../../src/modules/rag/image-links.js';
import { ragImageKey, type RagImageRequest } from '../../src/modules/rag/query-service.js';
import { RagIngestionRepository } from '../../src/modules/rag/repository.js';
import { TextIngestionService } from '../../src/modules/text-ingestion/service.js';
import { TextIngestionSourceType } from '../../src/modules/text-ingestion/types.js';
import { insertFixtureUser, insertFixtureSession, testJwtEnv } from './jwt-fixture.js';
import { fixtureScopeHeaders } from './jwt-fixture.js';
import { unseal } from '../../src/lib/crypto.js';
import { DOCUMENT_ASSET_MANIFEST_MAX_BYTES } from '../../src/config/document-extraction.js';
import { inputImages } from '../../src/lib/markdown-images.js';
import { transaction } from '../../src/modules/identity/store.js';
import { WorkspaceService } from '../../src/modules/workspaces/service.js';

const url = process.env.TEST_DATABASE_MIGRATION_URL;
if (!url || !/^huahuo_test_/u.test(new URL(url).pathname.slice(1))) throw new Error('ISOLATED_TEST_DB_REQUIRED');
const directory = await mkdtemp(join(tmpdir(), 'content-asset-images-'));
const config = mockOssUploadConfig(loadConfig('api-server', { ...process.env, ...testJwtEnv, APP_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: process.env.TEST_DATABASE_API_URL,
  APP_TOKEN_SECRET: 'content-asset-image-test-'.repeat(5), APP_PUBLIC_BASE_URL: 'https://content-assets.test', ALLOW_MOCK_PROVIDERS: 'true', RAG_PROVIDER_MODE: 'mock',
  RAG_RERANK_PROVIDER: 'disabled', RAG_SOURCE_ALLOWED_HOSTS: 'fixture.test', STORAGE_DRIVER: 'local', STORAGE_LOCAL_ROOT: directory }));
config.kb.contentAssetEnabled=true;
const root = poolFor(loadConfig('migrate', { DATABASE_URL: url })), pool = poolFor(config);
const adapter = new MockOssStorageAdapter(directory), storage = new StorageService(pool, config, adapter);
const claims = new ResourceClaims(config, storage.uploads), contentAssets = new ContentAssetService(pool, config.appTokenSecret!, config, undefined, claims);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYa0AAAAASUVORK5CYII=', 'base64');
async function fixture() {
  const userId = await insertFixtureUser(root), sessionId = randomUUID(), workspaceId = randomUUID();
  const bearer = await insertFixtureSession(root, userId, sessionId);
  await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'Images',true,$3)", [workspaceId, userId, randomUUID()]);
  return { scope: { userId, sessionId, traceId: randomUUID() }, workspaceId, bearer };
}
async function image(f: Awaited<ReturnType<typeof fixture>>, workspaceId = f.workspaceId, mimeType = 'image/png') {
  const bytes = mimeType === 'image/png' ? png : Buffer.from('plain document');
  const upload = await storage.createUpload(f.scope, { fileName: mimeType === 'image/png' ? '图.png' : 'test.txt', mimeType, sizeBytes: BigInt(bytes.length), workspaceId },randomUUID());
  await adapter.uploadPart(upload.uploadUrl, bytes);
  await storage.complete(f.scope, upload.uploadId, randomUUID()); return upload.resourceId;
}
const sha = (content: string) => createHash('sha256').update(content).digest('hex');
const counts = async (id: string, workspaceId: string) => (await root.query(`SELECT
  (SELECT count(*)::int FROM content_asset_parts WHERE content_asset_id=$1) revisions,
  (SELECT count(*)::int FROM content_jobs WHERE content_asset_id=$1) tags,
  (SELECT count(*)::int FROM kb_content_asset_hybrid_builds WHERE source_id=$1) builds,
  (SELECT next_cursor FROM workspace_content_state WHERE workspace_id=$2) cursor`, [id, workspaceId])).rows[0];
beforeAll(async () => {await migrate(loadConfig('migrate', { DATABASE_URL: url }));await root.query(`UPDATE runtime_configuration SET "values"="values"||'{"features.contentAssetIndexing":true}'::jsonb,revision=revision+1`);});
afterAll(async () => { await root.query(`UPDATE runtime_configuration SET "values"="values"-'features.contentAssetIndexing',revision=revision+1`);await storage.close();await Promise.all([pool.end(), root.end()]); await rm(directory, { recursive: true, force: true }); });

describe('canonical ContentAsset images with real isolated PostgreSQL and mocked OSS', () => {
  it('normalizes owned playback URLs before hashing/idempotency and derives references without a client list', async () => {
    const f = await fixture(), id = await image(f), key = randomUUID();
    const temporary = (await storage.playback(f.scope, id)).url;
    const markdown = `😀 标题\r\n![图](<${temporary}> "说明")\r\n`;
    const contentAsset = await contentAssets.createContentAsset(f.scope, f.workspaceId, { title: '图文', parts: { raw: markdown } }, key);
    const canonical = `😀 标题\r\n<KBIMAGE uuid="${id}" alt="图" title="说明" />\r\n`;
    expect(contentAsset.parts.raw).toMatchObject({ contentMarkdown: canonical, contentSha256: sha(canonical) });
    expect(contentAsset.resourceRefs).toMatchObject([{ resourceId: id, usage: 'inline-image', anchor: 'raw' }]);
    const replay = await contentAssets.createContentAsset(f.scope, f.workspaceId, { title: '图文', parts: { raw: markdown.replace(temporary, temporary.replace(/x-oss-date=[^&#>\s)]+/u, 'x-oss-date=20000101T000000Z')) } }, key);
    expect(replay.contentAssetId).toBe(contentAsset.contentAssetId);
    const before = await counts(contentAsset.contentAssetId, f.workspaceId);
    const same = await contentAssets.updateContentAsset(f.scope, f.workspaceId, contentAsset.contentAssetId, { parts: { raw: markdown } }, contentAsset.etag, randomUUID());
    expect(same.etag).toBe(contentAsset.etag); expect(await counts(contentAsset.contentAssetId, f.workspaceId)).toEqual(before);
    const html = `😀 标题\r\n<img src="${temporary.replaceAll('&', '&amp;')}" alt="图" title="说明">\r\n`;
    const sameHtml = await contentAssets.updateContentAsset(f.scope, f.workspaceId, contentAsset.contentAssetId, { parts: { raw: html } }, contentAsset.etag, randomUUID());
    expect(sameHtml.etag).toBe(contentAsset.etag); expect(await counts(contentAsset.contentAssetId, f.workspaceId)).toEqual(before);
  });
  it('resolves configured OSS object paths through owned records rather than guessing filename UUIDs', async () => {
    const f = await fixture(), id = await image(f);
    const ossConfig = { ...config, storageAliyunOss: { endpoint: 'https://oss-cn-beijing-internal.aliyuncs.com', publicEndpoint: 'https://oss-cn-beijing.aliyuncs.com', region: 'cn-beijing', bucket: 'fixture-assets', keyPrefix: 'private/dev', accessKeyId: 'fixture', accessKeySecret: 'fixture', secure: true, timeoutMs: 1000, maxBytes: 1000 } };
    const service = new ContentAssetService(pool, config.appTokenSecret!, ossConfig, undefined, claims);
    const contentAsset = await service.createContentAsset(f.scope, f.workspaceId, { title: 'OSS', parts: { raw: `<img src="https://fixture-assets.oss-cn-beijing.aliyuncs.com/private/dev/${id}?Expires=0&amp;Signature=old">` } }, randomUUID());
    expect(contentAsset.parts.raw!.contentMarkdown).toBe(`<KBIMAGE uuid="${id}" alt="" />`);
    await expect(service.createContentAsset(f.scope, f.workspaceId, { title: 'bad', parts: { raw: `![x](https://fixture-assets.oss-cn-beijing.aliyuncs.com/wrong/${id})` } }, randomUUID())).rejects.toMatchObject({ code: 'IMAGE_URL_INVALID' });
    await expect(service.createContentAsset(f.scope, f.workspaceId, { title: 'unknown object', parts: { raw: '![x](https://fixture-assets.oss-cn-beijing.aliyuncs.com/private/dev/not-a-resource.png)' } }, randomUUID())).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    const privateUrl = `![内网](https://fixture-assets.oss-cn-beijing-internal.aliyuncs.com/private/dev/${id})`;
    expect((await service.createContentAsset(f.scope, f.workspaceId, { title: '内部对象', parts: { raw: privateUrl } }, randomUUID())).parts.raw!.contentMarkdown).toContain(`uuid="${id}"`);
    await expect(service.createContentAsset(f.scope, f.workspaceId, { title: 'removed proxy', parts: { raw: `![x](https://content-assets.test/api/v1/media/resources/${id}/object)` } }, randomUUID())).rejects.toMatchObject({ code: 'IMAGE_UPLOAD_REQUIRED' });
    const external = `![外链](https://other.test/${id}?Signature=external)`;
    await expect(service.createContentAsset(f.scope, f.workspaceId, { title: '外链', parts: { raw: external } }, randomUUID())).rejects.toMatchObject({ code: 'IMAGE_UPLOAD_REQUIRED' });
  });
  it('rejects foreign, missing and non-image files while allowing reuse across the owning user workspaces', async () => {
    const a = await fixture(), b = await fixture(), foreign = await image(b), document = await image(a, a.workspaceId, 'text/plain');
    const otherWorkspace = randomUUID();
    await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'Other',false,$3)", [otherWorkspace, a.scope.userId, randomUUID()]);
    const other = await image(a, otherWorkspace);
    for (const id of [foreign, randomUUID()]) await expect(contentAssets.createContentAsset(a.scope, a.workspaceId, { title: 'bad', parts: { raw: `![x](asset://${id})` } }, randomUUID())).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(contentAssets.createContentAsset(a.scope, a.workspaceId, { title: 'bad', parts: { raw: `![x](asset://${document})` } }, randomUUID())).rejects.toMatchObject({ code: 'IMAGE_RESOURCE_NOT_IMAGE' });
    for (const target of ['data:image/png;base64,AA', 'file:///private/image.png', 'asset://not-a-uuid']) await expect(contentAssets.createContentAsset(a.scope, a.workspaceId, { title: 'bad', parts: { raw: `![x](${target})` } }, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    expect((await root.query('SELECT count(*)::int n FROM content_assets WHERE user_id=$1', [a.scope.userId])).rows[0].n).toBe(0);
    const shared=await contentAssets.createContentAsset(a.scope,a.workspaceId,{title:'shared',parts:{raw:`![shared](asset://${other})`}},randomUUID());
    expect(shared.resourceRefs.map(ref=>ref.resourceId)).toContain(other);
  });
  it('rejects image identities from another bucket or storage driver before writing a contentAsset', async () => {
    const f = await fixture(), wrongBucket = await image(f), wrongDriver = await image(f);
    const bucketUrl = (await storage.playback(f.scope, wrongBucket)).url, driverUrl = (await storage.playback(f.scope, wrongDriver)).url;
    await transaction(pool, tx => claims.ensure(tx, f.scope, f.workspaceId, [wrongBucket, wrongDriver]));
    await root.query("UPDATE resources SET storage_bucket='another-fixture-bucket' WHERE resource_id=$1", [wrongBucket]);
    await root.query("UPDATE resources SET storage_driver='local' WHERE resource_id=$1", [wrongDriver]);
    for (const target of [`asset://${wrongBucket}`, bucketUrl, `asset://${wrongDriver}`, driverUrl]) {
      await expect(contentAssets.createContentAsset(f.scope, f.workspaceId, { title: 'bad storage', parts: { raw: `![图](<${target}>)` } }, randomUUID())).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    }
    expect((await root.query('SELECT count(*)::int n FROM content_assets WHERE user_id=$1', [f.scope.userId])).rows[0].n).toBe(0);
  });
  it('requires configured OSS for images while preserving the plain-text fast path', async () => {
    const f = await fixture(), id = await image(f), local = new ContentAssetService(pool, config.appTokenSecret!, { ...config, storageDriver: 'local', storageAliyunOss: undefined });
    await expect(local.createContentAsset(f.scope, f.workspaceId, { title: 'image', parts: { raw: `![图](asset://${id})` } }, randomUUID())).rejects.toMatchObject({ statusCode: 503, code: 'DIRECT_READ_NOT_CONFIGURED' });
    const contentAsset = await local.createContentAsset(f.scope, f.workspaceId, { title: 'plain', parts: { raw: '普通正文' } }, randomUUID());
    expect(contentAsset.parts.raw!.contentMarkdown).toBe('普通正文');
  });
  it('preserves canonical KBIMAGE OCR and code examples while deriving only genuine image references', async () => {
    const f = await fixture(), id = await image(f), foreign = randomUUID();
    const block = `<KBIMAGE uuid="${id}" page="2" role="chart"><![CDATA[OCR ![fake](asset://${foreign}) <img src="https://other.test/fake.png">]]></KBIMAGE>`;
    const examples = `\n\n\`\`\`xml\n<KBIMAGE uuid="${foreign}" />\n![fake](asset://${foreign})\n\`\`\`\n\n<!-- <KBIMAGE uuid="${foreign}" /> -->`;
    const canonical = block + examples;
    const contentAsset = await contentAssets.createContentAsset(f.scope, f.workspaceId, { title: 'Canonical', parts: { raw: canonical } }, randomUUID());
    expect(contentAsset.parts.raw!.contentMarkdown).toBe(canonical); expect(contentAsset.parts.raw!.contentSha256).toBe(sha(canonical));
    expect(contentAsset.resourceRefs.map(ref => ref.resourceId)).toEqual([id]);
    const viewed = (await contentAssetImageViews(storage, f.scope, f.workspaceId, [contentAsset]))[0]!;
    expect(viewed.parts.raw!.contentMarkdown).toContain('x-oss-signature=');
    expect(viewed.parts.raw!.contentMarkdown).not.toContain(`OCR ![fake](asset://${foreign})`);
    expect(viewed.parts.raw!.contentMarkdown).toContain(examples);
    expect(viewed.parts.raw).not.toHaveProperty('displayMarkdown');
    const before = await counts(contentAsset.contentAssetId, f.workspaceId);
    await expect(contentAssets.updateContentAsset(f.scope, f.workspaceId, contentAsset.contentAssetId, { title: 'must rollback', parts: { raw: `<KBIMAGE uuid="${foreign}" />` } }, contentAsset.etag, randomUUID())).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect((await contentAssets.getContentAsset(f.scope, f.workspaceId, contentAsset.contentAssetId)).title).toBe('Canonical');
    expect(await counts(contentAsset.contentAssetId, f.workspaceId)).toEqual(before);
  });
  it('converts a reference image occurrence without changing its shared link definition', async () => {
    const f = await fixture(), id = await image(f);
    const content = `![图][same]\n[下载][same]\n\n[same]: <asset://${id}> "说明"`;
    const expected = content.replace('![图][same]', `<KBIMAGE uuid="${id}" alt="图" title="说明" />`);
    const contentAsset = await contentAssets.importContentAsset(f.scope, f.workspaceId, { title: 'Reference', mimeType: 'text/markdown', content }, randomUUID());
    expect(contentAsset.contentAsset.parts.raw!.contentMarkdown).toBe(expected);
    expect(contentAsset.contentAsset.parts.raw!.contentSha256).toBe(sha(expected));
    expect(contentAsset.contentAsset.resourceRefs.map(ref => ref.resourceId)).toEqual([id]);
  });
  it('removes image-only URL definitions before hashing and idempotency', async () => {
    const f = await fixture(), id = await image(f), key = randomUUID();
    const temporary = (await storage.playback(f.scope, id)).url;
    const content = `![图][image]\n\n[image]: <${temporary}> "说明"\n`;
    const expected = `<KBIMAGE uuid="${id}" alt="图" title="说明" />\n\n\n`;
    const first = await contentAssets.createContentAsset(f.scope, f.workspaceId, { title: 'Reference', parts: { raw: content } }, key);
    const replay = await contentAssets.createContentAsset(f.scope, f.workspaceId, { title: 'Reference', parts: { raw: content.replace(/x-oss-signature=[^&#>\s)]+/u, 'x-oss-signature=refreshed') } }, key);
    expect(replay.contentAssetId).toBe(first.contentAssetId);
    expect(first.parts.raw).toMatchObject({ contentMarkdown: expected, contentSha256: sha(expected) });
  });
  it('rejects canonical expansion beyond each entry limit before creating or revising content', async () => {
    const f = await fixture(), id = await image(f), imageText = `![](asset://${id})`;
    const limitContent = (limit: number) => 'a'.repeat(limit - imageText.length) + imageText;
    await expect(contentAssets.createContentAsset(f.scope, f.workspaceId, { title: 'Too large', parts: { raw: '正文', outline: limitContent(200000) } }, randomUUID())).rejects.toMatchObject({ code: 'CONTENT_ASSET_CONTENT_TOO_LARGE' });
    expect((await root.query('SELECT count(*)::int n FROM content_assets WHERE user_id=$1', [f.scope.userId])).rows[0].n).toBe(0);
    const contentAsset = await contentAssets.createContentAsset(f.scope, f.workspaceId, { title: 'Before', parts: { raw: '正文' } }, randomUUID());
    const before = await counts(contentAsset.contentAssetId, f.workspaceId);
    await expect(contentAssets.updateContentAsset(f.scope, f.workspaceId, contentAsset.contentAssetId, { title: 'Must roll back', parts: { raw: limitContent(500000) } }, contentAsset.etag, randomUUID())).rejects.toMatchObject({ code: 'CONTENT_ASSET_CONTENT_TOO_LARGE' });
    expect((await contentAssets.getContentAsset(f.scope, f.workspaceId, contentAsset.contentAssetId)).title).toBe('Before');
    expect(await counts(contentAsset.contentAssetId, f.workspaceId)).toEqual(before);
  });
  it('replaces current content and image references without retaining historical bodies or pins', async () => {
    const f = await fixture(), first = await image(f), next = await image(f);
    const contentAsset = await contentAssets.createContentAsset(f.scope, f.workspaceId, { title: '历史', parts: { raw: `![图](asset://${first})`, outline: '不变' } }, randomUUID());
    const edited = await contentAssets.updateContentAsset(f.scope, f.workspaceId, contentAsset.contentAssetId, { parts: { raw: `![图](asset://${next})`, outline: '不变' } }, contentAsset.etag, randomUUID());
    expect(edited.parts.outline!.partRevisionId).toBe(contentAsset.parts.outline!.partRevisionId);
    expect(edited.resourceRefs.map(ref => ref.resourceId)).toEqual([next]);
    const pins = (await root.query('SELECT ref_kind,ref_id_external FROM resource_refs WHERE resource_id=$1', [first])).rows;
    expect(pins).toEqual([]);
    expect((await contentAssets.contentAssetPart(f.scope, f.workspaceId, contentAsset.contentAssetId, 'raw')).contentMarkdown).toContain(next);
    expect((await storage.remove(f.scope, f.workspaceId, first, randomUUID())).status).toBe('delete_pending');
    const empty = await contentAssets.updateContentAsset(f.scope, f.workspaceId, contentAsset.contentAssetId, { parts: { raw: '删除当前图' } }, edited.etag, randomUUID());
    expect(empty.resourceRefs).toEqual([]);
    expect((await root.query('SELECT count(*)::int n FROM content_asset_parts WHERE content_asset_id=$1', [contentAsset.contentAssetId])).rows[0].n).toBe(3);
  });
  it('applies declared attachment changes atomically with ownership checks', async () => {
    const f = await fixture(), attachment = await image(f, f.workspaceId, 'text/plain'), foreign = await image(await fixture());
    const contentAsset = await contentAssets.createContentAsset(f.scope, f.workspaceId, { title: '附件', parts: { raw: '正文' }, resourceRefs: [{ resourceId: attachment, usage: 'original' }] }, randomUUID());
    await expect(contentAssets.updateContentAsset(f.scope, f.workspaceId, contentAsset.contentAssetId, { title: '不能写入', resourceRefs: [{ resourceId: foreign, usage: 'original' }] }, contentAsset.etag, randomUUID())).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect((await contentAssets.getContentAsset(f.scope, f.workspaceId, contentAsset.contentAssetId)).title).toBe('附件');
    const cleared = await contentAssets.updateContentAsset(f.scope, f.workspaceId, contentAsset.contentAssetId, { resourceRefs: [] }, contentAsset.etag, randomUUID());
    expect(cleared.resourceRefs).toEqual([]);
    expect((await storage.remove(f.scope, f.workspaceId, attachment, randomUUID())).status).toBe('delete_pending');
  });
  it('allows a title update to finish while an image update waits for that same contentAsset, without reversing account/resource locks', async () => {
    const f=await fixture(), existing=await image(f), added=await image(f);
    const contentAsset=await contentAssets.createContentAsset(f.scope,f.workspaceId,{title:'Before',parts:{raw:`![existing](asset://${existing})`}},randomUUID());
    let titleLocked=false,imageWaiting=false,resumeTitle!:()=>void;
    const gate=new Promise<void>(resolve=>{resumeTitle=resolve;}),titleQueries:string[]=[];
    const titleClient=await pool.connect(),imageClient=await pool.connect();
    const locksContentAsset=(sql:string)=>sql.startsWith('SELECT asset.* FROM content_assets asset')&&sql.endsWith('FOR UPDATE OF asset');
    function observedPool(client:pg.PoolClient,afterQuery:(sql:string)=>Promise<void>,beforeQuery?:(sql:string)=>void):pg.Pool {
      const proxy=new Proxy(client,{get(target,property){
        if(property==='query')return async (sql:string,params?:unknown[])=>{beforeQuery?.(sql);const result=await target.query(sql,params);await afterQuery(sql);return result;};
        const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
      }});
      return {connect:async()=>proxy} as unknown as pg.Pool;
    }
    const titleService=new ContentAssetService(observedPool(titleClient,async sql=>{titleQueries.push(sql);if(locksContentAsset(sql)){titleLocked=true;await gate;}}),config.appTokenSecret!,config,undefined,claims);
    const imageService=new ContentAssetService(observedPool(imageClient,async()=>{},sql=>{if(locksContentAsset(sql))imageWaiting=true;}),config.appTokenSecret!,config,undefined,claims);
    let titleWrite:Promise<unknown>|undefined,imageWrite:Promise<unknown>|undefined;
    try {
      titleWrite=titleService.updateContentAsset(f.scope,f.workspaceId,contentAsset.contentAssetId,{title:'After'},contentAsset.etag,randomUUID());
      void titleWrite.catch(()=>{});
      await vi.waitFor(()=>expect(titleLocked).toBe(true),{timeout:2000});
      imageWrite=imageService.updateContentAsset(f.scope,f.workspaceId,contentAsset.contentAssetId,{parts:{raw:`![existing](asset://${existing})\n![new](asset://${added})`}},contentAsset.etag,randomUUID());
      void imageWrite.catch(()=>{});
      // Observe the second transaction after it owns the account and resources,
      // immediately before it blocks on the contentAsset owned by the title transaction.
      await vi.waitFor(()=>expect(imageWaiting).toBe(true),{timeout:2000});
      resumeTitle();
      const results=await Promise.allSettled([titleWrite,imageWrite]);
      expect(results[0]).toMatchObject({status:'fulfilled',value:{title:'After'}});
      expect(results[1]).toMatchObject({status:'rejected',reason:{code:'CONTENT_ASSET_REVISION_MISMATCH'}});
      expect(titleQueries.some(sql=>sql.includes('FROM users')&&sql.includes('FOR UPDATE'))).toBe(false);
      expect((await root.query('SELECT 1 FROM resources WHERE resource_id=$1',[added])).rowCount).toBe(0);
      expect((await storage.uploads.get(added))?.status).toBe('completed');
    } finally {resumeTitle();await Promise.allSettled([titleWrite,imageWrite].filter(value=>value!==undefined));if(!titleWrite)titleClient.release();if(!imageWrite)imageClient.release();}
  });
  it('claims avatars in the profile transaction and removes the previous owner reference on replacement and clearing', async () => {
    const f=await fixture(),first=await image(f),second=await image(f),workspaces=new WorkspaceService(pool,config.appTokenSecret!,claims);
    await workspaces.updateProfile(f.scope,{displayName:'Avatar',avatarResourceId:first},randomUUID());
    await workspaces.updateProfile(f.scope,{displayName:'Avatar',avatarResourceId:second},randomUUID());
    expect((await root.query("SELECT resource_id FROM resource_refs WHERE user_id=$1 AND ref_kind='avatar'",[f.scope.userId])).rows).toEqual([{resource_id:second}]);
    await workspaces.updateProfile(f.scope,{displayName:'Avatar',avatarResourceId:null},randomUUID());
    expect((await root.query("SELECT 1 FROM resource_refs WHERE user_id=$1 AND ref_kind='avatar'",[f.scope.userId])).rowCount).toBe(0);
  });
  it('normalizes UUID case before avatar validation and reference counting',async()=>{
    const f=await fixture(),document=await image(f,f.workspaceId,'text/plain'),picture=await image(f),workspaces=new WorkspaceService(pool,config.appTokenSecret!,claims);
    await expect(workspaces.updateProfile(f.scope,{displayName:'Avatar',avatarResourceId:document.toUpperCase()},randomUUID())).rejects.toMatchObject({code:'AVATAR_RESOURCE_NOT_IMAGE'});
    expect((await root.query('SELECT resource_id FROM resources WHERE resource_id=$1',[document])).rows).toEqual([]);
    await workspaces.updateProfile(f.scope,{displayName:'Avatar',avatarResourceId:picture.toUpperCase()},randomUUID());
    await workspaces.updateProfile(f.scope,{displayName:'Avatar',avatarResourceId:picture},randomUUID());
    await workspaces.updateProfile(f.scope,{displayName:'Avatar',avatarResourceId:picture.toUpperCase()},randomUUID());
    expect((await root.query('SELECT reference_count FROM resources WHERE resource_id=$1',[picture])).rows[0].reference_count).toBe('1');
    expect((await root.query("SELECT resource_id FROM resource_refs WHERE user_id=$1 AND ref_kind='avatar'",[f.scope.userId])).rows).toEqual([{resource_id:picture}]);
  });
  it('renders fresh URLs outside stored receipts and never reads image bytes to create a view', async () => {
    const f = await fixture(), id = await image(f), original = `![图](asset://${id})`, api = await buildApiServer({ config });
    try {
      const response = await api.inject({ method: 'POST', url: `/api/v1/workspaces/${f.workspaceId}/content-assets`, headers: { ...fixtureScopeHeaders(f.bearer), 'idempotency-key': randomUUID() }, payload: { title: '编辑视图', parts: { raw: original } } });
      expect(response.statusCode, response.body).toBe(200);
      const contentAsset = response.json().data;
      expect(contentAsset.parts.raw.contentMarkdown).toMatch(/^!\[图\]\(<https:/u); expect(contentAsset.parts.raw.contentSha256).toBe(sha(contentAsset.parts.raw.contentMarkdown));
      expect(contentAsset.parts.raw.contentMarkdown).toContain('x-oss-signature='); expect(contentAsset.parts.raw.contentMarkdown).not.toContain('<KBIMAGE');
      expect(contentAsset.parts.raw).not.toHaveProperty('displayMarkdown'); expect(contentAsset.parts.raw).not.toHaveProperty('imageLinks'); expect(response.headers['cache-control']).toBe('no-store');
      const receipts = await root.query('SELECT response_cipher FROM api_idempotency WHERE scope=$1', [`${f.scope.userId}:${f.workspaceId}`]);
      expect(receipts.rows).toHaveLength(1);
      expect(JSON.stringify(unseal(receipts.rows[0].response_cipher, config.appTokenSecret!))).not.toContain('x-oss-signature=');
      const noReads = vi.spyOn(adapter, 'read');
      await contentAssetImageViews(storage, f.scope, f.workspaceId, [await contentAssets.getContentAsset(f.scope, f.workspaceId, contentAsset.contentAssetId)]);
      expect(noReads).not.toHaveBeenCalled(); noReads.mockRestore();
    } finally { await api.close(); }
  });
  it('accepts an expired download URL on an editable Markdown round-trip and retains OCR through edits and retries', async () => {
    const f = await fixture(), id = await image(f), added = await image(f);
    const tag = `<KBIMAGE uuid="${id}" page="9" alt="原图" role="chart"><![CDATA[原始 OCR <文字>]]></KBIMAGE>`;
    const canonical = `正文\r\n${tag}\r\n末尾`, contentAsset = await contentAssets.createContentAsset(f.scope, f.workspaceId, { title: '往返', parts: { raw: canonical } }, randomUUID());
    const api = await buildApiServer({ config }), path = `/api/v1/workspaces/${f.workspaceId}/content-assets/${contentAsset.contentAssetId}`;
    const headers = fixtureScopeHeaders(f.bearer);
    try {
      const response = await api.inject({ method: 'GET', url: path, headers });
      expect(response.statusCode, response.body).toBe(200);
      const view = response.json().data.parts.raw.contentMarkdown as string, originalUrl = inputImages(view)[0]!.url;
      const expiredUrl = new URL(originalUrl);
      expect(expiredUrl.hostname).toBe('fixture-assets.oss-cn-beijing.aliyuncs.com');
      expiredUrl.searchParams.set('x-oss-date', '20000101T000000Z');
      const expired = view.replace(originalUrl, expiredUrl.href);
      // The save operation resolves the owned object key without fetching/verifying the expired OSS URL.
      const download = await api.inject({ method: 'GET', url: `/api/v1/media/resources/${id}/object` });
      expect(download.statusCode).toBe(404);
      const before = await counts(contentAsset.contentAssetId, f.workspaceId);
      const unchanged = await api.inject({ method: 'PATCH', url: path, headers: { ...headers, 'if-match': contentAsset.etag, 'idempotency-key': randomUUID() }, payload: { parts: { raw: expired } } });
      expect(unchanged.statusCode, unchanged.body).toBe(200); expect(unchanged.json().data.etag).toBe(contentAsset.etag);
      expect(await counts(contentAsset.contentAssetId, f.workspaceId)).toEqual(before);
      expect((await contentAssets.getContentAsset(f.scope, f.workspaceId, contentAsset.contentAssetId)).parts.raw!.contentMarkdown).toBe(canonical);
      const edited = expired.replace('正文', '客户端编辑').replace('![原图]', '![新说明]') + `\n![新增](<${(await storage.playback(f.scope, added)).url}>)`;
      const key = randomUUID(), request = { method: 'PATCH' as const, url: path, headers: { ...headers, 'if-match': contentAsset.etag, 'idempotency-key': key }, payload: { parts: { raw: edited } } };
      const saved = await api.inject(request);
      expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().data.etag).not.toBe(contentAsset.etag);
      const stored = await contentAssets.getContentAsset(f.scope, f.workspaceId, contentAsset.contentAssetId);
      expect(stored.parts.raw!.contentMarkdown).toBe(canonical.replace('正文', '客户端编辑').replace('alt="原图"', 'alt="新说明"') + `\n<KBIMAGE uuid="${added}" alt="新增" />`);
      expect(stored.parts.raw!.contentSha256).toBe(sha(stored.parts.raw!.contentMarkdown));
      expect(saved.json().data.parts.raw.contentMarkdown).not.toContain('原始 OCR');
      const replay = await api.inject(request);
      expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().data.etag).toBe(stored.etag);
      const stale = await api.inject({ ...request, headers: { ...request.headers, 'idempotency-key': randomUUID() } });
      expect(stale.statusCode, stale.body).toBe(412);
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
    const oversized = Readable.from([Buffer.alloc(DOCUMENT_ASSET_MANIFEST_MAX_BYTES), Buffer.from('x')]);
    read.mockResolvedValueOnce(oversized);signUrl.mockClear();
    expect((await resolver.resolve(f.scope, [request])).size).toBe(0);
    expect(oversized.destroyed).toBe(true);expect(signUrl).not.toHaveBeenCalled();
    await root.query('UPDATE tasks SET external_reference=$2 WHERE id=$1', [task.id, 'xberg-complete:' + Buffer.from(JSON.stringify({ phase: 'complete', canonicalUri, manifestUri: 'other-user/manifest.assets.json' })).toString('base64url')]);
    expect((await resolver.resolve(f.scope, [request])).size).toBe(0); expect(read).toHaveBeenCalledTimes(2);
  });
});
