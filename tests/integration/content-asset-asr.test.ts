import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { ContentAssetService, type AudioTranscriptionQueue } from '../../src/modules/content-assets/service.js';
import { transaction } from '../../src/modules/identity/store.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { testJwtEnv, insertFixtureUser, insertFixtureSession } from './jwt-fixture.js';
import { loadTestConfig } from '../sms-fixture.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL;
if (!migrationUrl || !/^huahuo_test_/u.test(new URL(migrationUrl).pathname.slice(1))) throw new Error('ISOLATED_TEST_DB_REQUIRED');
const migrationConfig = loadTestConfig('migrate', { DATABASE_URL: migrationUrl });
const apiConfig = loadTestConfig('api-server', {
  ...process.env, ...testJwtEnv, APP_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_API_URL,
  APP_TOKEN_SECRET: 'asr-content-asset-test-fixture-secret', APP_PUBLIC_BASE_URL: 'https://asr-assets.test',
});
const workerConfig = loadTestConfig('worker', { ...process.env, APP_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_WORKER_URL });
const root = poolFor(migrationConfig), api = poolFor(apiConfig), worker = poolFor(workerConfig);

beforeAll(async () => { await migrate(migrationConfig); });
afterAll(async () => { await Promise.all([root.end(), api.end(), worker.end()]); });

async function fixture() {
  const userId = await insertFixtureUser(root), sessionId = randomUUID();
  await insertFixtureSession(root, userId, sessionId);
  return { userId, sessionId, traceId: randomUUID() };
}

async function resource(userId: string, mimeType = 'audio/mp4') {
  const id = randomUUID();
  await root.query(`INSERT INTO resources(resource_id,user_id,file_name,mime_type,size_bytes,object_key,object_version,storage_driver,status)
    VALUES($1,$2,'sample.m4a',$3,100,$4,'v1','local','ready')`, [id, userId, mimeType, randomUUID()]);
  return id;
}

function services() {
  const enqueue = vi.fn<AudioTranscriptionQueue['enqueue']>().mockResolvedValue(undefined);
  const apiService = new ContentAssetService(api, apiConfig.appTokenSecret!, apiConfig, undefined, undefined, { enqueue });
  const workerService = new ContentAssetService(worker, apiConfig.appTokenSecret!, {
    ...workerConfig, tagExtractorProvider: 'deterministic',
  });
  return { enqueue, apiService, workerService };
}

const original = (resourceId: string) => ({ resourceId, usage: 'original' });
const recording = (resourceId: string) => ({ title: '会议录音', sourceKind: 'recording', parts: { raw: '' }, resourceRefs: [original(resourceId)] });

