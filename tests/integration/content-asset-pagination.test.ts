import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { buildApiServer } from '../../src/apps/api-server.js';
import { assetKinds } from '../../src/contracts/asset-kind.js';
import { migrate } from '../../src/db/migrate.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { ContentAssetService } from '../../src/modules/content-assets/service.js';
import { loadTestConfig as loadConfig } from '../sms-fixture.js';
import { fixtureScopeHeaders, insertFixtureSession, insertFixtureUser, testJwtEnv } from './jwt-fixture.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL;
const apiUrl = process.env.TEST_DATABASE_API_URL;
const redisUrls = [process.env.REDIS_CACHE_URL, process.env.REDIS_QUEUE_URL];
if (!migrationUrl || !apiUrl || !/^huahuo_test_/.test(new URL(migrationUrl).pathname.slice(1))
  || new URL(migrationUrl).hostname !== '127.0.0.1'
  || new URL(apiUrl).hostname !== '127.0.0.1'
  || new URL(apiUrl).pathname !== new URL(migrationUrl).pathname
  || redisUrls.some(url => !url || new URL(url).hostname !== '127.0.0.1' || Number(new URL(url).pathname.slice(1)) < 10)) {
  throw new Error('ISOLATED_DATABASE_REQUIRED');
}
const config = loadConfig('api-server', {
  ...testJwtEnv, APP_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: apiUrl,
  APP_TOKEN_SECRET: 'content-asset-pagination-fixture-'.repeat(3), APP_PUBLIC_BASE_URL: 'http://content-assets.test',
  REDIS_CACHE_URL: redisUrls[0], REDIS_QUEUE_URL: redisUrls[1],
  REDIS_KEY_PREFIX: 'content_asset_pagination_' + randomUUID().replaceAll('-', ''), METRICS_ENABLED: 'false',
  RAG_PROVIDER_MODE: 'disabled', BILLING_MODE: 'disabled',
  PROCESSING_NODES_CLOUD_CONTROL_ENABLED: 'false',
});
const migrationConfig = loadConfig('migrate', { APP_ENV: 'test', DATABASE_URL: migrationUrl });
const root = poolFor(migrationConfig), pool = poolFor(config);
const contentAssets = new ContentAssetService(pool, config.appTokenSecret!);
const userIds: string[] = [], contentAssetIds: string[] = [];

beforeAll(() => migrate(migrationConfig));
afterAll(async () => {
  try {
    await root.query('DELETE FROM content_asset_parts WHERE content_asset_id=ANY($1::uuid[])', [contentAssetIds]);
    await root.query('DELETE FROM content_assets WHERE content_asset_id=ANY($1::uuid[])', [contentAssetIds]);
    await root.query('DELETE FROM content_events WHERE user_id=ANY($1::uuid[])', [userIds]);
    await root.query('DELETE FROM account_content_state WHERE user_id=ANY($1::uuid[])', [userIds]);
    await root.query('DELETE FROM api_idempotency WHERE scope=ANY($1::text[])', [userIds]);
    await root.query('DELETE FROM user_sessions WHERE user_id=ANY($1::uuid[])', [userIds]);
    await root.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [userIds]);
  } finally {
    await Promise.all([pool.end(), root.end()]);
  }
});

