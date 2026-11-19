import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildAdminServer } from '../../src/apps/admin.js';
import { buildApiServer } from '../../src/apps/api-server.js';
import { migrate } from '../../src/db/migrate.js';
import type { AiTemplateCatalog } from '../../src/modules/ai-templates/catalog.js';
import { ContentAssetService } from '../../src/modules/content-assets/service.js';
import { hashPassword } from '../../src/modules/identity/crypto.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { loadTestConfig } from '../sms-fixture.js';
import { fixtureScopeHeaders, insertFixtureSession, insertFixtureUser, testJwtEnv } from './jwt-fixture.js';

type SceneView = Awaited<ReturnType<AiTemplateCatalog['get']>>;
type AgentRequest = { prompt: string; text: string; stream: boolean };

const migrator = loadTestConfig('migrate', { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_MIGRATION_URL });
const root = poolFor(migrator);
const fakeCalls: AgentRequest[] = [];
let hold: Promise<void> | undefined;
let arrived: (() => void) | undefined;
const upstream = createServer(async (request, reply) => {
  if (request.method !== 'POST' || request.url !== '/internal/v1/ai-template-runs'
      || !request.headers['x-huahuo-user-id'] || !request.headers['x-huahuo-session-id']
      || request.headers['x-huahuo-auth-method'] !== 'bearer' || !request.headers['x-trace-id']) {
    reply.writeHead(401).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString()) as AgentRequest;
  fakeCalls.push(input);
  arrived?.();
  await hold;
  const text = '花火生成结果';
  if (!input.stream) {
    reply.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text }));
    return;
  }
  reply.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const first = Buffer.from(JSON.stringify({ type: 'delta', text: '花火' }) + '\n');
  const split = first.indexOf(Buffer.from('花')) + 1;
  reply.write(first.subarray(0, split));
  await new Promise(resolve => setImmediate(resolve));
  reply.write(first.subarray(split));
  const terminal = input.text === '模型失败样例'
    ? { type: 'error', code: 'AI_TEMPLATE_GENERATION_FAILED' } : { type: 'result', text };
  reply.end(JSON.stringify(terminal) + '\n');
});

const adminOrigin = 'http://admin.test';
const fixtureAdminId = randomUUID();
let admin: Awaited<ReturnType<typeof buildAdminServer>>;
let api: Awaited<ReturnType<typeof buildApiServer>>;
let contentAssets: ContentAssetService;
let auth: Record<string, string>;
let fixture: Awaited<ReturnType<typeof workspace>>;

async function workspace() {
  const userId = await insertFixtureUser(root);
  const sessionId = randomUUID(), workspaceId = randomUUID();
  const bearer = await insertFixtureSession(root, userId, sessionId);
  await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'fixture',true,$3)",
    [workspaceId, userId, randomUUID()]);
  return { workspaceId, headers: fixtureScopeHeaders(bearer), scope: { userId, sessionId, traceId: randomUUID() } };
}

beforeAll(async () => {
  await migrate(migrator);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture Agent listener');
  const apiConfig = loadTestConfig('api-server', {
    ...process.env, ...testJwtEnv, LOG_LEVEL: 'silent',
    APP_TOKEN_SECRET: 'ai-template-test-token-secret'.repeat(2), APP_PUBLIC_BASE_URL: 'http://api.test',
    DATABASE_URL: process.env.TEST_DATABASE_API_URL,
    HUAHUO_AGENT_BASE_URL: `http://127.0.0.1:${address.port}`,
  });
  const adminConfig = loadTestConfig('admin', {
    ...process.env, LOG_LEVEL: 'silent', ADMIN_SESSION_SECRET: 'ai-template-test-admin-secret'.repeat(2),
    ADMIN_PUBLIC_BASE_URL: adminOrigin, DATABASE_URL: process.env.TEST_DATABASE_ADMIN_URL,
  });
  api = await buildApiServer({ config: apiConfig });
  admin = await buildAdminServer({ config: adminConfig });
  const assetPool = poolFor(apiConfig);
  api.addHook('onClose', () => assetPool.end());
  contentAssets = new ContentAssetService(assetPool, apiConfig.appTokenSecret!);
  fixture = await workspace();

  const username = 'ai-template-' + randomUUID().slice(0, 8);
  const password = 'fixture-editor-password';
  await root.query("INSERT INTO admin_users(id,username,password_hash,role) VALUES($1,$2,$3,'operator')",
    [fixtureAdminId, username, await hashPassword(password)]);
  const login = await admin.inject({ method: 'POST', url: '/admin/api/v1/login', headers: { origin: adminOrigin }, payload: { username, password } });
  expect(login.statusCode).toBe(200);
  auth = { origin: adminOrigin, cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().data.csrfToken };
}, 20_000);

afterAll(async () => {
  try {
    await Promise.all([admin?.close(), api?.close()]);
    await root.query('DELETE FROM admin_sessions WHERE admin_id=$1', [fixtureAdminId]);
    await root.query('DELETE FROM admin_audit_events WHERE admin_id=$1', [fixtureAdminId]);
    await root.query('DELETE FROM admin_users WHERE id=$1', [fixtureAdminId]);
  } finally {
    await Promise.all([root.end(), new Promise<void>(resolve => upstream.close(() => resolve()))]);
  }
});

