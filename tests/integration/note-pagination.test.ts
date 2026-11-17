import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { buildApiServer } from '../../src/apps/api-server.js';
import { migrate } from '../../src/db/migrate.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { AssetService } from '../../src/modules/assets/service.js';
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
  APP_TOKEN_SECRET: 'note-pagination-fixture-'.repeat(3), APP_PUBLIC_BASE_URL: 'http://notes.test',
  REDIS_CACHE_URL: redisUrls[0], REDIS_QUEUE_URL: redisUrls[1],
  REDIS_KEY_PREFIX: 'note_pagination_' + randomUUID().replaceAll('-', ''), METRICS_ENABLED: 'false',
  PROVIDER_MODE: 'disabled', RAG_PROVIDER_MODE: 'disabled', BILLING_MODE: 'disabled',
  PROCESSING_NODES_ENABLED: 'false', PROCESSING_NODES_CLOUD_CONTROL_ENABLED: 'false',
});
const migrationConfig = loadConfig('migrate', { APP_ENV: 'test', DATABASE_URL: migrationUrl });
const root = poolFor(migrationConfig), pool = poolFor(config);
const assets = new AssetService(pool, config.appTokenSecret!);
const userIds: string[] = [], workspaceIds: string[] = [], noteIds: string[] = [];

beforeAll(() => migrate(migrationConfig));
afterAll(async () => {
  try {
    await root.query('DELETE FROM note_parts WHERE note_id=ANY($1::uuid[])', [noteIds]);
    await root.query('DELETE FROM notes WHERE note_id=ANY($1::uuid[])', [noteIds]);
    await root.query('DELETE FROM user_sessions WHERE user_id=ANY($1::uuid[])', [userIds]);
    await root.query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])', [workspaceIds]);
    await root.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [userIds]);
  } finally {
    await Promise.all([pool.end(), root.end()]);
  }
});

