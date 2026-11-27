import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApiServer } from '../../src/apps/api-server.js';
import { createTaskWorkers } from '../../src/apps/worker.js';
import { migrate } from '../../src/db/migrate.js';
import { storageFor } from '../../src/modules/storage/port.js';
import { funAsrTaskKind } from '../../src/modules/tasks/model.js';
import { QueuePublisher } from '../../src/modules/tasks/publisher.js';
import { TaskScheduler } from '../../src/modules/tasks/scheduler.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { loadTestConfig } from '../sms-fixture.js';
import { fixtureScopeHeaders, insertFixtureSession, insertFixtureUser, testJwtEnv } from './jwt-fixture.js';

const db = process.env.TEST_DATABASE_MIGRATION_URL;
const redis = process.env.REDIS_QUEUE_URL;
if (!db || new URL(db).hostname !== '127.0.0.1' || !/^\/huahuo_test_[a-z0-9_]+$/u.test(new URL(db).pathname)
  || !redis || new URL(redis).hostname !== '127.0.0.1' || Number(new URL(redis).pathname.slice(1)) < 10) {
  throw new Error('ISOLATED_TEST_DB_AND_REDIS_REQUIRED');
}
const migrateConfig = loadTestConfig('migrate', { DATABASE_URL: db });
const root = poolFor(migrateConfig);
const apiToken = 'funasr-workflow-api-token';
const secret = 'funasr-workflow-test-fixture-secret-only';
const audio = Buffer.from('isolated ASR workflow audio fixture');
const firstSegment = '这是回调转写的测试。';
const secondSegment = '这是另一位说话人的内容。';
const cleanup: Array<() => Promise<unknown>> = [];

beforeAll(async () => migrate(migrateConfig), 20_000);
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
afterAll(async () => root.end());

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}

async function raw(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

async function fakeFunAsr(early: boolean, longRecording: boolean) {
  const taskId = 'task_' + randomUUID().replaceAll('-', '');
  const eventId = 'evt_' + randomUUID().replaceAll('-', '');
  const segments = longRecording ? Array.from({ length: 6000 }, (_, index) => ({
    start_ms: index * 3000, end_ms: (index + 1) * 3000,
    speaker_id: `speaker_${index % 2}`, text: `第 ${index + 1} 段原文。`,
  })) : [
    { start_ms: 0, end_ms: 2000, speaker_id: 'speaker_0', text: firstSegment },
    { start_ms: 2100, end_ms: 4523, speaker_id: 'speaker_1', text: secondSegment },
  ];
  const originalText = segments.map(segment => segment.text).join('');
  const result = Buffer.from(JSON.stringify({
    task_id: taskId, event_id: eventId, status: 'succeeded', event: 'task.succeeded', error: null,
    result: {
      text: originalText, language: 'zh', duration_seconds: segments.at(-1)!.end_ms / 1000, processing_seconds: 0.83,
      segments, timestamps_ms: [], speakers: longRecording ? [
        { speaker_id: 'speaker_1', identity: { source: 'milvus', person_id: 'person_123', display_name: '陈先生' } },
      ] : [],
    },
  }, null, 2) + '\n');
  const calls = {
    submitted: 0, resultRequests: [] as number[], acked: [] as unknown[], invalidCallback: 0, callback: 0,
    acceptanceAt: 0, callbackAt: 0,
  };
  let callbackUrl: string | undefined;
  let failure: unknown;
  async function deliver(valid = true) {
    if (!callbackUrl) throw new Error('FUNASR_CALLBACK_URL_REQUIRED');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret).update(`${timestamp}.${eventId}.`, 'ascii').update(result).digest('hex');
    const reply = await fetch(callbackUrl, {
      method: 'POST', body: new Uint8Array(result), redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-FunASR-Event-Id': eventId, 'X-FunASR-Timestamp': timestamp, 'X-FunASR-Signature': 'v1=' + (valid ? signature : '0'.repeat(64)),
      },
    });
    await reply.arrayBuffer();
    return reply.status;
  }
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === 'GET' && request.url === '/readyz') return json(response, 200, { status: 'ready', device: 'cuda:0' });
    expect(request.headers.authorization).toBe('Bearer ' + apiToken);
    if (request.method === 'POST' && request.url === '/v1/tasks') {
      calls.submitted++;
      expect(request.headers['idempotency-key']).toEqual(expect.any(String));
      const multipart = await new Response(new Uint8Array(await raw(request)),
        { headers: { 'Content-Type': String(request.headers['content-type']) } }).formData();
      const upload = multipart.get('file') as File;
      expect(upload.type).toBe('audio/wav');
      expect(Buffer.from(await upload.arrayBuffer())).toEqual(audio);
      callbackUrl = String(multipart.get('callback_url'));
      expect(new URL(callbackUrl).pathname).toMatch(/^\/internal\/v1\/funasr\/callbacks\/[a-f0-9-]+$/u);
      if (early) {
        calls.invalidCallback = await deliver(false);
        calls.callback = await deliver();
        calls.callbackAt = Date.now();
      }
      calls.acceptanceAt = Date.now();
      return json(response, 202, { task_id: taskId, status: early ? 'succeeded' : 'queued' });
    }
    if (request.method === 'GET' && request.url === `/v1/tasks/${taskId}/result`) {
      calls.resultRequests.push(Date.now());
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(result);
      return;
    }
    if (request.method === 'POST' && request.url === `/v1/tasks/${taskId}/ack`) {
      calls.acked.push(JSON.parse((await raw(request)).toString('utf8')));
      return json(response, 200, { task_id: taskId, event_id: eventId, acknowledged: true, consumed_by: 'ack' });
    }
    throw new Error('UNEXPECTED_FUNASR_REQUEST:' + request.method + ':' + request.url);
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      failure = error;
      json(response, 500, { detail: 'fixture assertion failed' });
    });
  });
  const base = await new Promise<string>((resolve, reject) => {
    server.once('error', reject).listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('LOOPBACK_REQUIRED'));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return { base, calls, deliver, eventId, originalText, verify: () => { if (failure) throw failure; } };
}

