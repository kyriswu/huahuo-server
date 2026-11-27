import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { DomainError, transaction } from '../identity/store.js';
import { enqueueIntent, event, hash, newTaskMaxAttempts } from '../tasks/model.js';
import { lockOwnedAttemptTx } from '../tasks/lifecycle.js';
import type { Attempt, TaskExecutor } from '../tasks/execution.js';
import { readPublished } from '../ai-templates/catalog.js';
import { type Catalog, MaxOutputChars, MaxRenderedPromptChars, MaxSourceChars, visibleTemplates } from '../ai-templates/model.js';
import { renderPrompt } from '../ai-templates/prompt-variables.js';
import { outlineReference, recordingOutlineKind } from './recording-status.js';
import { RunTimeoutMs } from '../ai-templates/runs.js';

export async function enqueueRecordingOutline(tx: pg.PoolClient, userId: string, traceId: string, assetId: string, revision: string) {
  // All callers hold the parent asset lock, including the ASR receipt transaction.
  const id = randomUUID();
  await tx.query(`INSERT INTO tasks(id,user_id,kind,queue,state,trace_id,max_attempts,external_reference)
    VALUES($1,$2,$3,'ai','queued',$4,$5,$6)`, [id,userId,recordingOutlineKind,traceId,newTaskMaxAttempts(),outlineReference(assetId,revision)]);
  await enqueueIntent(tx,id);
  await event(tx,id);
}

interface OutlineInput { prompt: string; text: string; }
// Implementations must authenticate as a service and use runId to deduplicate remote execution.
export interface RecordingOutlineProvider {
  generate(runId: string, input: OutlineInput, signal: AbortSignal): Promise<string>;
}

export class OutlineError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); }
}

export class RecordingOutlineJobs implements TaskExecutor {
  constructor(private readonly pool: pg.Pool, private readonly provider?: RecordingOutlineProvider) {}

