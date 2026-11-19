import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import { idempotent } from '../../lib/idempotency.js';
import { kbImages } from '../../lib/kb-images.js';
import { EDITABLE_MARKDOWN_MAX_CHARS } from '../../lib/kb-image-markdown.js';
import { assertScope, DomainError, transaction, type Scope } from '../identity/store.js';
import { normalizeOwnedImageParts, restoreOwnedImageParts } from '../storage/image-content.js';
import { enqueueIntent, event, newTaskMaxAttempts, terminal, type TaskRow } from '../tasks/model.js';
import { finalizeUnsuccessfulTaskTx } from '../tasks/reservations.js';
import { fileProcessingSnapshot, type FileProcessingSnapshot } from '../rag/processing-profile.js';
import { validateSourceUri, DocumentPreparationError } from '../rag/document-preparation.js';
import { assertCreateTextIngestionInput, assertManualTextEditable, assertTextIngestionContent, assertUpdateTextIngestionInput } from './policy.js';
import { TextIngestionSourceType, type TextIngestionJob, type TextIngestionStatus } from './types.js';
import {resolveTraceId} from '../../lib/trace.js';
import type { ResourceClaims } from '../storage/resource-claims.js';
import { ownedObjectKey } from '../storage/object-locator.js';
import { attachResource,replaceResourceRefs } from '../storage/references.js';

interface TextJobRow {
  id: string; source_type: TextIngestionSourceType; raw_content: string | null;
  origin_resource_uri: string | null; ingest_status: TextIngestionStatus; error_msg: string | null;
  created_at: Date | string; updated_at: Date | string; created_by: string;
  workspace_id: string; current_task_id: string; artifact_uri: string | null;
}
export function textIngestionDto(row: TextJobRow): TextIngestionJob {
  return { id: row.id, source_type: row.source_type, raw_content: row.raw_content,
    origin_resource_uri: row.origin_resource_uri, ingest_status: row.ingest_status,
    error_msg: row.error_msg, created_at: new Date(row.created_at).getTime(),
    updated_at: new Date(row.updated_at).getTime(), created_by: row.created_by };
}
const jobFields = `j.*,CASE WHEN t.state IN ('failed','cancelled') AND j.ingest_status<>'success' THEN 'failed' ELSE j.ingest_status END AS ingest_status,
  CASE WHEN t.state IN ('failed','cancelled') AND j.ingest_status<>'success' THEN coalesce(j.error_msg,t.error_code,'TEXT_INGESTION_FAILED') ELSE j.error_msg END AS error_msg`;