async function workflow(early: boolean, longRecording = false) {
  const funasr = await fakeFunAsr(early, longRecording);
  const storageRoot = await mkdtemp(join(tmpdir(), 'huahuo-funasr-workflow-'));
  cleanup.push(() => rm(storageRoot, { recursive: true, force: true }));
  const env = {
    ...testJwtEnv, APP_ENV: 'test', LOG_LEVEL: 'silent', REDIS_KEY_PREFIX: 'funasr-workflow-' + randomUUID(),
    REDIS_QUEUE_URL: redis, REDIS_CACHE_URL: process.env.REDIS_CACHE_URL,
    APP_TOKEN_SECRET: 'funasr-workflow-test-app-token-secret',
    APP_PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
    STORAGE_DRIVER: 'local', STORAGE_LOCAL_ROOT: storageRoot,
    PROCESSING_NODES_CLOUD_CONTROL_ENABLED: 'false', WORKER_QUEUES: 'content',
    FUNASR_COMPUTE_PROVIDER: 'fixed', FUNASR_COMPUTE_FIXED_BASE_URL: funasr.base,
    FUNASR_CALLBACK_WAIT_MS: '1000', FUNASR_UPLOAD_TIMEOUT_MS: '5000', FUNASR_IDLE_MS: '1000',
  };
  const apiConfig = loadTestConfig('api-server', {
    ...env, DATABASE_URL: process.env.TEST_DATABASE_API_URL, FUNASR_CALLBACK_SECRET: secret,
  });
  const api = await buildApiServer({ config: apiConfig });
  cleanup.push(() => api.close());
  const callbackOrigin = await api.listen({ port: 0, host: '127.0.0.1' });
  const workerConfig = loadTestConfig('worker', {
    ...env, DATABASE_URL: process.env.TEST_DATABASE_WORKER_URL,
    FUNASR_API_TOKEN: apiToken, FUNASR_COMPUTE_CALLBACK_ORIGIN: callbackOrigin,
  });
  const schedulerConfig = loadTestConfig('scheduler', { ...env, DATABASE_URL: process.env.TEST_DATABASE_SCHEDULER_URL });
  const workerPool = poolFor(workerConfig), schedulerPool = poolFor(schedulerConfig);
  cleanup.push(() => Promise.all([workerPool.end(), schedulerPool.end()]));
  const publisher = new QueuePublisher(schedulerConfig);
  cleanup.push(() => publisher.close());
  const scheduler = new TaskScheduler(schedulerPool, publisher);
  let workers = createTaskWorkers(workerPool, workerConfig);
  cleanup.push(() => workers.close());
  await vi.waitFor(() => expect(workers.healthy()).toBe(true), { timeout: 5000 });

  const userId = await insertFixtureUser(root);
  const bearer = await insertFixtureSession(root, userId);
  const headers = fixtureScopeHeaders(bearer);
  const resourceId = randomUUID(), objectKey = randomUUID();
  const stored = await storageFor(apiConfig).put(objectKey, Readable.from([audio]), 'audio/wav', audio.length);
  await root.query(`INSERT INTO resources(resource_id,user_id,file_name,mime_type,size_bytes,object_key,object_version,storage_driver,status)
    VALUES($1,$2,'sample.wav','audio/wav',$3,$4,$5,'local','ready')`, [resourceId, userId, audio.length, objectKey, stored.version]);
  const created = await api.inject({
    method: 'POST', url: '/api/v1/content-assets', headers: { ...headers, 'idempotency-key': randomUUID() },
    payload: { title: '测试录音', sourceKind: 'recording', assetKind: 'audio', parts: { raw: '' }, resourceRefs: [{ resourceId, usage: 'original' }] },
  });
  expect(created.statusCode, created.body).toBe(200);
  const { contentAssetId } = created.json<{ data: { contentAssetId: string } }>().data;
  const assetPath = `/api/v1/content-assets/${contentAssetId}`;
  const processing = await api.inject({ method: 'GET', url: assetPath, headers });
  expect(processing.statusCode, processing.body).toBe(200);
  expect(processing.json().data).toMatchObject({ assetKind: 'audio', contentStatus: 'processing', content: null });
  const tasks = await root.query<{ id: string }>('SELECT id FROM tasks WHERE user_id=$1 AND kind=$2', [userId, funAsrTaskKind]);
  expect(tasks.rows).toHaveLength(1);
  const taskId = tasks.rows[0]!.id;

  async function dispatchIfDue() {
    // Prioritize this fixture's intent so no other integration file's tasks are dispatched.
    const due = await root.query(`UPDATE task_outbox SET created_at='1900-01-01'
      WHERE task_id=$1 AND status='pending' AND available_at<=now() RETURNING id`, [taskId]);
    if (!due.rowCount) return false;
    const delivery = await scheduler.claim();
    expect(delivery?.task_id).toBe(taskId);
    await publisher.publish(delivery!);
    await scheduler.acknowledge(delivery!);
    return true;
  }
  async function state() {
    return (await root.query<{ state: string }>('SELECT state FROM tasks WHERE id=$1', [taskId])).rows[0]?.state;
  }
  async function finish() {
    await vi.waitFor(async () => {
      funasr.verify();
      await dispatchIfDue();
      expect(await state()).toBe('succeeded');
    }, { timeout: 6000, interval: 50 });
    const detail = await api.inject({ method: 'GET', url: assetPath, headers });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data).toMatchObject({
      assetKind: 'audio', contentStatus: 'ready', parts: { raw: { contentMarkdown: funasr.originalText } }, resourceRefs: [{ resourceId, usage: 'original' }],
      content: {
        text: expect.any(String), format: 'text', resources: [{ resourceId, mimeType: 'audio/wav', usage: 'original' }],
        transcription: { transcriptionId: taskId, contentRevision: expect.any(String), durationMs: expect.any(Number), language: 'zh' },
      },
    });
    expect((await root.query('SELECT id FROM task_results WHERE task_id=$1', [taskId])).rows).toHaveLength(1);
    return detail.json().data.parts.raw.partRevisionId as string;
  }
  async function restartWorker() {
    await workers.close();
    workers = createTaskWorkers(workerPool, workerConfig);
    await vi.waitFor(() => expect(workers.healthy()).toBe(true), { timeout: 5000 });
  }
  async function waitForIdleRelease() {
    await vi.waitFor(async () => {
      const allocation = await root.query<{ provider: string; state: string }>(`SELECT a.provider,a.state
        FROM funasr_jobs j JOIN funasr_allocations a ON a.id=j.allocation_id WHERE j.task_id=$1`, [taskId]);
      expect(allocation.rows).toEqual([{ provider: 'fixed', state: 'released' }]);
    }, { timeout: 6000 });
  }
  return { api, headers, assetPath, contentAssetId, resourceId, taskId, funasr, state, finish, dispatchIfDue, restartWorker, waitForIdleRelease };
}