  async execute(attempt: Attempt) {
    const { task } = attempt;
    const [,assetId,revision] = (task.external_reference ?? '').split(':');
    if (!task.user_id || !assetId || !revision) throw new OutlineError('RECORDING_INPUT_MISSING');
    if (!this.provider) throw new OutlineError('RECORDING_OUTLINE_PROVIDER_UNAVAILABLE');
    const prepared = await transaction(this.pool, async tx => {
      if (!await lockOwnedAttemptTx(tx,attempt)) throw new OutlineError('TASK_LEASE_LOST');
      const source = (await tx.query<{ title: string; text: string }>(`SELECT a.title,p.content_markdown AS text
        FROM content_assets a JOIN users u ON u.id=a.user_id AND u.status='active' AND u.deleted_at IS NULL
        JOIN content_asset_parts p ON p.content_asset_id=a.content_asset_id AND p.part='raw' AND p.part_revision_id=$3
        WHERE a.content_asset_id=$1 AND a.user_id=$2 AND a.state='active' AND a.source_kind='recorder_card'
        FOR SHARE OF a`, [assetId,task.user_id,revision])).rows[0];
      if (!source) throw new OutlineError('AI_TEMPLATE_SOURCE_CHANGED');
      const previous = (await tx.query<{state:string; result_text: string | null; request_hash: string; template_version:number; title:string}>(
        `SELECT r.state,r.result_text,r.request_hash,r.template_version,i.body AS title FROM ai_template_runs r
         JOIN tasks t ON t.id=r.id JOIN task_inputs i ON i.id=t.input_id AND i.user_id=t.user_id
         WHERE r.id=$1 AND r.user_id=$2`,[task.id,task.user_id])).rows[0];
      if (previous?.state === 'succeeded' && previous.result_text) return { result: previous.result_text };
      // Reconciliation must retain the originally published template and title even after catalog or title changes.
      const publication = previous ? (await tx.query<{catalog:Catalog;revision:number}>(
        "SELECT catalog,revision FROM ai_template_versions WHERE scene_key='content_asset_outline' AND revision=$1",
        [previous.template_version])).rows[0] : await readPublished(tx,'content_asset_outline');
      if (!publication) throw new OutlineError('AI_TEMPLATE_UNAVAILABLE');
      const { catalog, revision: templateVersion } = publication;
      const template = visibleTemplates(catalog).find(item => item.itemKey === 'smart_outline');
      if (!template) throw new OutlineError('AI_TEMPLATE_UNAVAILABLE');
      if (!source.text.trim() || source.text.length > MaxSourceChars) throw new OutlineError('AI_TEMPLATE_SOURCE_INVALID');
      const prompt = renderPrompt('content_asset_outline',template,previous?.title ?? source.title,{},MaxRenderedPromptChars);
      if (!prompt) throw new OutlineError('AI_TEMPLATE_PROMPT_INVALID');
      const input = { prompt, text: source.text };
      if (previous) {
        if (previous.request_hash !== hash(JSON.stringify(input))) {
          throw new OutlineError('RECORDING_OUTLINE_OUTCOME_UNKNOWN');
        }
        await tx.query(`UPDATE ai_template_runs SET state='running',error_code=NULL,error_status=NULL,
          finished_at=NULL,deadline_at=clock_timestamp()+interval '1 day' WHERE id=$1`,[task.id]);
        return { input };
      }
      const inputId = randomUUID();
      await tx.query('INSERT INTO task_inputs(id,user_id,body) VALUES($1,$2,$3)',[inputId,task.user_id,source.title]);
      await tx.query('UPDATE tasks SET input_id=$2 WHERE id=$1',[task.id,inputId]);
      await tx.query(`INSERT INTO ai_template_runs(id,user_id,scene_key,item_key,template_version,content_asset_id,
        source_revision,idempotency_key,request_hash,trace_id,deadline_at)
        VALUES($1,$2,'content_asset_outline',$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+interval '1 day')`,
      [task.id,task.user_id,template.itemKey,templateVersion,assetId,revision,'recorder-outline:'+task.id,hash(JSON.stringify(input)),task.trace_id]);
      return { input };
    });
    let text = prepared.result;
    if (!text) {
      const timeout = AbortSignal.timeout(RunTimeoutMs);
      const signal = attempt.signal ? AbortSignal.any([attempt.signal,timeout]) : timeout;
      // A worker that loses its lease can repeat this call only with the same runId and verified input.
      try {
        text = await this.provider.generate(task.id,prepared.input!,signal);
        signal.throwIfAborted();
      } catch (error) {
        if (error instanceof OutlineError) throw error;
        throw new OutlineError('RECORDING_OUTLINE_OUTCOME_UNKNOWN',true);
      }
      if (!text.trim() || text.length > MaxOutputChars || text.includes('\u0000')) throw new OutlineError('AI_TEMPLATE_AGENT_RESPONSE_INVALID');
      const saved = await transaction(this.pool, async tx => {
        if (!await lockOwnedAttemptTx(tx,attempt)) return false;
        const source = (await tx.query(`SELECT 1 FROM content_assets a JOIN content_asset_parts p
          ON p.content_asset_id=a.content_asset_id AND p.part='raw' AND p.part_revision_id=$3
          JOIN users u ON u.id=a.user_id AND u.status='active' AND u.deleted_at IS NULL
          WHERE a.content_asset_id=$1 AND a.user_id=$2 AND a.state='active' FOR SHARE OF a`,[assetId,task.user_id,revision])).rowCount;
        if (!source) throw new OutlineError('AI_TEMPLATE_SOURCE_CHANGED');
        return (await tx.query(`UPDATE ai_template_runs SET result_text=$2,state='succeeded',finished_at=clock_timestamp()
          WHERE id=$1 AND state='running'`,[task.id,text])).rowCount === 1;
      });
      if (!saved) throw new OutlineError('RECORDING_OUTLINE_OUTCOME_UNKNOWN');
    }
    return {digest: hash(text),bytes: Buffer.byteLength(text)};
  }
}

// Keep the catalog/run read contract consistent with terminal worker errors.
export async function failRecordingOutlineRun(tx: pg.PoolClient, taskId: string, code: string) {
  const error = new DomainError(code === 'AI_TEMPLATE_SOURCE_CHANGED' ? 409 : 503,code);
  await tx.query(`UPDATE ai_template_runs SET state='failed',error_code=$2,error_status=$3,finished_at=clock_timestamp()
    WHERE id=$1 AND state='running'`,[taskId,error.code,error.statusCode]);
}