async function fixture() {
  const userId = await insertFixtureUser(root), sessionId = randomUUID(), workspaceId = randomUUID();
  userIds.push(userId); workspaceIds.push(workspaceId);
  const bearer = await insertFixtureSession(root, userId, sessionId);
  await root.query("INSERT INTO workspaces(id,user_id,display_name,bootstrap_receipt_id) VALUES($1,$2,'note pagination',$3)", [workspaceId, userId, randomUUID()]);
  return { workspaceId, bearer, scope: { userId, sessionId, traceId: randomUUID() } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function seed(f: Fixture, count: number, spacing: 'seconds' | 'same' | 'microseconds' = 'seconds') {
  const interval = spacing === 'same' ? '0 seconds' : spacing === 'microseconds' ? '1 microsecond' : '1 second';
  const inserted = await root.query<{ note_id: string }>(`INSERT INTO notes(note_id,workspace_id,title,note_revision_id,etag,updated_at)
    SELECT gen_random_uuid(),$1,'note-'||i,gen_random_uuid(),'fixture-'||i,
      '2026-01-01T00:00:00.999999Z'::timestamptz-i*$3::interval
    FROM generate_series(1,$2::int)i RETURNING note_id`, [f.workspaceId, count, interval]);
  noteIds.push(...inserted.rows.map(row => row.note_id));
  return (await root.query<{ note_id: string }>(
    'SELECT note_id FROM notes WHERE workspace_id=$1 ORDER BY updated_at DESC,note_id ASC', [f.workspaceId],
  )).rows.map(row => row.note_id);
}
async function pages(f: Fixture) {
  const result: Array<Awaited<ReturnType<AssetService['listNotes']>>> = [];
  let cursor: string | undefined;
  do {
    const page = await assets.listNotes(f.scope, f.workspaceId, cursor);
    result.push(page);
    // Bound the test if a broken cursor accidentally repeats a page forever.
    expect(result.length).toBeLessThanOrEqual(5);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return result;
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

it('returns 45 active notes as 20, 20 and 5 without duplicates or missing items', async () => {
  const f = await fixture(), expected = await seed(f, 45);
  const result = await pages(f);
  expect(result.map(page => page.items.length)).toEqual([20, 20, 5]);
  expect(result.flatMap(page => page.items.map(item => item.noteId))).toEqual(expected);
  expect(result[0]!.items[0]).toMatchObject({ title: 'note-1', updatedAt: expect.any(String) });
  expect(result[0]!.nextCursor).toEqual(expect.any(String));
  expect(result[1]!.nextCursor).toEqual(expect.any(String));
  expect(result[2]!.nextCursor).toBeNull();
});

it('returns no next cursor for an empty page or exactly 20 notes', async () => {
  const f = await fixture();
  expect(await assets.listNotes(f.scope, f.workspaceId)).toEqual({ items: [], nextCursor: null });
  await seed(f, 20);
  const page = await assets.listNotes(f.scope, f.workspaceId);
  expect(page.items).toHaveLength(20);
  expect(page.nextCursor).toBeNull();
});

it('uses note ID to continue across equal update timestamps', async () => {
  const f = await fixture(), expected = await seed(f, 43, 'same');
  const result = await pages(f);
  expect(result.map(page => page.items.length)).toEqual([20, 20, 3]);
  expect(result.flatMap(page => page.items.map(item => item.noteId))).toEqual(expected);
});

it('preserves PostgreSQL microseconds when the page boundary falls within one millisecond', async () => {
  const f = await fixture(), expected = await seed(f, 42, 'microseconds');
  const result = await pages(f);
  expect(result.map(page => page.items.length)).toEqual([20, 20, 2]);
  expect(result.flatMap(page => page.items.map(item => item.noteId))).toEqual(expected);
});

it('continues after the previous page anchor is deleted', async () => {
  const f = await fixture(), expected = await seed(f, 25);
  const first = await assets.listNotes(f.scope, f.workspaceId);
  await root.query('DELETE FROM notes WHERE note_id=$1', [first.items.at(-1)!.noteId]);
  const second = await assets.listNotes(f.scope, f.workspaceId, first.nextCursor!);
  expect(second.items.map(item => item.noteId)).toEqual(expected.slice(20));
  expect(second.nextCursor).toBeNull();
});

it('rejects malformed and cross-workspace cursors without exposing another user’s notes', async () => {
  const f = await fixture(), other = await fixture();
  await seed(f, 21); const otherIds = await seed(other, 3);
  const first = await assets.listNotes(f.scope, f.workspaceId);
  for (const cursor of [
    '', 'not-a-cursor', encode(null), encode({}),
    encode({ wid: f.workspaceId, updatedAt: 'not-a-date', noteId: randomUUID() }),
    encode({ wid: f.workspaceId, updatedAt: '2026-02-30T00:00:00.000000Z', noteId: randomUUID() }),
    encode({ wid: f.workspaceId, updatedAt: '2026-01-01T00:00:00.000000Z', noteId: 'not-a-uuid' }),
  ]) await expect(assets.listNotes(f.scope, f.workspaceId, cursor)).rejects.toMatchObject({ statusCode: 400, code: 'NOTE_CURSOR_INVALID' });
  await expect(assets.listNotes(other.scope, other.workspaceId, first.nextCursor!)).rejects.toMatchObject({ statusCode: 400, code: 'NOTE_CURSOR_INVALID' });
  await expect(assets.listNotes(other.scope, f.workspaceId)).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
  expect((await assets.listNotes(other.scope, other.workspaceId)).items.map(item => item.noteId)).toEqual(otherIds);
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
      const page = await new AssetService(countedPool, config.appTokenSecret!).listNotes(f.scope, f.workspaceId);
      return { count, page };
    } finally { spy.mockRestore(); }
  };
  const one = await measure(small), twenty = await measure(full);
  expect(one.page.items).toHaveLength(1); expect(twenty.page.items).toHaveLength(20);
  expect(twenty.count).toBe(one.count);
  expect(twenty.count).toBeLessThanOrEqual(8);
});

it('keeps full Markdown in the separate note detail response', async () => {
  const f = await fixture(), ids = await seed(f, 1), content = '完整正文\n'.repeat(2000);
  await root.query(`INSERT INTO note_parts(part_revision_id,note_id,part,revision,content_markdown,content_sha256)
    VALUES($1,$2,'raw',1,$3,$4)`, [randomUUID(), ids[0], content, createHash('sha256').update(content).digest('hex')]);
  const note = await assets.getNote(f.scope, f.workspaceId, ids[0]!);
  expect(note.parts.raw!.contentMarkdown).toBe(content);
});

it('serves 20 metadata summaries over HTTP while detail retains the complete latest Markdown', async () => {
  const f = await fixture(), ids = await seed(f, 21);
  const content = '# 标题\n\n**重点** [链接](https://example.invalid/private)\n\n' + '😀'.repeat(3000);
  for (const [revision, body] of [[1, '旧正文不得出现在摘要中'], [2, content]] as const) {
    await root.query(`INSERT INTO note_parts(part_revision_id,note_id,part,revision,content_markdown,content_sha256)
      VALUES($1,$2,'raw',$3,$4,$5) ON CONFLICT(note_id,part) DO UPDATE SET part_revision_id=EXCLUDED.part_revision_id,revision=EXCLUDED.revision,content_markdown=EXCLUDED.content_markdown,content_sha256=EXCLUDED.content_sha256`, [randomUUID(), ids[0], revision, body, createHash('sha256').update(body).digest('hex')]);
  }
  const app = await buildApiServer({ config });
  try {
    const url = `/api/v1/workspaces/${f.workspaceId}/notes`, headers = fixtureScopeHeaders(f.bearer);
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
