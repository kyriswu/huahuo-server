import { idempotent } from '../../lib/idempotency.js';
import type pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/config.js';
import type { TocItem, TocStatus } from '../../lib/document-processing/types.js';
import { assertScope, DomainError, transaction, type Scope } from '../identity/store.js';
import { DocumentParseError, parseDocument } from './document-parser.js';
import type { NoteIndexJob, NoteIndexJobStatus } from './types.js';
import { manualTextSnapshot, type ManualTextSnapshot } from './profile.js';
import { requireTocSection, sectionResult } from './sections.js';
import { enqueueIntent, event } from '../tasks/model.js';

const DEFAULT_PIPELINE_VERSION = 'manual-text';
const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_OVERLAP_TOKENS = 64;
const MAX_CONTENT_BYTES = 500_000;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export interface DocumentIngestionInput { content?: string; contentBase64?: string; fileName?: string; mimeType?: string; pipelineVersion?: string; maxTokens?: number; overlapTokens?: number; }
export interface DocumentIngestionResult { idempotencyKey: string; documentId: string; documentVersion: string; contentHash: string; pipelineVersion: string; parserVersion: string; chunkerVersion: string; status: NoteIndexJobStatus; chunkCount: number; reused: boolean; jobId: string | null; }
interface NoteRow { note_id: string; title: string; note_revision_id: string; raw_revision_id: string | null; state: string; raw_content: string | null; }
interface JobRow { idempotency_key: string; workspace_id: string; document_id: string; document_version: string; content_hash: string; pipeline_version: string; parser_version: string; chunker_version: string; source_type: 'note'; status: NoteIndexJobStatus; chunk_count: number; task_id: string | null; toc_status: TocStatus; error_code: string | null; error_message: string | null; created_at: Date | string; updated_at: Date | string; }
interface ReadableJobRow extends JobRow {
  toc: TocItem[] | null;
  canonical_content: string | null;
  format: ManualTextSnapshot['format'] | null;
}
const jobFields = `v.idempotency_key,v.workspace_id,v.document_id,v.document_version,v.content_hash,
  v.pipeline_version,v.parser_version,v.chunker_version,v.source_type,v.status,v.chunk_count,v.task_id,v.toc_status,
  v.error_code,v.error_message,v.created_at,v.updated_at`;
function mapJob(row: JobRow): NoteIndexJob { return { idempotencyKey: row.idempotency_key, workspaceId: row.workspace_id, documentId: row.document_id, documentVersion: row.document_version, contentHash: row.content_hash, pipelineVersion: row.pipeline_version, parserVersion: row.parser_version, chunkerVersion: row.chunker_version, sourceType: row.source_type, status: row.status, chunkCount: Number(row.chunk_count), jobId: row.task_id, tocStatus: row.toc_status, ...(row.error_code ? { errorCode: row.error_code } : {}), ...(row.error_message ? { errorMessage: row.error_message } : {}), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }; }
function result(row: JobRow, reused: boolean): DocumentIngestionResult { return { idempotencyKey: row.idempotency_key, documentId: row.document_id, documentVersion: row.document_version, contentHash: row.content_hash, pipelineVersion: row.pipeline_version, parserVersion: row.parser_version, chunkerVersion: row.chunker_version, status: row.status, chunkCount: Number(row.chunk_count), reused, jobId: row.task_id }; }
function inputText(input: DocumentIngestionInput): string | Uint8Array | undefined {
  if (input.content !== undefined && input.contentBase64 !== undefined) throw new DomainError(400, 'INGEST_CONTENT_CONFLICT');
  if (input.content !== undefined) return input.content;
  if (input.contentBase64 === undefined) return undefined;
  const value = Buffer.from(input.contentBase64, 'base64');
  if (value.toString('base64').replace(/=+$/, '') !== input.contentBase64.replace(/=+$/, '')) throw new DomainError(400, 'INGEST_CONTENT_INVALID');
  return new Uint8Array(value);
}
async function noteFor(tx: pg.PoolClient, scope: Scope, workspaceId: string, noteId: string, lockForIndexing = false): Promise<NoteRow> {
  const row = (await tx.query<NoteRow>(`SELECT n.note_id,n.title,n.note_revision_id,n.state,
    (SELECT p.part_revision_id FROM note_part_revisions p WHERE p.note_id=n.note_id AND p.part='raw' ORDER BY p.revision DESC LIMIT 1) AS raw_revision_id,
    (SELECT p.content_markdown FROM note_part_revisions p WHERE p.note_id=n.note_id AND p.part='raw' ORDER BY p.revision DESC LIMIT 1) AS raw_content
    FROM notes n JOIN workspaces w ON w.id=n.workspace_id AND w.user_id=$3 AND w.state='ready'
    WHERE n.workspace_id=$1 AND n.note_id=$2 FOR ${lockForIndexing ? 'UPDATE' : 'SHARE'} OF n`, [workspaceId, noteId, scope.userId])).rows[0];
  if (!row || row.state !== 'active') throw new DomainError(404, 'NOTE_NOT_FOUND');
  return row;
}

