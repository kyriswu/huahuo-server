import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { loadTestConfig } from '../sms-fixture.js';
import { insertFixtureSession, insertFixtureUser, testJwtEnv } from './jwt-fixture.js';
import { transaction } from '../../src/modules/identity/store.js';
import { ContentAssetService } from '../../src/modules/content-assets/service.js';
import { RecordingProcessing, readRecordingProcessing } from '../../src/modules/funasr/recording-processing.js';
import { RecordingOutlineJobs } from '../../src/modules/funasr/recording-outline.js';
import { enqueueRecordingTranscription } from '../../src/modules/funasr/recording-transcription.js';
import { transcriptionQueue } from '../../src/modules/funasr/store.js';
import { BillingService } from '../../src/modules/billing/service.js';
import { TaskEngine } from '../../src/modules/tasks/engine.js';

const migrationUrl = process.env.TEST_DATABASE_MIGRATION_URL;
if (!migrationUrl || !/^huahuo_test_/u.test(new URL(migrationUrl).pathname.slice(1))) throw new Error('ISOLATED_TEST_DB_REQUIRED');
const migrator = loadTestConfig('migrate',{DATABASE_URL:migrationUrl});
const apiConfig = loadTestConfig('api-server',{...process.env,...testJwtEnv,APP_ENV:'test', DATABASE_URL:process.env.TEST_DATABASE_API_URL,
  APP_TOKEN_SECRET:'recording-processing-integration-secret', APP_PUBLIC_BASE_URL:'https://recording.test'});
const workerConfig = loadTestConfig('worker',{...process.env,APP_ENV:'test',DATABASE_URL:process.env.TEST_DATABASE_WORKER_URL});
const root=poolFor(migrator),api=poolFor(apiConfig),worker=poolFor(workerConfig);
beforeAll(async () => { await migrate(migrator); });
afterAll(async () => { await Promise.all([root.end(),api.end(),worker.end()]); });

async function fixture(raw: string) {
  const userId = await insertFixtureUser(root), sessionId=randomUUID(), scope={userId,sessionId,traceId:randomUUID()};
  await insertFixtureSession(root,userId,sessionId);
  const asset = await new ContentAssetService(api,apiConfig.appTokenSecret!).createContentAsset(scope,
    {title:'卡内录音',assetKind:'audio',parts:{raw}},randomUUID());
  // The recorder ingest flow has its own tests. Seed an existing owned recording here.
  await root.query("UPDATE content_assets SET source_kind='recorder_card',source_id=$2 WHERE content_asset_id=$1",[asset.contentAssetId,randomUUID()]);
  const queue = transcriptionQueue(0,new BillingService(api,apiConfig));
  const service = new RecordingProcessing(api,apiConfig.appTokenSecret!,queue);
  const status = () => transaction(api,tx=>readRecordingProcessing(tx,userId,asset.contentAssetId));
  return {scope,asset,service,status};
}

it('reuses an in-flight outline, retries only the outline and publishes its result after logout',async () => {
  const {scope,asset,service,status} = await fixture('可读的转写正文');
  const submit = (action:'start'|'retry') => service.submit(scope,asset.contentAssetId,action,randomUUID());
  const [first,second] = await Promise.all([submit('start'),submit('start')]);
  expect(first.stage).toBe('outlining'); expect(first.taskId).toBe(second.taskId);
  const engine = new TaskEngine(worker);
  const unavailable = (await engine.claim(first.taskId!,randomUUID()))!;
  await expect(engine.execute(unavailable)).rejects.toMatchObject({code:'RECORDING_OUTLINE_PROVIDER_UNAVAILABLE'});
  await engine.fail(unavailable,'RECORDING_OUTLINE_PROVIDER_UNAVAILABLE',false);
  expect(await status()).toMatchObject({stage:'failed',failedStage:'outline',allowedActions:['retry']});
  const retried=await submit('retry');
  await root.query('UPDATE user_sessions SET revoked_at=now() WHERE id=$1',[scope.sessionId]);
  const generate=vi.fn().mockResolvedValue('这是纲要');
  const jobs = new RecordingOutlineJobs(worker,{generate});
  const attempt=(await engine.claim(retried.taskId!,randomUUID()))!;
  const result=await jobs.execute(attempt);
  // Re-delivery after result persistence reuses both the run and its text.
  expect(await jobs.execute(attempt)).toEqual(result);
  expect(generate).toHaveBeenCalledTimes(1);
  await engine.finish(attempt,result.digest,result.bytes);
  expect(await status()).toMatchObject({stage:'completed',outlineRunId:retried.taskId});
  expect((await root.query('SELECT result_text FROM ai_template_runs WHERE id=$1',[retried.taskId])).rows[0].result_text).toBe('这是纲要');
  expect((await root.query('SELECT 1 FROM funasr_jobs WHERE asset_id=$1',[asset.contentAssetId])).rowCount).toBe(0);
});