describe('recording ContentAsset transcription with isolated PostgreSQL', () => {
  it('enqueues once during create and preserves a legitimate transcript and the original attachment', async () => {
    const scope = await fixture(), audio = await resource(scope.userId), idempotencyKey = randomUUID();
    const { apiService, workerService, enqueue } = services();
    const asset = await apiService.createContentAsset(scope, recording(audio), idempotencyKey);
    const replay = await apiService.createContentAsset(scope, recording(audio), idempotencyKey);
    expect((await apiService.getContentAsset(scope, asset.contentAssetId)).contentStatus).toBe('processing');
    expect(replay.contentAssetId).toBe(asset.contentAssetId);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const input = enqueue.mock.calls[0]![2];
    expect(input).toEqual({ assetId: asset.contentAssetId, resourceId: audio, rawRevisionId: asset.parts.raw!.partRevisionId });
    await apiService.updateContentAsset(scope, asset.contentAssetId, { title: '新的会议标题' }, asset.etag, randomUUID());
    expect(await transaction(worker, tx => workerService.isAudioTranscriptionCurrent(tx, scope.userId, input))).toBe(true);
    const owner = { userId: scope.userId, traceId: scope.traceId };
    expect(await transaction(worker, tx => workerService.finishAudioTranscription(tx, owner, { ...input, text: '会议正文。' }))).toBe(true);
    expect(await transaction(worker, tx => workerService.finishAudioTranscription(tx, scope, { ...input, text: '重复回调' }))).toBe(false);
    const ready = await apiService.getContentAsset(scope, asset.contentAssetId);
    expect(ready).toMatchObject({
      title: '新的会议标题', contentStatus: 'ready', resourceRefs: [original(audio)],
      parts: { raw: { contentMarkdown: '会议正文。' } },
    });
    expect(ready.parts.raw!.partRevisionId).not.toBe(input.rawRevisionId);
    expect((await root.query("SELECT content_asset_revision_id FROM content_jobs WHERE content_asset_id=$1 AND operation='tag_extract'", [asset.contentAssetId])).rows).toEqual([
      { content_asset_revision_id: ready.contentAssetRevisionId },
    ]);
  });

  it('leaves disabled, already authored, ambiguous and non-audio attachments alone', async () => {
    const scope = await fixture();
    const [audio, second, other] = await Promise.all([
      resource(scope.userId), resource(scope.userId), resource(scope.userId, 'application/pdf'),
    ]);
    const { apiService, enqueue } = services();
    const disabled = new ContentAssetService(api, apiConfig.appTokenSecret!, apiConfig);
    const status = async (service: ContentAssetService, input: Parameters<ContentAssetService['createContentAsset']>[1]) => {
      const created = await service.createContentAsset(scope, input, randomUUID());
      return (await service.getContentAsset(scope, created.contentAssetId)).contentStatus;
    };
    expect(await status(disabled, recording(audio))).toBe('draft');
    expect(await status(apiService, { ...recording(audio), parts: { raw: '已有正文' } })).toBe('ready');
    expect(await status(apiService, recording(other))).toBe('draft');
    expect(await status(apiService, { ...recording(audio), resourceRefs: [original(audio), original(second)] })).toBe('draft');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rolls back asset creation if its task cannot be recorded', async () => {
    const scope = await fixture(), audio = await resource(scope.userId);
    const { apiService, enqueue } = services();
    enqueue.mockRejectedValueOnce(new Error('TRANSCRIPTION_QUEUE_UNAVAILABLE'));
    await expect(apiService.createContentAsset(scope, recording(audio), randomUUID())).rejects.toThrow('TRANSCRIPTION_QUEUE_UNAVAILABLE');
    expect((await root.query('SELECT count(*)::int AS count FROM content_assets WHERE user_id=$1', [scope.userId])).rows[0]).toEqual({ count: 0 });
    expect((await root.query('SELECT reference_count FROM resources WHERE resource_id=$1', [audio])).rows[0]).toEqual({ reference_count: '0' });
  });

  it('fences manual raw saves, changed originals and restored assets, and exposes terminal failure', async () => {
    const scope = await fixture(), audio = await resource(scope.userId), replacement = await resource(scope.userId);
    const { apiService, workerService, enqueue } = services();
    const create = () => apiService.createContentAsset(scope, recording(audio), randomUUID());
    const finish = (text: string | null) => {
      const input = enqueue.mock.calls.at(-1)![2];
      return transaction(worker, tx => workerService.finishAudioTranscription(tx, scope, { ...input, text }));
    };

    const edited = await create();
    await apiService.updateContentAsset(scope, edited.contentAssetId, { parts: { raw: '' } }, edited.etag, randomUUID());
    expect(await finish('迟到的转写')).toBe(false);
    expect((await apiService.getContentAsset(scope, edited.contentAssetId)).contentStatus).toBe('draft');

    const changed = await create();
    await apiService.updateContentAsset(scope, changed.contentAssetId, { resourceRefs: [original(replacement)] }, changed.etag, randomUUID());
    expect(await finish('旧文件的转写')).toBe(false);
    expect((await apiService.getContentAsset(scope, changed.contentAssetId)).contentStatus).toBe('draft');

    const restored = await create();
    await apiService.deleteContentAsset(scope, restored.contentAssetId, restored.etag, randomUUID());
    const { etag } = await apiService.getContentAsset(scope, restored.contentAssetId);
    await apiService.deleteContentAsset(scope, restored.contentAssetId, etag, randomUUID(), true);
    expect(await finish('删除前的转写')).toBe(false);

    const failed = await create();
    expect(await finish(null)).toBe(true);
    expect(await apiService.getContentAsset(scope, failed.contentAssetId)).toMatchObject({
      contentStatus: 'failed', resourceRefs: [original(audio)], parts: { raw: { contentMarkdown: '' } },
    });
  });
});