async function fixture() {
  const userId = await insertFixtureUser(root), sessionId = randomUUID();
  userIds.push(userId);
  const bearer = await insertFixtureSession(root, userId, sessionId);
  return { bearer, scope: { userId, sessionId, traceId: randomUUID() } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function seed(f: Fixture, count: number, spacing: 'seconds' | 'same' | 'microseconds' = 'seconds') {
  const interval = spacing === 'same' ? '0 seconds' : spacing === 'microseconds' ? '1 microsecond' : '1 second';
  const inserted = await root.query<{ content_asset_id: string }>(`INSERT INTO content_assets(content_asset_id,user_id,title,content_asset_revision_id,etag,updated_at)
    SELECT gen_random_uuid(),$1,'content-asset-'||i,gen_random_uuid(),'fixture-'||i,
      '2026-01-01T00:00:00.999999Z'::timestamptz-i*$3::interval
    FROM generate_series(1,$2::int)i RETURNING content_asset_id`,
  [f.scope.userId, count, interval]);
  contentAssetIds.push(...inserted.rows.map(row => row.content_asset_id));
  return (await root.query<{ content_asset_id: string }>(
    `SELECT n.content_asset_id FROM content_assets n WHERE user_id=$1
     ORDER BY n.updated_at DESC,n.content_asset_id ASC`, [f.scope.userId],
  )).rows.map(row => row.content_asset_id);
}
async function pages(f: Fixture) {
  const result: Array<Awaited<ReturnType<ContentAssetService['listContentAssets']>>> = [];
  let cursor: string | undefined;
  do {
    const page = await contentAssets.listContentAssets(f.scope, cursor);
    result.push(page);
    // Bound the test if a broken cursor accidentally repeats a page forever.
    expect(result.length).toBeLessThanOrEqual(5);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return result;
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

it('keeps the migrated asset kind constraint in sync with the shared enum', async () => {
  const { rows: [constraint] } = await root.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='public.content_assets'::regclass
      AND conname='content_assets_asset_kind_check' AND contype='c' AND convalidated`);
  expect(constraint).toBeDefined();
  const allowedKinds = Array.from(constraint!.definition.matchAll(/'([^']+)'::text/g), match => match[1]);
  expect(allowedKinds.sort()).toEqual([...assetKinds].sort());
});

it('returns 45 active contentAssets as 20, 20 and 5 without duplicates or missing items', async () => {
  const f = await fixture(), expected = await seed(f, 45);
  const result = await pages(f);
  expect(result.map(page => page.items.length)).toEqual([20, 20, 5]);
  expect(result.flatMap(page => page.items.map(item => item.contentAssetId))).toEqual(expected);
  expect(result[0]!.items[0]).toMatchObject({ title: 'content-asset-1', updatedAt: expect.any(String) });
  expect(result[0]!.nextCursor).toEqual(expect.any(String));
  expect(result[1]!.nextCursor).toEqual(expect.any(String));
  expect(result[2]!.nextCursor).toBeNull();
});

it('returns no next cursor for an empty page or exactly 20 contentAssets', async () => {
  const f = await fixture();
  expect(await contentAssets.listContentAssets(f.scope)).toEqual({ items: [], nextCursor: null });
  await seed(f, 20);
  const page = await contentAssets.listContentAssets(f.scope);
  expect(page.items).toHaveLength(20);
  expect(page.nextCursor).toBeNull();
});

it('uses contentAsset ID to continue across equal update timestamps', async () => {
  const f = await fixture(), expected = await seed(f, 43, 'same');
  const result = await pages(f);
  expect(result.map(page => page.items.length)).toEqual([20, 20, 3]);
  expect(result.flatMap(page => page.items.map(item => item.contentAssetId))).toEqual(expected);
});

it('preserves PostgreSQL microseconds when the page boundary falls within one millisecond', async () => {
  const f = await fixture(), expected = await seed(f, 42, 'microseconds');
  const result = await pages(f);
  expect(result.map(page => page.items.length)).toEqual([20, 20, 2]);
  expect(result.flatMap(page => page.items.map(item => item.contentAssetId))).toEqual(expected);
});

it('continues after the previous page anchor is deleted', async () => {
  const f = await fixture(), expected = await seed(f, 25);
  const first = await contentAssets.listContentAssets(f.scope);
  await root.query('DELETE FROM content_assets WHERE content_asset_id=$1', [first.items.at(-1)!.contentAssetId]);
  const second = await contentAssets.listContentAssets(f.scope, first.nextCursor!);
  expect(second.items.map(item => item.contentAssetId)).toEqual(expected.slice(20));
  expect(second.nextCursor).toBeNull();
});

it('rejects malformed and cross-account cursors without exposing another user’s contentAssets', async () => {
  const f = await fixture(), other = await fixture();
  await seed(f, 21); const otherIds = await seed(other, 3);
  const first = await contentAssets.listContentAssets(f.scope);
  for (const cursor of [
    '', 'not-a-cursor', encode(null), encode({}),
    encode({ userId: f.scope.userId, updatedAt: 'not-a-date', contentAssetId: randomUUID() }),
    encode({ userId: f.scope.userId, updatedAt: '2026-02-30T00:00:00.000000Z', contentAssetId: randomUUID() }),
    encode({ userId: f.scope.userId, updatedAt: '2026-01-01T00:00:00.000000Z', contentAssetId: 'not-a-uuid' }),
  ]) await expect(contentAssets.listContentAssets(f.scope, cursor)).rejects.toMatchObject({ statusCode: 400, code: 'CONTENT_ASSET_CURSOR_INVALID' });
  await expect(contentAssets.listContentAssets(other.scope, first.nextCursor!)).rejects.toMatchObject({ statusCode: 400, code: 'CONTENT_ASSET_CURSOR_INVALID' });
  expect((await contentAssets.listContentAssets(other.scope)).items.map(item => item.contentAssetId)).toEqual(otherIds);
});

it('keeps SQL round trips bounded and independent of page length', async () => {
  const small = await fixture(), full = await fixture();
  await seed(small, 1); await seed(full, 21);
  const measure = async (f: Fixture) => {
    const client = await pool.connect(), original = client.query.bind(client);
    let count = 0;
    const spy = vi.spyOn(client, 'query').mockImplementation(((...args: unknown[]) => {
      count++;
      return (original as (...args: unknown[]) => unknown)(...args);
    }) as typeof client.query);
    const countedPool = { connect: async () => client } as unknown as typeof pool;
    try {
      const page = await new ContentAssetService(countedPool, config.appTokenSecret!).listContentAssets(f.scope);
      return { count, page };
    } finally { spy.mockRestore(); }
  };
  const one = await measure(small), twenty = await measure(full);
  expect(one.page.items).toHaveLength(1); expect(twenty.page.items).toHaveLength(20);
  expect(twenty.count).toBe(one.count);
  expect(twenty.count).toBeLessThanOrEqual(8);
});

it('returns full Markdown using one locked contentAsset lookup', async () => {
  const f = await fixture(), ids = await seed(f, 1), content = '完整正文\n'.repeat(2000);
  await root.query(`INSERT INTO content_asset_parts(part_revision_id,content_asset_id,part,revision,content_markdown,content_sha256)
    VALUES($1,$2,'raw',1,$3,$4)`, [randomUUID(), ids[0], content, createHash('sha256').update(content).digest('hex')]);
  const client = await pool.connect();
  const queries = vi.spyOn(client, 'query');
  const detailPool = { connect: async () => client } as unknown as typeof pool;
  try {
    const contentAsset = await new ContentAssetService(detailPool, config.appTokenSecret!).getContentAsset(f.scope, ids[0]!);
    expect(contentAsset.parts.raw!.contentMarkdown).toBe(content);
    const assetLookups = queries.mock.calls.map(([sql]) => sql).filter(sql => sql.includes('FROM content_assets asset'));
    expect(assetLookups).toHaveLength(1);
    expect(assetLookups[0]).toContain('FOR SHARE OF asset');
  } finally { queries.mockRestore(); }
});

it('returns the persisted asset kind and content status in both list and detail responses', async () => {
  const f = await fixture();
  const cases = [
    { assetKind: 'creative', sourceKind: 'manual', sourceId: null, contentStatus: 'draft' },
    { assetKind: 'image', sourceKind: 'link', sourceId: 'https://example.invalid/image.png', contentStatus: 'ready' },
    { assetKind: 'audio', sourceKind: 'recording', sourceId: null, contentStatus: 'processing' },
    { assetKind: 'link', sourceKind: 'manual', sourceId: 'https://example.invalid/article', contentStatus: 'failed' },
    { assetKind: 'file', sourceKind: 'link', sourceId: 'https://example.invalid/report.pdf', contentStatus: 'processing' },
    { assetKind: 'file', sourceKind: 'import', sourceId: 'https://example.invalid/document', contentStatus: 'ready' },
  ];
  const ids = await seed(f, cases.length);
  for (const [index, item] of cases.entries()) {
    await root.query('UPDATE content_assets SET asset_kind=$2, source_kind=$3, source_id=$4, processing_status=$5 WHERE content_asset_id=$1',
      [ids[index], item.assetKind, item.sourceKind, item.sourceId, item.contentStatus]);
  }
  const app = await buildApiServer({ config });
  const url = '/api/v1/content-assets', headers = fixtureScopeHeaders(f.bearer);
  try {
    const list = await app.inject({ url, headers });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data.items).toEqual(cases.map((item, index) => expect.objectContaining({
      contentAssetId: ids[index], assetKind: item.assetKind, sourceKind: item.sourceKind, contentStatus: item.contentStatus,
    })));
    for (const [index, item] of cases.entries()) {
      const detail = await app.inject({ url: `${url}/${ids[index]}`, headers });
      expect(detail.statusCode, detail.body).toBe(200);
      const data = detail.json().data;
      expect(data).toMatchObject({
        contentAssetId: ids[index], assetKind: item.assetKind, sourceKind: item.sourceKind, contentStatus: item.contentStatus,
      });
      if (item.contentStatus === 'processing' || item.contentStatus === 'failed') expect(data.content).toBeNull();
      if (item.assetKind === 'creative') expect(data.content).toEqual({ text: '', format: 'markdown', resources: [] });
      if (item.assetKind === 'image') expect(data.content).toMatchObject({ sourceUrl: item.sourceId, resources: [] });
      const tags = await app.inject({ url: `${url}/${ids[index]}/tags`, headers });
      expect(tags.statusCode, tags.body).toBe(200);
      expect(tags.json().data.processingStatus).toBe(item.contentStatus === 'ready' ? 'ready' : 'needs-processing');
    }
  } finally { await app.close(); }
});

it('persists link creation and returns ready content status for saved text and imported documents', async () => {
  const f = await fixture(), app = await buildApiServer({ config });
  const url = '/api/v1/content-assets', headers = fixtureScopeHeaders(f.bearer);
  const writes = [
    { title: 'Saved work', assetKind: 'creative', sourceKind: 'manual', expectedKind: 'creative' },
    { title: 'Explicit link', assetKind: 'link', sourceKind: 'manual', expectedKind: 'link' },
    { title: 'Legacy link', sourceKind: 'link', expectedKind: 'link' },
    { title: 'Link-sourced image', assetKind: 'image', sourceKind: 'link', expectedKind: 'image' },
  ];
  const assertSaved = async (id: string, assetKind: string, content: Record<string, unknown>) => {
    contentAssetIds.push(id);
    expect((await root.query('SELECT asset_kind FROM content_assets WHERE content_asset_id=$1', [id])).rows)
      .toEqual([{ asset_kind: assetKind }]);
    const detail = await app.inject({ url: `${url}/${id}`, headers });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data).toMatchObject({ contentAssetId: id, assetKind, contentStatus: 'ready', content });
    return detail.json().data;
  };
  try {
    for (const { expectedKind, ...input } of writes) {
      const sourceId = 'https://example.invalid/source';
      const result = await app.inject({ method: 'POST', url, headers: { ...headers, 'x-idempotency-key': randomUUID() },
        payload: { ...input, sourceId, parts: { raw: 'Asset body' } } });
      expect(result.statusCode, result.body).toBe(200);
      await assertSaved(result.json().data.contentAssetId, expectedKind, {
        text: 'Asset body', format: 'markdown', resources: [], ...(expectedKind === 'creative' ? {} : { sourceUrl: sourceId }),
      });
    }
    const unsafeLink = await app.inject({ method: 'POST', url, headers: { ...headers, 'x-idempotency-key': randomUUID() },
      payload: { title: 'Legacy source', assetKind: 'link', sourceId: 'javascript:alert(1)', parts: { raw: 'Already saved' } } });
    expect(unsafeLink.statusCode, unsafeLink.body).toBe(200);
    const unsafeDetail = await assertSaved(unsafeLink.json().data.contentAssetId, 'link', { text: 'Already saved', format: 'markdown' });
    expect(unsafeDetail.content.sourceUrl ?? null).toBeNull();
    const sourceUrl = 'https://example.invalid/original.pdf';
    const result = await app.inject({ method: 'POST', url: '/api/v1/content-asset-imports',
      headers: { ...headers, 'x-idempotency-key': randomUUID() },
      payload: { title: 'Imported document', mimeType: 'text/markdown', content: '# Document', sourceUrl } });
    expect(result.statusCode, result.body).toBe(200);
    const imported = result.json().data;
    await assertSaved(imported.contentAsset.contentAssetId, 'file', { text: '# Document', format: 'markdown', sourceUrl, resources: [] });
    expect(imported).toMatchObject({ status: 'ready', contentAsset: { sourceRef: { kind: 'import', id: sourceUrl } } });
  } finally { await app.close(); }
});

it('keeps content status server-owned and updates it when ordinary writes change the raw body', async () => {
  const f = await fixture(), app = await buildApiServer({ config });
  const url = '/api/v1/content-assets', headers = fixtureScopeHeaders(f.bearer);
  const writeHeaders = () => ({ ...headers, 'x-idempotency-key': randomUUID() });
  const draft = { title: 'Editable asset', parts: { raw: '' } };
  const assertDetailStatus = async (id: string, contentStatus: string) => {
    const detail = await app.inject({ url: `${url}/${id}`, headers });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data).toMatchObject({ contentAssetId: id, contentStatus });
  };
  try {
    const rejected = await app.inject({ method: 'POST', url, headers: writeHeaders(), payload: { ...draft, contentStatus: 'ready' } });
    expect(rejected.statusCode, rejected.body).toBe(400);
    const whitespace = await app.inject({ method: 'POST', url, headers: writeHeaders(),
      payload: { title: 'Whitespace only', parts: { raw: ' \n\t ' } } });
    expect(whitespace.statusCode, whitespace.body).toBe(200);
    const whitespaceId = whitespace.json().data.contentAssetId as string;
    contentAssetIds.push(whitespaceId);
    await assertDetailStatus(whitespaceId, 'draft');

    const createRequest = { method: 'POST' as const, url, headers: writeHeaders(), payload: draft };
    const created = await app.inject(createRequest);
    expect(created.statusCode, created.body).toBe(200);
    const saved = created.json().data as { contentAssetId: string; etag: string };
    const { contentAssetId: id } = saved;
    contentAssetIds.push(id);
    expect(saved).not.toHaveProperty('contentStatus');
    await assertDetailStatus(id, 'draft');

    const editUrl = `${url}/${id}`;
    let etag = saved.etag;
    const editHeaders = () => ({ ...writeHeaders(), 'if-match': etag });
    const rejectedEdit = await app.inject({ method: 'PATCH', url: editUrl, headers: editHeaders(), payload: { contentStatus: 'failed' } });
    expect(rejectedEdit.statusCode, rejectedEdit.body).toBe(400);
    const body = await app.inject({ method: 'PATCH', url: editUrl, headers: editHeaders(), payload: { parts: { raw: '# Text' } } });
    expect(body.statusCode, body.body).toBe(200);
    expect(body.json().data).not.toHaveProperty('contentStatus');
    etag = body.json().data.etag;
    await assertDetailStatus(id, 'ready');
    const replay = await app.inject(createRequest);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().data).toEqual(saved);

    for (const contentStatus of ['processing', 'failed']) {
      await root.query('UPDATE content_assets SET processing_status=$2 WHERE content_asset_id=$1', [id, contentStatus]);
      const renamed = await app.inject({ method: 'PATCH', url: editUrl, headers: editHeaders(), payload: { title: `Renamed ${contentStatus}` } });
      expect(renamed.statusCode, renamed.body).toBe(200);
      etag = renamed.json().data.etag;
      await assertDetailStatus(id, contentStatus);
    }
    const cleared = await app.inject({ method: 'PUT', url: `${editUrl}/parts/raw`, headers: editHeaders(), payload: { contentMarkdown: '' } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    await assertDetailStatus(id, 'draft');
  } finally { await app.close(); }
});

it('serves 20 metadata summaries over HTTP while detail retains the complete latest Markdown', async () => {
  const f = await fixture(), ids = await seed(f, 21);
  const content = '# 标题\n\n**重点** [链接](https://example.invalid/private)\n\n' + '😀'.repeat(3000);
  for (const [revision, body] of [[1, '旧正文不得出现在摘要中'], [2, content]] as const) {
    await root.query(`INSERT INTO content_asset_parts(part_revision_id,content_asset_id,part,revision,content_markdown,content_sha256)
      VALUES($1,$2,'raw',$3,$4,$5) ON CONFLICT(content_asset_id,part) DO UPDATE SET part_revision_id=EXCLUDED.part_revision_id,revision=EXCLUDED.revision,content_markdown=EXCLUDED.content_markdown,content_sha256=EXCLUDED.content_sha256`, [randomUUID(), ids[0], revision, body, createHash('sha256').update(body).digest('hex')]);
  }
  const app = await buildApiServer({ config });
  try {
    const url = `/api/v1/content-assets`, headers = fixtureScopeHeaders(f.bearer);
    const response = await app.inject({ method: 'GET', url, headers });
    expect(response.statusCode, response.body).toBe(200);
    const page = response.json().data;
    expect(page.items).toHaveLength(20);
    for (const item of page.items) {
      expect(item).not.toHaveProperty('parts');
      expect(item).not.toHaveProperty('resourceRefs');
      expect(typeof item.preview).toBe('string');
      expect(Array.from(item.preview).length).toBeLessThanOrEqual(200);
    }
    const preview: string = page.items[0].preview;
    expect(preview).toContain('标题'); expect(preview).toContain('重点'); expect(preview).toContain('链接');
    expect(preview).toContain('😀');
    expect(preview).not.toContain('#'); expect(preview).not.toContain('**');
    expect(preview).not.toContain('https://'); expect(preview).not.toContain('旧正文');
    expect(preview).not.toContain('\uFFFD');
    expect(Array.from(preview)).toHaveLength(200);
    const next = await app.inject({ method: 'GET', url: `${url}?cursor=${encodeURIComponent(page.nextCursor)}`, headers });
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().data.items).toHaveLength(1); expect(next.json().data.nextCursor).toBeNull();
    const detail = await app.inject({ method: 'GET', url: `${url}/${ids[0]}`, headers });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data.parts.raw.contentMarkdown).toBe(content);
  } finally { await app.close(); }
});