/** Manual text belongs to Note and is scheduled on the existing task/outbox. */
export class DocumentIngestionService {
  constructor(readonly pool: pg.Pool, readonly secret: string, readonly config?: AppConfig) {}
  async ingestNote(scope: Scope, workspaceId: string, noteId: string, input: DocumentIngestionInput, idempotencyKey: string): Promise<DocumentIngestionResult> {
    return transaction(this.pool, tx => this.ingestNoteInTransaction(tx, scope, workspaceId, noteId, input, idempotencyKey));
  }

  /** Save the Note and its indexing intent atomically in an existing business transaction. */
  async ingestNoteInTransaction(tx: pg.PoolClient, scope: Scope, workspaceId: string, noteId: string, input: DocumentIngestionInput, idempotencyKey: string): Promise<DocumentIngestionResult> {
    if (!this.config) throw new DomainError(503, 'MANUAL_TEXT_TARGET_NOT_CONFIGURED');
    const config = this.config;
    if (input.pipelineVersion && !/^[A-Za-z0-9._-]{1,42}$/.test(input.pipelineVersion)) throw new DomainError(400, 'INGEST_PIPELINE_INVALID');
    // Parsing accepts text formats only and preserves every original code unit.
    await assertScope(tx, scope);
    const note = await noteFor(tx, scope, workspaceId, noteId, true);
      return idempotent(tx, this.secret, `${scope.userId}:${workspaceId}:${noteId}`, 'document.ingestion', idempotencyKey, input, async () => {
        const source = inputText(input) ?? note.raw_content;
        if (source === undefined || source === null) throw new DomainError(409, 'INGEST_SOURCE_EMPTY');
        if ((typeof source === 'string' ? Buffer.byteLength(source, 'utf8') : source.byteLength) > MAX_CONTENT_BYTES) throw new DomainError(413, 'INGEST_CONTENT_TOO_LARGE');
        let parsed;
        try { parsed = typeof source === 'string' && !source.trim() && input.content === undefined ? {content: source, format: 'markdown' as const, parserVersion: 'plain-text'} : await parseDocument({ content: source, fileName: input.fileName ?? (input.mimeType ? undefined : `${note.title}.md`), mimeType: input.mimeType ?? (input.fileName ? undefined : 'text/markdown') }); }
        catch (error) { if (error instanceof DocumentParseError) throw new DomainError(400, error.code); throw error; }
        const content = parsed.content;
        if ([...content].length > config.rag.plainTextMaxChars) throw new DomainError(413, 'RAG_PLAIN_TEXT_TOO_LARGE');
        const contentHash = sha256(content);
        const documentVersion = note.note_revision_id;
        const snapshot = manualTextSnapshot(config, { parentId: note.note_id, revision: documentVersion, expectedNoteRevision: note.note_revision_id, expectedRawRevision: note.raw_revision_id ?? undefined, format: parsed.format, maxTokens: input.maxTokens, overlapTokens: input.overlapTokens, pipelineVersion: input.pipelineVersion });
        const key = sha256(JSON.stringify(['note', note.note_id, documentVersion, contentHash, snapshot.chunkProfile]));
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
        const existing = (await tx.query<JobRow>('SELECT * FROM note_index_jobs WHERE idempotency_key=$1', [key])).rows[0];
        if (existing) return result(existing, true);
        const taskId = randomUUID(), inputId = randomUUID();
        // Note writes are serialized by its row lock. Keep the job order
        // consistent with save order even if the database clock steps back.
        const created = (await tx.query<JobRow>(`INSERT INTO note_index_jobs
          (idempotency_key,workspace_id,document_id,document_version,content_hash,pipeline_version,parser_version,chunker_version,source_type,status,canonical_content,processing_snapshot,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'langchain-recursive','note','processing',$8,$9::jsonb,
            GREATEST(clock_timestamp(), (SELECT max(created_at)+interval '1 microsecond'
              FROM note_index_jobs WHERE workspace_id=$2 AND document_id=$3))) RETURNING *`, [key, workspaceId, note.note_id, documentVersion, contentHash, snapshot.chunkProfile, parsed.parserVersion, content, JSON.stringify(snapshot)])).rows[0]!;
        await tx.query('INSERT INTO task_inputs(id,user_id,workspace_id,body) VALUES($1,$2,$3,$4)', [inputId, scope.userId, workspaceId, JSON.stringify({ ingestionKey: key })]);
        await tx.query("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,input_id,state,max_attempts) VALUES($1,$2,$3,'document.text-index','content',$4,'queued',3)", [taskId, scope.userId, workspaceId, inputId]);
        await tx.query('UPDATE note_index_jobs SET task_id=$2 WHERE idempotency_key=$1', [key, taskId]);
        await enqueueIntent(tx, taskId); await event(tx, taskId);
        return result({ ...created, task_id: taskId }, false);
      });
  }
  async listNoteJobs(scope: Scope, workspaceId: string, noteId: string): Promise<{ items: NoteIndexJob[] }> {
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope); await noteFor(tx, scope, workspaceId, noteId);
      const rows = await tx.query<JobRow>(`SELECT ${jobFields} FROM note_index_jobs v
        WHERE v.workspace_id=$1 AND v.document_id=$2 ORDER BY v.updated_at DESC LIMIT 50`, [workspaceId, noteId]);
      return { items: rows.rows.map(mapJob) };
    });
  }
  private async jobFor(scope: Scope, workspaceId: string, noteId: string, jobId: string, includeContent: boolean) {
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      const row = (await tx.query<ReadableJobRow>(`SELECT ${jobFields},v.toc,
        CASE WHEN $5 THEN v.canonical_content END AS canonical_content, v.processing_snapshot->>'format' AS format
        FROM note_index_jobs v JOIN notes n ON n.note_id=v.document_id AND n.workspace_id=v.workspace_id
        JOIN workspaces w ON w.id=n.workspace_id AND w.user_id=$4 AND w.state='ready'
        WHERE v.workspace_id=$1 AND n.note_id=$2 AND v.task_id=$3 AND n.state='active'`,
      [workspaceId, noteId, jobId, scope.userId, includeContent])).rows[0];
      if (!row) throw new DomainError(404, 'INGEST_JOB_NOT_FOUND');
      return row;
    });
  }
  async noteJob(scope: Scope, workspaceId: string, noteId: string, jobId: string) {
    const row = await this.jobFor(scope, workspaceId, noteId, jobId, false);
    return { ...mapJob(row), toc: row.toc, offsetUnit: 'utf16' as const };
  }
  async noteSection(scope: Scope, workspaceId: string, noteId: string, jobId: string, sectionId: string) {
    const row = await this.jobFor(scope, workspaceId, noteId, jobId, true);
    const section = requireTocSection(row.toc_status, row.toc, sectionId);
    if (row.canonical_content === null || !row.format) throw new DomainError(503, 'DOCUMENT_SECTION_UNAVAILABLE');
    return sectionResult(section, row.document_version, row.format, row.canonical_content.slice(section.sourceStart, section.sourceEnd));
  }
}
export { DEFAULT_PIPELINE_VERSION, DEFAULT_MAX_TOKENS, DEFAULT_OVERLAP_TOKENS };