const etag = (row: TextJobRow) => `"text-${row.id}-${row.current_task_id}"`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Independent source record; execution and delivery remain in Task/Outbox. */
export class TextIngestionService {
  constructor(private readonly pool: pg.Pool, private readonly config: AppConfig, private readonly resourceClaims?: ResourceClaims) {}
  private available(source: TextIngestionSourceType): void {
    if (!this.config.rag.enabled) throw new DomainError(503, 'TEXT_INGESTION_DISABLED');
    if (source !== TextIngestionSourceType.MANUAL_INPUT && source !== TextIngestionSourceType.FILE_UPLOAD) throw new DomainError(503, 'TEXT_SOURCE_ADAPTER_UNAVAILABLE');
  }
  private async owned(tx: pg.PoolClient, scope: Scope, id: string, lock = false): Promise<TextJobRow> {
    const row = (await tx.query<TextJobRow>(`SELECT ${jobFields} FROM text_ingestion_jobs j
      JOIN workspaces w ON w.id=j.workspace_id AND w.user_id=j.created_by AND w.state='ready'
      JOIN tasks t ON t.id=j.current_task_id AND t.user_id=j.created_by AND t.workspace_id=j.workspace_id
      WHERE j.id=$1 AND j.created_by=$2 ${lock ? 'FOR UPDATE OF j' : ''}`, [id, scope.userId])).rows[0];
    if (!row) throw new DomainError(404, 'TEXT_INGESTION_NOT_FOUND');
    return row;
  }
  private async schedule(tx: pg.PoolClient, scope: Scope, workspaceId: string, id: string, taskId: string, snapshot = fileProcessingSnapshot(this.config, 'markdown')): Promise<void> {
    const inputId = randomUUID();
    await tx.query('INSERT INTO task_inputs(id,user_id,workspace_id,body) VALUES($1,$2,$3,$4)',
      [inputId, scope.userId, workspaceId, JSON.stringify({ jobId: id, snapshot })]);
    await tx.query("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,input_id,state,trace_id,max_attempts) VALUES($1,$2,$3,'text.ingest','content',$4,'queued',$5,$6)",
      [taskId, scope.userId, workspaceId, inputId,resolveTraceId(scope.traceId),newTaskMaxAttempts()]);
    await enqueueIntent(tx, taskId); await event(tx, taskId);
  }
  /** The normalizer already locked and authorized these images in this transaction. */
  private async syncImageRefs(tx: pg.PoolClient, scope: Scope, workspaceId: string, id: string, content: string): Promise<void> {
    const ids = [...new Set(kbImages(content).map(image => image.resourceId))];
    await replaceResourceRefs(tx,scope.userId,'text-image',id,ids,workspaceId);
  }
  async create(scope: Scope, input: unknown, key: string): Promise<TextIngestionJob> {
    assertCreateTextIngestionInput(input, EDITABLE_MARKDOWN_MAX_CHARS);
    this.available(input.source_type);
    if (input.source_type !== TextIngestionSourceType.MANUAL_INPUT) {
      try { validateSourceUri(input.origin_resource_uri, this.config); }
      catch (error) { if (error instanceof DocumentPreparationError) throw new DomainError(400, error.code); throw error; }
    }
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      const workspace = (await tx.query<{ id: string }>("SELECT id FROM workspaces WHERE user_id=$1 AND is_default AND state='ready'", [scope.userId])).rows[0];
      if (!workspace) throw new DomainError(409, 'WORKSPACE_NOT_READY');
      const prepared = input.source_type === TextIngestionSourceType.MANUAL_INPUT
        ? await normalizeOwnedImageParts(tx, scope, { raw: input.raw_content }, this.config, this.resourceClaims, workspace.id)
        : undefined;
      const sourceResourceId = input.source_type === TextIngestionSourceType.FILE_UPLOAD ? ownedObjectKey(input.origin_resource_uri, this.config) : undefined;
      if (sourceResourceId !== undefined) {
        if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(sourceResourceId)) throw new DomainError(404, 'RESOURCE_NOT_FOUND');
        await this.resourceClaims?.ensure(tx, scope, workspace.id, [sourceResourceId]);
      }
      // Claiming takes the account lock first. Plain text/external sources do not
      // need that lock; both paths recheck and hold the workspace before writing.
      if (!(await tx.query("SELECT id FROM workspaces WHERE id=$1 AND user_id=$2 AND state='ready' FOR SHARE", [workspace.id, scope.userId])).rowCount) throw new DomainError(409, 'WORKSPACE_NOT_READY');
      const stableInput = prepared ? { ...input, raw_content: prepared.parts.raw, imageOrigins: prepared.imageOrigins } : input;
      return idempotent(tx, this.config.appTokenSecret!, scope.userId, 'text-ingestion.create', key, stableInput, async () => {
        const id = randomUUID(), taskId = randomUUID();
        if (sourceResourceId !== undefined) {
          await attachResource(tx, scope.userId, sourceResourceId, 'text-source', id, workspace.id);
          const resource = (await tx.query<{object_version:string}>("SELECT object_version FROM resources WHERE resource_id=$1", [sourceResourceId])).rows[0]!;
          const versions = new URL(input.origin_resource_uri!).searchParams.getAll('versionId');
          const version = resource.object_version.startsWith('oss-version:') ? resource.object_version.slice('oss-version:'.length) : null;
          if (version ? versions.length !== 1 || versions[0] !== version : versions.length !== 0) throw new DomainError(400, 'RESOURCE_URL_INVALID');
        }
        const raw = prepared ? restoreOwnedImageParts({}, prepared).raw! : null;
        if (raw !== null) assertTextIngestionContent(raw, Math.min(50_000, this.config.rag.plainTextMaxChars));
        const uri = input.source_type === TextIngestionSourceType.MANUAL_INPUT ? null : input.origin_resource_uri;
        const row = (await tx.query<TextJobRow>(`INSERT INTO text_ingestion_jobs
          (id,source_type,raw_content,origin_resource_uri,created_by,workspace_id,current_task_id,content_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, input.source_type, raw, uri, scope.userId, workspace.id, taskId, raw === null ? null : hash(raw)])).rows[0]!;
        if (raw !== null) await this.syncImageRefs(tx, scope, workspace.id, id, raw);
        await this.schedule(tx, scope, workspace.id, id, taskId,fileProcessingSnapshot(this.config,'markdown',
          input.source_type===TextIngestionSourceType.FILE_UPLOAD?{sourceResourceId:sourceResourceId??id,parseRunId:taskId}:undefined));
        return textIngestionDto(row);
      });
    });
  }
  async get(scope: Scope, id: string): Promise<{ data: TextIngestionJob; etag: string }> {
    return transaction(this.pool, async tx => { await assertScope(tx, scope); const row = await this.owned(tx, scope, id); return { data: textIngestionDto(row), etag: etag(row) }; });
  }
  async list(scope: Scope, input: { limit?: number; before?: string } = {}): Promise<{ items: TextIngestionJob[]; nextCursor: string | null }> {
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      const limit = Math.min(100, Math.max(1, input.limit ?? 20));
      const cursor = input.before ? await this.owned(tx, scope, input.before) : undefined;
      const rows = (await tx.query<TextJobRow>(`SELECT ${jobFields} FROM text_ingestion_jobs j
        JOIN workspaces w ON w.id=j.workspace_id AND w.user_id=j.created_by AND w.state='ready'
      JOIN tasks t ON t.id=j.current_task_id AND t.user_id=j.created_by AND t.workspace_id=j.workspace_id
        WHERE j.created_by=$1 AND ($2::timestamptz IS NULL OR (j.created_at,j.id)<($2,$3::uuid)) ORDER BY j.created_at DESC,j.id DESC LIMIT $4`,
      [scope.userId, cursor?.created_at ?? null, cursor?.id ?? null, limit + 1])).rows;
      const page = rows.slice(0, limit);
      return { items: page.map(textIngestionDto), nextCursor: rows.length > limit ? page.at(-1)!.id : null };
    });
  }
  async update(scope: Scope, id: string, input: unknown, key: string, ifMatch: string): Promise<TextIngestionJob> {
    assertUpdateTextIngestionInput(input, EDITABLE_MARKDOWN_MAX_CHARS);
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      const current = await this.owned(tx, scope, id);
      assertManualTextEditable(current.source_type);
      // Removing the last image also updates its resource count. Use the same
      // account-before-business-row order as edits that claim new images.
      if(current.raw_content&&kbImages(current.raw_content).length)await this.resourceClaims?.lockAccount(tx,scope);
      const prepared = await normalizeOwnedImageParts(tx, scope, { raw: input.raw_content }, this.config, this.resourceClaims, current.workspace_id);
      const stableInput = { raw_content: prepared.parts.raw, imageOrigins: prepared.imageOrigins };
      return idempotent(tx, this.config.appTokenSecret!, scope.userId, `text-ingestion.update:${id}`, key, { input: stableInput, ifMatch }, async () => {
        const row = await this.owned(tx, scope, id, true);
        assertManualTextEditable(row.source_type); this.available(row.source_type);
        if (etag(row) !== ifMatch) throw new DomainError(412, 'TEXT_INGESTION_CHANGED');
        const raw = restoreOwnedImageParts({ raw: row.raw_content! }, prepared).raw!;
        assertTextIngestionContent(raw, Math.min(50_000, this.config.rag.plainTextMaxChars));
        if (row.raw_content === raw) return textIngestionDto(row);
        const taskId = randomUUID();
        // Fence the old execution before publishing another delivery. Its vectors
        // remain readable only through the previous active_task_id until replacement.
        const previous = (await tx.query<TaskRow>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [row.current_task_id])).rows[0]!;
        if (!terminal(previous.state)) {
          if (previous.external_state==='none'&&!['running','cancel_requested'].includes(previous.state)) await finalizeUnsuccessfulTaskTx(tx,previous,{state:'cancelled'});
          else {
            await tx.query("UPDATE tasks SET state='cancel_requested',cancel_requested_at=now(),version=version+1,lease_owner=NULL,lease_until=NULL,retryable=false WHERE id=$1", [row.current_task_id]);
            await event(tx,row.current_task_id);
          }
        }
        const updated = (await tx.query<TextJobRow>(`UPDATE text_ingestion_jobs SET raw_content=$2,content_hash=$3,
          current_task_id=$4,ingest_status='pending',error_msg=NULL,updated_at=now() WHERE id=$1 RETURNING *`,
        [id, raw, hash(raw), taskId])).rows[0]!;
        await this.syncImageRefs(tx, scope, row.workspace_id, id, raw);
        await this.schedule(tx, scope, row.workspace_id, id, taskId);
        return textIngestionDto(updated);
      });
    });
  }
  async retry(scope: Scope, id: string, key: string): Promise<TextIngestionJob> {
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope); await this.owned(tx, scope, id);
      return idempotent(tx, this.config.appTokenSecret!, scope.userId, `text-ingestion.retry:${id}`, key, {}, async () => {
        const row = await this.owned(tx, scope, id, true); this.available(row.source_type);
        const current = (await tx.query<{ state: string; body: string }>(`SELECT t.state,i.body FROM tasks t
          JOIN task_inputs i ON i.id=t.input_id AND i.user_id=t.user_id AND i.workspace_id=t.workspace_id
          WHERE t.id=$1 AND t.user_id=$2 AND t.workspace_id=$3 FOR UPDATE OF t`, [row.current_task_id, scope.userId, row.workspace_id])).rows[0];
        if (!current || !['failed', 'cancelled'].includes(current.state)) throw new DomainError(409, 'TEXT_INGESTION_RETRY_NOT_ALLOWED');
        let frozen: { jobId?: string; snapshot?: FileProcessingSnapshot };
        try { frozen = JSON.parse(current.body) as typeof frozen; } catch { throw new DomainError(409, 'TEXT_INGESTION_SNAPSHOT_INVALID'); }
        if (frozen.jobId !== id || frozen.snapshot?.version !== 'file-processing' || !frozen.snapshot.keyword?.target.collection) throw new DomainError(409, 'TEXT_INGESTION_SNAPSHOT_INVALID');
        const taskId = randomUUID();
        const updated = (await tx.query<TextJobRow>("UPDATE text_ingestion_jobs SET current_task_id=$2,ingest_status='pending',error_msg=NULL,updated_at=now() WHERE id=$1 RETURNING *", [id, taskId])).rows[0]!;
        await this.schedule(tx, scope, row.workspace_id, id, taskId, frozen.snapshot); return textIngestionDto(updated);
      });
    });
  }
}