describe('callback-first FunASR with isolated PostgreSQL, Redis and a loopback provider', () => {
  it('queues one recorder outline for the newly transcribed raw revision when the callback is replayed', async () => {
    const scenario = await workflow(true);
    // Seed the post-archive source before dispatch; this fixture uses local storage
    // so it can run the real ASR worker without a recording card or a cloud bucket.
    const sourceId = [randomUUID(),'sample.wav'].map(value => Buffer.from(value).toString('base64url')).join('.');
    const {rows: [asset]} = await root.query<{user_id: string}>(`UPDATE content_assets
      SET source_kind='recorder_card',source_id=$2 WHERE content_asset_id=$1 RETURNING user_id`, [scenario.contentAssetId,sourceId]);
    const {rows: [before]} = await root.query<{part_revision_id: string}>(
      "SELECT part_revision_id FROM content_asset_parts WHERE content_asset_id=$1 AND part='raw'",[scenario.contentAssetId]);
    const outlines = async () => (await root.query<{id: string; external_reference: string; intents: number}>(`
      SELECT t.id,t.external_reference,count(o.id)::int AS intents FROM tasks t
      LEFT JOIN task_outbox o ON o.task_id=t.id WHERE t.kind='content-asset.recording-outline' AND t.user_id=$1
      GROUP BY t.id`, [asset!.user_id])).rows;

    expect(await outlines()).toEqual([]);
    const writtenRevision = await scenario.finish();
    expect(scenario.funasr.calls.callback).toBe(204);
    expect(writtenRevision).not.toBe(before!.part_revision_id);
    const queued = await outlines();
    expect(queued).toEqual([{id:expect.any(String),external_reference:`recording-outline:${scenario.contentAssetId}:${writtenRevision}`,intents:1}]);
    expect(await scenario.funasr.deliver()).toBe(204);
    expect(await outlines()).toEqual(queued);
  }, 20_000);

  it('stores an authenticated callback delivered before 202, rejects a bad signature and applies duplicates once', async () => {
    const scenario = await workflow(true);
    const revision = await scenario.finish();
    const { calls } = scenario.funasr;
    expect(calls.invalidCallback).toBe(401);
    expect(calls.callback).toBeGreaterThanOrEqual(200);
    expect(calls.callback).toBeLessThan(300);
    expect(calls.callbackAt).toBeLessThanOrEqual(calls.acceptanceAt);
    expect(calls.submitted).toBe(1);
    expect(calls.resultRequests).toEqual([]);
    expect(calls.acked).toEqual([]);
    const duplicate = await scenario.funasr.deliver();
    expect(duplicate).toBeGreaterThanOrEqual(200);
    expect(duplicate).toBeLessThan(300);
    expect(await scenario.finish()).toBe(revision);
    await scenario.waitForIdleRelease();
  }, 20_000);

  it('waits without a result query and falls back to one GET and ACK after a worker restart', async () => {
    const scenario = await workflow(false);
    expect(await scenario.dispatchIfDue()).toBe(true);
    await vi.waitFor(async () => {
      scenario.funasr.verify();
      await scenario.dispatchIfDue();
      expect(scenario.funasr.calls.acceptanceAt).toBeGreaterThan(0);
      expect(await scenario.state()).toBe('waiting_external');
    }, { timeout: 3000 });
    expect(await scenario.dispatchIfDue()).toBe(false);
    expect(scenario.funasr.calls.resultRequests).toEqual([]);
    await scenario.restartWorker();
    await scenario.finish();
    await vi.waitFor(() => expect(scenario.funasr.calls.acked).toEqual([{ event_id: scenario.funasr.eventId }]), { timeout: 5000 });
    const { calls } = scenario.funasr;
    expect(calls.submitted).toBe(1);
    expect(calls.resultRequests).toHaveLength(1);
    expect(calls.resultRequests[0]! - calls.acceptanceAt).toBeGreaterThanOrEqual(990);
    await scenario.waitForIdleRelease();
  }, 20_000);

  it('returns the saved full text without segments and edits the targeted segment', async () => {
    const scenario = await workflow(true);
    const originalRevision = await scenario.finish();
    const { api, headers, assetPath, contentAssetId, resourceId, taskId } = scenario;
    const transcriptionPath = `${assetPath}/transcription`;
    const result = await api.inject({ method: 'GET', url: transcriptionPath, headers });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual({
      success: true, traceId: expect.any(String),
      data: {
        contentAssetId, title: '测试录音', sourceKind: 'recording',
        createdAt: expect.any(String), contentStatus: 'ready', transcriptionId: taskId,
        resourceId, durationMs: 4523, language: 'zh', contentRevision: '0', text: scenario.funasr.originalText,
      },
    });
    const segmentId = `${taskId}:0`;
    const patchUrl = `${transcriptionPath}/segments/${segmentId}`;
    const edit = { text: '这是用户修改后的内容。', revision: 0 };
    const patchHeaders = { ...headers, 'idempotency-key': randomUUID() };
    const saved = await api.inject({ method: 'PATCH', url: patchUrl, headers: patchHeaders, payload: edit });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ success: true, data: { segmentId, text: edit.text, revision: 1 } });
    const replay = await api.inject({ method: 'PATCH', url: patchUrl, headers: patchHeaders, payload: edit });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().data).toEqual(saved.json().data);

    const stale = await api.inject({
      method: 'PATCH', url: patchUrl, headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { text: '过时的修改', revision: 0 },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe('TRANSCRIPT_SEGMENT_REVISION_CONFLICT');

    const updated = await api.inject({ method: 'GET', url: transcriptionPath, headers });
    expect(updated.statusCode, updated.body).toBe(200);
    const editedText = `${edit.text}\n\n${secondSegment}`;
    expect(updated.json().data).toEqual({ ...result.json().data, contentRevision: '1', text: editedText });
    const savedSegments = (await root.query(`SELECT transcript->'segments' AS segments
      FROM content_asset_audio_transcripts WHERE transcription_id=$1`, [taskId])).rows[0]?.segments;
    expect(savedSegments).toEqual([
      { startMs: 0, endMs: 2000, speakerId: 'speaker_0', originalText: firstSegment, text: edit.text, revision: 1 },
      { startMs: 2100, endMs: 4523, speakerId: 'speaker_1', text: secondSegment },
    ]);
    expect(await scenario.finish()).toBe(originalRevision);
    const fullText = await api.inject({ method: 'GET', url: `${transcriptionPath}/text`, headers });
    expect(fullText.statusCode, fullText.body).toBe(200);
    expect(fullText.json().data).toEqual({ transcriptionId: taskId, contentRevision: '1', text: editedText });
    const assetDetail = await api.inject({ method: 'GET', url: assetPath, headers });
    expect(assetDetail.statusCode, assetDetail.body).toBe(200);
    expect(assetDetail.json().data).toMatchObject({
      contentStatus: 'ready', parts: { raw: { contentMarkdown: scenario.funasr.originalText } },
      content: { text: editedText, format: 'text', transcription: { transcriptionId: taskId, contentRevision: '1', durationMs: 4523, language: 'zh' } },
    });

    const otherUserId = await insertFixtureUser(root);
    const otherHeaders = fixtureScopeHeaders(await insertFixtureSession(root, otherUserId));
    expect((await api.inject({ method: 'GET', url: transcriptionPath, headers: otherHeaders })).statusCode).toBe(404);
    expect((await api.inject({
      method: 'PATCH', url: patchUrl, headers: { ...otherHeaders, 'idempotency-key': randomUUID() },
      payload: { text: '非所有者修改', revision: 1 },
    })).statusCode).toBe(404);
  }, 20_000);

  it('updates the audio asset JSON for the last of 6000 segments and keeps the original result', async () => {
    const { api, headers, assetPath, contentAssetId, resourceId, taskId, finish, funasr } = await workflow(true, true);
    await finish();
    const original = async () => (await root.query(`SELECT xmin::text,segment_count,md5(transcript::text) AS digest
      FROM funasr_jobs WHERE task_id=$1`, [taskId])).rows[0];
    const before = await original();
    expect(before.segment_count).toBe(6000);
    const path = `${assetPath}/transcription`;
    const read = () => api.inject({ method: 'GET', url: path, headers });
    const result = await read();
    expect(result.statusCode).toBe(200);
    const { data } = result.json();
    expect(data).not.toHaveProperty('segments');
    expect(data).not.toHaveProperty('speakers');
    expect(data).toMatchObject({
      durationMs: 18_000_000, contentRevision: '0', text: funasr.originalText,
    });
    const segmentId = `${taskId}:5999`;
    const save = await api.inject({
      method: 'PATCH', url: `${path}/segments/${segmentId}`, headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { text: '第 6000 段，已校对。', revision: 0 },
    });
    expect(save.statusCode, save.body).toBe(200);
    expect(await original()).toEqual(before);
    const edits = await root.query('SELECT segment_index,revision FROM funasr_transcript_edits WHERE task_id=$1', [taskId]);
    expect(edits.rows).toEqual([]);
    const current = (await root.query(`SELECT transcription_id,resource_id,content_revision,
      transcript->>'text' AS text, transcript->'segments'->5999 AS segment,
      jsonb_array_length(transcript->'segments') AS segment_count, transcript->'speakers' AS speakers
      FROM content_asset_audio_transcripts WHERE content_asset_id=$1`, [contentAssetId])).rows[0];
    expect(current).toMatchObject({
      transcription_id: taskId, resource_id: resourceId, content_revision: '1', segment_count: 6000,
      segment: {
        startMs: 17_997_000, endMs: 18_000_000, speakerId: 'speaker_1',
        originalText: '第 6000 段原文。', text: '第 6000 段，已校对。', revision: 1,
      },
      speakers: expect.arrayContaining([{ speakerId: 'speaker_1', personId: 'person_123', displayName: '陈先生' }]),
    });
    const updated = (await read()).json().data;
    expect(updated.contentRevision).toBe('1');
    expect(updated.text).toBe(current?.text);
    expect(updated.text).toMatch(/第 6000 段，已校对。$/u);
    expect(updated).not.toHaveProperty('segments');
    expect(updated).not.toHaveProperty('speakers');
  }, 20_000);

  it('reads legacy original text, materializes historical edits and preserves simultaneous edits', async () => {
    const { api, headers, assetPath, contentAssetId, taskId, finish, funasr } = await workflow(true);
    await finish();
    await root.query('DELETE FROM content_asset_audio_transcripts WHERE content_asset_id=$1', [contentAssetId]);
    const path = `${assetPath}/transcription`;
    const original = await api.inject({ method: 'GET', url: path, headers });
    expect(original.statusCode, original.body).toBe(200);
    expect(original.json().data).toMatchObject({ transcriptionId: taskId, contentRevision: '0', text: funasr.originalText });
    expect((await root.query('SELECT 1 FROM content_asset_audio_transcripts WHERE content_asset_id=$1', [contentAssetId])).rows).toEqual([]);

    await root.query(`INSERT INTO funasr_transcript_edits(task_id,segment_index,text,revision)
      VALUES($1,0,$2,2)`, [taskId, '历史校对文本。']);
    const backfill = await readFile(new URL('../../migrations/0005_materialize_legacy_audio_transcript_edits.sql', import.meta.url), 'utf8');
    await root.query(backfill);
    const before = await api.inject({ method: 'GET', url: path, headers });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().data).toMatchObject({
      transcriptionId: taskId, contentRevision: '2', text: `历史校对文本。\n\n${secondSegment}`,
    });
    expect(before.json().data).not.toHaveProperty('segments');

    const save = (index: number, text: string, revision: number) => api.inject({
      method: 'PATCH', url: `${path}/segments/${taskId}:${index}`, headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { text, revision },
    });
    const [first, second] = await Promise.all([save(0, '再次校对。', 2), save(1, '第二段已校对。', 0)]);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);

    const after = await api.inject({ method: 'GET', url: path, headers });
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().data).toMatchObject({
      transcriptionId: taskId, contentRevision: '4', text: '再次校对。\n\n第二段已校对。',
    });
    await root.query(backfill);
    const saved = (await root.query(`SELECT content_revision, transcript->'segments' AS segments
      FROM content_asset_audio_transcripts WHERE transcription_id=$1`, [taskId])).rows[0];
    expect(saved).toMatchObject({
      content_revision: '4', segments: [
        { originalText: firstSegment, text: '再次校对。', revision: 3 },
        { originalText: secondSegment, text: '第二段已校对。', revision: 1 },
      ],
    });
  }, 20_000);
});