it('retains the original audio when automatic ASR admission fails and permits a later retry',async () => {
  const {scope,asset,service,status}=await fixture('');
  const audio=randomUUID(), assetId=asset.contentAssetId;
  await root.query(`INSERT INTO resources(resource_id,user_id,file_name,mime_type,size_bytes,object_key,object_version,storage_driver,status)
    VALUES($1,$2,'card.m4a','audio/mp4',10,$3,'1','local','ready')`,[audio,scope.userId,randomUUID()]);
  await root.query("INSERT INTO content_asset_resource_refs(content_asset_id,resource_id,usage,ref_order) VALUES($1,$2,'original',0)",[assetId,audio]);
  const input = {assetId,resourceId:audio,rawRevisionId:asset.parts.raw!.partRevisionId};
  const state=await transaction(api,tx=>enqueueRecordingTranscription(tx,scope,input,undefined));
  expect(state).toBe('failed');
  expect(await status()).toMatchObject({stage:'failed',failedStage:'transcription',errorCode:'RECORDING_TRANSCRIPTION_UNAVAILABLE'});
  const recorded = await status();
  // Simulate a task recovered before its local ASR job was closed.
  await root.query('UPDATE funasr_jobs SET finished_at=NULL WHERE task_id=$1',[recorded!.taskId]);
  const retry=await service.submit(scope,assetId,'retry',randomUUID());
  expect(retry).toMatchObject({stage:'transcribing',allowedActions:[]});
  expect((await root.query('SELECT 1 FROM funasr_jobs WHERE asset_id=$1',[assetId])).rowCount).toBe(2);
  expect((await root.query('SELECT i.body FROM task_inputs i JOIN tasks t ON t.input_id=i.id WHERE t.id=$1',[retry.taskId])).rows[0].body).toBe('{"language":"auto"}');
});

it('recovers a lost outline response under its original remote key and fences an edited source',async () => {
  const {scope,asset,service,status}=await fixture('记录正文');
  const queued=await service.submit(scope,asset.contentAssetId,'start',randomUUID());
  const engine=new TaskEngine(worker);
  let attempt=(await engine.claim(queued.taskId!,randomUUID()))!;
  const firstRemote=vi.fn().mockRejectedValue(new Error('response lost'));
  await expect(new RecordingOutlineJobs(worker,{generate:firstRemote}).execute(attempt)).rejects
    .toMatchObject({code:'RECORDING_OUTLINE_OUTCOME_UNKNOWN'});
  await engine.fail(attempt,'RECORDING_OUTLINE_OUTCOME_UNKNOWN',false);
  expect((await status())?.allowedActions).toEqual(['retry']);
  const retry=await service.submit(scope,asset.contentAssetId,'retry',randomUUID());
  expect(retry.taskId).toBe(queued.taskId);
  await root.query('UPDATE content_assets SET title=$2 WHERE content_asset_id=$1',[asset.contentAssetId,'已改名']);
  const secondRemote=vi.fn().mockImplementation(async () => {
    await root.query(`UPDATE content_asset_parts SET part_revision_id=$2,content_markdown='人工编辑'
      WHERE content_asset_id=$1 AND part='raw'`,[asset.contentAssetId,randomUUID()]);
    return '旧纲要';
  });
  attempt=(await engine.claim(retry.taskId!,randomUUID()))!;
  await expect(new RecordingOutlineJobs(worker,{generate:secondRemote}).execute(attempt)).rejects
    .toMatchObject({code:'AI_TEMPLATE_SOURCE_CHANGED'});
  expect(secondRemote.mock.calls[0]?.slice(0,2)).toEqual(firstRemote.mock.calls[0]?.slice(0,2));
  expect((await root.query('SELECT result_text FROM ai_template_runs WHERE id=$1',[retry.taskId])).rows[0].result_text).toBeNull();
});

it('refuses ASR replay for a locally terminal job with an unresolved provider submission',async () => {
  const {scope,asset,service,status}=await fixture('');
  const input={assetId:asset.contentAssetId,resourceId:randomUUID(),rawRevisionId:asset.parts.raw!.partRevisionId};
  await transaction(api,tx=>enqueueRecordingTranscription(tx,scope,input,undefined));
  const failed=await status();
  await root.query('UPDATE funasr_jobs SET finished_at=NULL,upload_attempts=1 WHERE task_id=$1',[failed!.taskId]);
  expect((await status())?.allowedActions).toEqual([]);
  await expect(service.submit(scope,asset.contentAssetId,'retry',randomUUID())).rejects.toMatchObject({code:'RECORDING_ACTION_NOT_ALLOWED'});
});