const editor = '/api/v1/ai-template-scenes/editor_polish/items';
const adminEditor = '/admin/api/v1/ai-template-scenes/editor_polish';
const runPath = () => `/api/v1/workspaces/${fixture.workspaceId}/ai-template-runs`;
const editorBody = { sceneKey: 'editor_polish', itemKey: 'relation_peer', input: { text: '一段原文' } };
const generate = (payload: object, idempotency = randomUUID() as string, accept?: string) =>
  api.inject({
    method: 'POST', url: runPath(),
    headers: { ...fixture.headers, 'x-idempotency-key': idempotency, ...(accept ? { accept } : {}) }, payload,
  });

describe('AI template configuration against isolated PostgreSQL', () => {
  it('publishes an operator draft atomically and chooses the response format per request', async () => {
    expect((await api.inject(editor)).statusCode).toBe(401);
    expect(api.swagger().paths?.['/api/v1/workspaces/{workspaceId}/ai-template-runs']?.post).toMatchObject({
      description: expect.stringContaining('Accept: text/event-stream'),
      responses: { 200: { content: { 'application/json': expect.any(Object), 'text/event-stream': expect.any(Object) } } },
    });
    const list = await api.inject({ url: editor, headers: fixture.headers });
    expect(list.json().data).toMatchObject({
      displayLimit: 5, totalCount: 5,
      items: [expect.objectContaining({ kind: 'group', itemKey: 'relation_shift', childCount: 5 }),
        ...['deepen_needs', 'strengthen_differentiation', 'improve_opening', 'expand'].map(itemKey => expect.objectContaining({ itemKey }))],
    });
    const groupList = () => api.inject({ url: editor + '?parentKey=relation_shift', headers: fixture.headers });
    expect((await groupList()).json().data.items[0]).toMatchObject({ itemKey: 'relation_peer', title: '平等交流' });
    const invalidRun = await generate({ ...editorBody, itemKey: 'relation_shift' });
    expect(invalidRun.statusCode).toBe(404);

    const view = (await admin.inject({ url: adminEditor, headers: auth })).json().data as SceneView;
    const catalog = structuredClone(view.draft);
    const peer = catalog.items.find(item => item.itemKey === 'relation_peer');
    if (!peer || peer.kind !== 'template') throw new Error('Missing peer template');
    peer.title = '平等沟通';
    peer.prompt = '请按{{templateTitle}}改写。';
    const edit = { draftRevision: view.draftRevision, catalog };
    const csrfFailure = await admin.inject({ method: 'PUT', url: adminEditor + '/draft', headers: { ...auth, 'x-csrf-token': 'invalid' }, payload: edit });
    expect(csrfFailure.statusCode).toBe(403);
    const saved = await admin.inject({ method: 'PUT', url: adminEditor + '/draft', headers: auth, payload: edit });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data).toMatchObject({ hasUnpublishedDraft: true, publishedRevision: view.publishedRevision });
    expect((await groupList()).json().data.items[0].title).toBe('平等交流');
    const publish = (draftRevision: number) => admin.inject({
      method: 'POST', url: adminEditor + '/publish', headers: auth, payload: { draftRevision, catalog },
    });
    const version = saved.json().data.draftRevision;
    const published = await Promise.all([publish(version), publish(version)]);
    expect(published.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const active = published.find(response => response.statusCode === 200)!.json().data as SceneView;
    expect(active.publishedRevision).toBe(view.publishedRevision + 1);
    expect((await groupList()).json().data.items[0]).toMatchObject({ title: '平等沟通' });
    expect((await groupList()).body).not.toContain('请按');

    const jsonKey = randomUUID();
    const json = await generate(editorBody, jsonKey);
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-type']).toContain('application/json');
    expect(json.headers.vary).toBe('Accept');
    expect(json.json().data).toMatchObject({
      state: 'succeeded', templateVersion: active.publishedRevision, result: { text: '花火生成结果' },
    });
    expect(fakeCalls.at(-1)).toEqual({ prompt: '请按平等沟通改写。', text: editorBody.input.text, stream: false });
    const jsonCalls = fakeCalls.length;
    const sseReplay = await generate(editorBody, jsonKey, 'text/event-stream');
    expect(sseReplay.headers['content-type']).toContain('text/event-stream');
    expect(sseReplay.body).toContain('event: result\ndata:');
    expect(sseReplay.body).toContain('"runId":"' + json.json().data.runId + '"');
    expect(sseReplay.body).not.toContain('event: delta');
    expect(fakeCalls).toHaveLength(jsonCalls);

    const streamKey = randomUUID();
    const streamed = await generate(editorBody, streamKey, 'text/event-stream');
    expect(streamed.statusCode).toBe(200);
    expect(streamed.headers['content-type']).toContain('text/event-stream');
    expect(streamed.body).toContain('event: delta\ndata:');
    expect(streamed.body).toContain('"text":"花火"');
    expect(streamed.body).toContain('event: result\ndata:');
    expect(streamed.body).toContain('"text":"花火生成结果"');
    expect(fakeCalls.at(-1)?.stream).toBe(true);
    const streamedCalls = fakeCalls.length;
    const jsonReplay = await generate(editorBody, streamKey, 'text/event-stream;q=0, application/json');
    expect(jsonReplay.headers['content-type']).toContain('application/json');
    expect(streamed.body).toContain('"runId":"' + jsonReplay.json().data.runId + '"');
    expect(fakeCalls).toHaveLength(streamedCalls);

    const failedBody = { ...editorBody, input: { text: '模型失败样例' } };
    const failedKey = randomUUID();
    const failedStream = await generate(failedBody, failedKey, 'text/event-stream, application/json');
    expect(failedStream.body).toContain('event: error\ndata:');
    expect(failedStream.body).not.toContain('event: result');
    const failedAttemptCount = fakeCalls.length;
    const failedReplay = await generate(failedBody, failedKey);
    expect(failedReplay.statusCode).toBe(502);
    expect(failedReplay.json().error.code).toBe('AI_TEMPLATE_GENERATION_FAILED');
    expect(fakeCalls).toHaveLength(failedAttemptCount);

    const restored = await admin.inject({
      method: 'POST', url: adminEditor + '/restore', headers: auth,
      payload: { draftRevision: active.draftRevision, version: view.publishedRevision },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().data.history[0]).toMatchObject({ restoredFrom: view.publishedRevision });
    expect((await groupList()).json().data.items[0].title).toBe('平等交流');
    const audit = await root.query(
      "SELECT action FROM admin_audit_events WHERE target_id='editor_polish' ORDER BY (reason::jsonb->>'draftRevision')::int",
    );
    expect(audit.rows.map(row => row.action)).toEqual(['ai_template.save', 'ai_template.publish', 'ai_template.restore']);
  });

  it('deduplicates generation, scopes results and invalidates outline status when raw content changes', async () => {
    const contentAsset = await contentAssets.createContentAsset(fixture.scope, fixture.workspaceId, {
      title: '会议笔记', parts: { raw: '会议需要确认三项决定。' },
    }, randomUUID());
    const input = { contentAssetId: contentAsset.contentAssetId, sourceRevision: contentAsset.parts.raw!.partRevisionId };
    const payload = { sceneKey: 'content_asset_outline', itemKey: 'work_meeting', input };
    const statePath = `/api/v1/workspaces/${fixture.workspaceId}/content-assets/${contentAsset.contentAssetId}/ai-outline-results`;
    const idempotency = randomUUID();
    const before = fakeCalls.length;
    const started = new Promise<void>(resolve => { arrived = resolve; });
    let finish!: () => void;
    hold = new Promise<void>(resolve => { finish = resolve; });
    const first = generate(payload, idempotency);
    try {
      await started;
      const pending = await generate(payload, idempotency);
      expect(pending.statusCode).toBe(202);
      expect(pending.json().data.state).toBe('running');
      expect(fakeCalls).toHaveLength(before + 1);
      expect((await generate({ ...payload, itemKey: 'smart_outline' }, idempotency)).statusCode).toBe(409);
    } finally {
      arrived = undefined;
      finish();
      hold = undefined;
    }
    const success = (await first).json().data;
    expect(success).toMatchObject({ state: 'succeeded', result: { ...input, outlineMarkdown: '花火生成结果' } });
    expect((await generate(payload, idempotency)).json().data).toEqual(success);
    expect(fakeCalls).toHaveLength(before + 1);
    expect((await api.inject({ url: statePath, headers: fixture.headers })).json().data.items).toEqual([
      expect.objectContaining({ runId: success.runId, itemKey: 'work_meeting' }),
    ]);

    const foreign = await workspace();
    const detailPath = runPath() + '/' + success.runId;
    expect((await api.inject({ url: detailPath, headers: foreign.headers })).statusCode).toBe(404);
    expect((await api.inject({ url: detailPath, headers: fixture.headers })).json().data).toEqual(success);
    const applied = await api.inject({
      method: 'PUT',
      url: `/api/v1/workspaces/${fixture.workspaceId}/content-assets/${contentAsset.contentAssetId}/parts/outline`,
      headers: { ...fixture.headers, 'if-match': contentAsset.etag, 'x-idempotency-key': randomUUID() },
      payload: { contentMarkdown: success.result.outlineMarkdown },
    });
    expect(applied.statusCode).toBe(200);

    await contentAssets.updateContentAsset(fixture.scope, fixture.workspaceId, contentAsset.contentAssetId, { parts: { raw: '原文更新' } }, applied.json().data.etag, randomUUID());
    expect((await api.inject({ url: statePath, headers: fixture.headers })).json().data.items).toEqual([]);
    const stale = await generate(payload);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('AI_TEMPLATE_SOURCE_CHANGED');
  });
});
