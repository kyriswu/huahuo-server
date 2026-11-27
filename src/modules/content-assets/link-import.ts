import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { identifyPlatform, linkFailureMessage, LinkExtractor, LinkError } from '../../lib/link-extraction/index.js';
import { idempotent } from '../../lib/idempotency.js';
import { resolveTraceId } from '../../lib/trace.js';
import { assertScope, DomainError, transaction, type Scope } from '../identity/store.js';
import { enqueueIntent, event, hash, linkExtractionKind, newTaskMaxAttempts, type TaskState } from '../tasks/model.js';
import type { TaskEngine, Attempt } from '../tasks/engine.js';
import type { StorageService } from '../storage/service.js';
import { contentAssetPartImageView } from './content-asset-image-view.js';
import type { ContentAssetService } from './service.js';

export async function submitLink(assets: ContentAssetService, scope: Scope, key: string, url: string) {
  identifyPlatform(url, assets.config?.huahuoShareHost);
  return transaction(assets.pool, async tx => {
    await assertScope(tx,scope);
    const receipt = await idempotent(tx, assets.secret, scope.userId, 'content-asset.link-extraction', key, {url}, async () => {
      const taskId = randomUUID();
      const inputId = randomUUID();
      await tx.query('INSERT INTO task_inputs(id,user_id,body) VALUES ($1,$2,$3)',
        [inputId,scope.userId,scope.sessionId+'\n'+url]);
      await tx.query(`INSERT INTO tasks(id,user_id,kind,queue,state,trace_id,max_attempts,input_id)
        VALUES ($1,$2,$3,'content','queued',$4,$5,$6)`,
        [taskId,scope.userId,linkExtractionKind,resolveTraceId(scope.traceId),newTaskMaxAttempts(),inputId]);
      await enqueueIntent(tx,taskId);
      await event(tx,taskId);
      return {taskId};
    });
    // Old synchronous receipts have no task ID. Never repeat an already committed import.
    if (!receipt.taskId) throw new DomainError(409,'LINK_LEGACY_RECEIPT');
    return receipt;
  });
}

export async function readLinkTask(pool: pg.Pool, storage: StorageService, scope: Scope, taskId: string) {
  const data = await transaction(pool, async tx => {
    await assertScope(tx,scope);
    const {rows:[row]} = await tx.query<{
      state: TaskState; error_code: string | null; retryable: boolean;
      asset_id: string | null; title: string; markdown: string; platform: string; content_type: string;
    }>(`SELECT t.state,t.error_code,t.retryable,a.content_asset_id AS asset_id,a.title,
        coalesce(p.content_markdown,'') AS markdown,j.source_platform AS platform,j.source_content_type AS content_type
      FROM tasks t LEFT JOIN content_jobs j ON j.task_id=t.id AND j.operation='import'
      LEFT JOIN content_assets a ON a.content_asset_id=j.content_asset_id AND a.user_id=t.user_id AND a.state='active'
      LEFT JOIN content_asset_parts p ON p.content_asset_id=a.content_asset_id AND p.part='raw'
      WHERE t.id=$1 AND t.user_id=$2 AND t.workspace_id IS NULL AND t.kind=$3`, [taskId,scope.userId,linkExtractionKind]);
    if (!row) throw new DomainError(404,'TASK_NOT_FOUND');
    const status = {taskId,state:row.state};
    if (row.state === 'succeeded') {
      if (!row.asset_id) throw new DomainError(404,'CONTENT_ASSET_NOT_FOUND');
      return {...status,result:{contentAssetId:row.asset_id,title:row.title,markdown:row.markdown,
        platform:row.platform,contentType:row.content_type}};
    }
    if (row.state === 'failed') {
      const code = row.error_code ?? 'LINK_EXTRACTION_FAILED';
      return {...status,error:{code,userMessage:linkFailureMessage(code),retryable:row.retryable}};
    }
    return status;
  });
  if ('result' in data) {
    const view = await contentAssetPartImageView(storage,scope,{contentMarkdown:data.result.markdown});
    data.result.markdown = view.contentMarkdown;
  }
  return data;
}

export class LinkExtractionJobs {
  constructor(private readonly assets: ContentAssetService, private readonly extractor: LinkExtractor) {}

  async execute(attempt: Attempt, engine: TaskEngine) {
    const task = attempt.task;
    const {rows:[input]} = await this.assets.pool.query<{body:string}>(`SELECT i.body FROM task_inputs i
      JOIN users u ON u.id=i.user_id AND u.status='active' AND u.deleted_at IS NULL
      WHERE i.id=$1 AND i.user_id=$2 AND i.workspace_id IS NULL`, [task.input_id,task.user_id]);
    if (!task.user_id || input?.body.charAt(36) !== '\n') return engine.fail(attempt,'LINK_INPUT_UNAVAILABLE',false);
    const sessionId = input.body.slice(0,36);
    const url = input.body.slice(37);
    const deadline = AbortSignal.timeout(60_000);
    const signal = attempt.signal ? AbortSignal.any([attempt.signal,deadline]) : deadline;
    try {
      const body = await this.extractor.extract(url,signal);
      signal.throwIfAborted();
      const scope = {userId:task.user_id,sessionId,traceId:task.trace_id};
      return await engine.finish(attempt,hash(body.markdown),Buffer.byteLength(body.markdown),async tx => {
        const asset = await this.assets.saveExtractedLink(tx,scope,url,body);
        await tx.query(`INSERT INTO content_jobs
          (task_id,content_asset_id,content_asset_revision_id,operation,source_platform,source_content_type)
          VALUES ($1,$2,$3,'import',$4,$5)`,
          [task.id,asset.contentAssetId,asset.contentAssetRevisionId,body.platform,body.contentType]);
      });
    } catch (error) {
      if (deadline.aborted) return engine.fail(attempt,'LINK_EXTRACTION_TIMEOUT',true);
      if (error instanceof DomainError) {
        return engine.fail(attempt,error.code,error instanceof LinkError && ['LINK_PROVIDER_UNAVAILABLE','LINK_EXTRACTION_TIMEOUT'].includes(error.code));
      }
      throw error;
    }
  }
}
