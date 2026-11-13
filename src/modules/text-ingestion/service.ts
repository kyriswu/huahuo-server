import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import { idempotent } from '../../lib/idempotency.js';
import { assertScope, DomainError, transaction, type Scope } from '../identity/store.js';
import { enqueueIntent, event } from '../tasks/model.js';
import { fileProcessingSnapshot, type FileProcessingSnapshot } from '../rag/processing-profile.js';
import { validateSourceUri, DocumentPreparationError } from '../rag/document-preparation.js';
import type { StoragePort } from '../storage/port.js';
import { assertCreateTextIngestionInput, assertManualTextEditable, assertUpdateTextIngestionInput } from './policy.js';
import { TextIngestionSourceType, type TextIngestionJob, type TextIngestionStatus } from './types.js';

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
  constructor(private readonly pool: pg.Pool, private readonly config: AppConfig) {}
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
    await tx.query("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,input_id,state,max_attempts) VALUES($1,$2,$3,'text.ingest','content',$4,'queued',3)",
      [taskId, scope.userId, workspaceId, inputId]);
    await enqueueIntent(tx, taskId); await event(tx, taskId);
  }
  async create(scope: Scope, input: unknown, key: string): Promise<TextIngestionJob> {
    assertCreateTextIngestionInput(input, Math.min(50_000, this.config.rag.plainTextMaxChars));
    this.available(input.source_type);
    if (input.source_type !== TextIngestionSourceType.MANUAL_INPUT) {
      try { validateSourceUri(input.origin_resource_uri, this.config); }
      catch (error) { if (error instanceof DocumentPreparationError) throw new DomainError(400, error.code); throw error; }
    }
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      const workspace = (await tx.query<{ id: string }>("SELECT id FROM workspaces WHERE user_id=$1 AND is_default AND state='ready' FOR SHARE", [scope.userId])).rows[0];
      if (!workspace) throw new DomainError(409, 'WORKSPACE_NOT_READY');
      return idempotent(tx, this.config.appTokenSecret!, scope.userId, 'text-ingestion.create', key, input, async () => {
        const id = randomUUID(), taskId = randomUUID();
        const raw = input.source_type === TextIngestionSourceType.MANUAL_INPUT ? input.raw_content : null;
        const uri = input.source_type === TextIngestionSourceType.MANUAL_INPUT ? null : input.origin_resource_uri;
        const row = (await tx.query<TextJobRow>(`INSERT INTO text_ingestion_jobs
          (id,source_type,raw_content,origin_resource_uri,created_by,workspace_id,current_task_id,content_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, input.source_type, raw, uri, scope.userId, workspace.id, taskId, raw === null ? null : hash(raw)])).rows[0]!;
        await this.schedule(tx, scope, workspace.id, id, taskId,fileProcessingSnapshot(this.config,'markdown',
          input.source_type===TextIngestionSourceType.FILE_UPLOAD?{sourceResourceId:id,parseRunId:taskId}:undefined));
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
    assertUpdateTextIngestionInput(input, Math.min(50_000, this.config.rag.plainTextMaxChars));
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope); await this.owned(tx, scope, id);
      return idempotent(tx, this.config.appTokenSecret!, scope.userId, `text-ingestion.update:${id}`, key, { input, ifMatch }, async () => {
        const row = await this.owned(tx, scope, id, true);
        assertManualTextEditable(row.source_type); this.available(row.source_type);
        if (etag(row) !== ifMatch) throw new DomainError(412, 'TEXT_INGESTION_CHANGED');
        if (row.raw_content === input.raw_content) return textIngestionDto(row);
        const taskId = randomUUID();
        // Fence the old execution before publishing another delivery. Its vectors
        // remain readable only through the previous active_task_id until replacement.
        const cancelled = await tx.query("UPDATE tasks SET state=CASE WHEN state IN ('running','cancel_requested') THEN 'cancel_requested' ELSE 'cancelled' END,cancel_requested_at=now(),version=version+1,lease_owner=NULL,lease_until=NULL,retryable=false WHERE id=$1 AND state NOT IN ('succeeded','failed','cancelled') RETURNING id", [row.current_task_id]);
        if (cancelled.rowCount) await event(tx, row.current_task_id);
        const updated = (await tx.query<TextJobRow>(`UPDATE text_ingestion_jobs SET raw_content=$2,content_hash=$3,
          current_task_id=$4,ingest_status='pending',error_msg=NULL,updated_at=now() WHERE id=$1 RETURNING *`,
        [id, input.raw_content, hash(input.raw_content), taskId])).rows[0]!;
        await this.schedule(tx, scope, row.workspace_id, id, taskId);
        return textIngestionDto(updated);
      });
    });
  }
  async renderAssets(scope: Scope, id: string, content: string, storage: StoragePort): Promise<string> {
    if (!content.includes('asset://')) return content;
    const row = await transaction(this.pool, async tx => { await assertScope(tx, scope); return this.owned(tx, scope, id); });
    const prefix = `text-ingestions/${id}/`;
    if (!row.artifact_uri || !row.artifact_uri.startsWith(prefix) || !storage.signUrl) return content;
    let manifest: unknown;
    try {
      const stream = await storage.read(row.artifact_uri), parts: Buffer[] = []; let size = 0;
      try {
        for await (const part of stream) {
          const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part); size += bytes.byteLength;
          if (size > this.config.rag.maxSourceBytes) return content;
          parts.push(bytes);
        }
      } finally { stream.destroy(); }
      manifest = JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
    } catch { return content; }
    if (!manifest || typeof manifest !== 'object' || !('assets' in manifest) || !Array.isArray(manifest.assets)) return content;
    let rendered = content;
    for (const item of manifest.assets as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const asset = item as { assetRef?: unknown; objectKey?: unknown };
      if (typeof asset.assetRef !== 'string' || !asset.assetRef.startsWith('asset://') || typeof asset.objectKey !== 'string' || !asset.objectKey.startsWith(prefix) || !rendered.includes(asset.assetRef)) continue;
      try { rendered = rendered.replaceAll(asset.assetRef, await storage.signUrl(asset.objectKey, 900)); } catch { /* Keep the stable reference if the asset is missing. */ }
    }
    return rendered;
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
