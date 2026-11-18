import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { canonical, digest } from '../../lib/crypto.js';
import { assertScope, DomainError, lock, transaction, type Scope } from '../identity/store.js';
import { readPublished } from './catalog.js';
import { listCatalog, MaxPromptChars, MaxSourceChars, renderPrompt, visibleTemplates, type RunRequest, type SceneKey } from './model.js';

type RunRow = {
  id: string; scene_key: SceneKey; item_key: string; template_version: number;
  note_id: string | null; source_revision: string | null; request_hash: string; expired: boolean;
  state: 'running' | 'succeeded' | 'failed'; result_text: string | null; error_code: string | null; error_status: number | null;
};
type Source = { title: string; content_markdown: string; part_revision_id: string };
const fields = `id, scene_key, item_key, template_version, note_id, source_revision, request_hash,
  state, result_text, error_code, error_status, deadline_at <= clock_timestamp() AS expired`;

export const RunTimeoutMs = 90_000;

async function assertWorkspace(tx: pg.PoolClient, scope: Scope, workspaceId: string) {
  const result = await tx.query(
    "SELECT id FROM workspaces WHERE id=$1 AND user_id=$2 AND state='ready' FOR SHARE", [workspaceId, scope.userId],
  );
  if (!result.rowCount) throw new DomainError(404, 'WORKSPACE_NOT_FOUND');
}

async function readSource(tx: pg.PoolClient, workspaceId: string, noteId: string, includeContent = false) {
  // Note mutations lock the note before changing its parts.
  const { rows: [note] } = await tx.query<{ title: string }>(
    "SELECT title FROM notes WHERE workspace_id=$1 AND note_id=$2 AND state='active' FOR SHARE", [workspaceId, noteId],
  );
  if (!note) throw new DomainError(404, 'NOTE_NOT_FOUND');
  const { rows: [part] } = await tx.query<Omit<Source, 'title'>>(
    `SELECT CASE WHEN $2 THEN content_markdown ELSE '' END AS content_markdown, part_revision_id
     FROM note_parts WHERE note_id=$1 AND part='raw'`, [noteId, includeContent],
  );
  if (!part) throw new DomainError(404, 'NOTE_PART_NOT_FOUND');
  return { ...note, ...part };
}

function assertSourceRevision(source: Source, revision: string) {
  if (source.part_revision_id !== revision.toLowerCase()) throw new DomainError(409, 'AI_TEMPLATE_SOURCE_CHANGED');
}

async function writeFailure(tx: pg.PoolClient, id: string, error: DomainError) {
  const { rows: [row] } = await tx.query<RunRow>(
    `UPDATE ai_template_runs SET state='failed', error_code=$2, error_status=$3, finished_at=clock_timestamp()
     WHERE id=$1 AND state='running' RETURNING ${fields}`, [id, error.code, error.statusCode],
  );
  return row;
}

async function expireRun(tx: pg.PoolClient, row: RunRow) {
  if (row.state === 'running' && row.expired) {
    const expired = await writeFailure(tx, row.id, new DomainError(504, 'AI_TEMPLATE_TIMEOUT'));
    if (expired) return expired;
    const current = await tx.query<RunRow>(`SELECT ${fields} FROM ai_template_runs WHERE id=$1`, [row.id]);
    return current.rows[0]!;
  }
  return row;
}

export function runData(row: RunRow) {
  if (row.state === 'failed') throw new DomainError(row.error_status!, row.error_code!);
  const base = { runId: row.id, sceneKey: row.scene_key, itemKey: row.item_key, templateVersion: row.template_version };
  if (row.state === 'running') return { ...base, state: 'running' as const };
  const result = row.scene_key === 'note_outline'
    ? { noteId: row.note_id!, sourceRevision: row.source_revision!, outlineMarkdown: row.result_text! }
    : { text: row.result_text! };
  return { ...base, state: 'succeeded' as const, result };
}

export class AiTemplateRuns {
  constructor(private readonly pool: pg.Pool) {}

  list(scene: SceneKey, parentKey: string | undefined, scope: Scope) {
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      const { catalog, revision } = await readPublished(tx, scene);
      return { sceneKey: scene, parentKey: parentKey ?? null, revision, ...listCatalog(catalog, parentKey) };
    });
  }

  begin(scope: Scope, workspaceId: string, key: string, request: RunRequest, executorAvailable: boolean) {
    const requestHash = digest(canonical(request));
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      await assertWorkspace(tx, scope, workspaceId);
      await lock(tx, canonical(['ai-template', scope.userId, workspaceId.toLowerCase(), key]));
      const { rows: [previous] } = await tx.query<RunRow>(
        `SELECT ${fields} FROM ai_template_runs WHERE user_id=$1 AND workspace_id=$2 AND idempotency_key=$3`,
        [scope.userId, workspaceId, key],
      );
      if (previous) {
        if (previous.request_hash !== requestHash) throw new DomainError(409, 'IDEMPOTENCY_CONFLICT');
        if (previous.note_id) await readSource(tx, workspaceId, previous.note_id);
        return { run: await expireRun(tx, previous) };
      }

      const { catalog, revision } = await readPublished(tx, request.sceneKey);
      const template = visibleTemplates(catalog).find(item => item.itemKey === request.itemKey);
      if (!template) throw new DomainError(404, 'AI_TEMPLATE_UNAVAILABLE');
      if (!executorAvailable) throw new DomainError(503, 'AI_TEMPLATE_EXECUTOR_UNAVAILABLE');

      let noteId: string | null = null;
      let sourceRevision: string | null = null;
      let sourceTitle = '';
      let text: string;
      if (request.sceneKey === 'note_outline') {
        const source = await readSource(tx, workspaceId, request.input.noteId, true);
        assertSourceRevision(source, request.input.sourceRevision);
        noteId = request.input.noteId;
        sourceRevision = source.part_revision_id;
        sourceTitle = source.title;
        text = source.content_markdown;
      } else {
        text = request.input.text;
      }
      if (!text.trim() || text.length > MaxSourceChars || text.includes('\u0000')) {
        throw new DomainError(400, 'AI_TEMPLATE_SOURCE_INVALID');
      }
      const prompt = renderPrompt(template, sourceTitle).trim();
      if (!prompt || prompt.length > MaxPromptChars + 2_000 || prompt.includes('\u0000')) {
        throw new DomainError(400, 'AI_TEMPLATE_PROMPT_INVALID');
      }
      const { rows: [run] } = await tx.query<RunRow>(
        `INSERT INTO ai_template_runs (id, user_id, workspace_id, scene_key, item_key, template_version,
          note_id, source_revision, idempotency_key, request_hash, trace_id, deadline_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp()+$12*interval '1 millisecond')
         RETURNING ${fields}`,
        [randomUUID(), scope.userId, workspaceId, request.sceneKey, template.itemKey, revision,
          noteId, sourceRevision, key, requestHash, scope.traceId, RunTimeoutMs + 5_000],
      );
      return { run: run!, input: { prompt, text } };
    });
  }

  complete(scope: Scope, workspaceId: string, run: RunRow, text: string, signal: AbortSignal) {
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      await assertWorkspace(tx, scope, workspaceId);
      if (run.note_id) assertSourceRevision(await readSource(tx, workspaceId, run.note_id), run.source_revision!);
      signal.throwIfAborted();
      const { rows: [row] } = await tx.query<RunRow>(
        `UPDATE ai_template_runs SET state='succeeded', result_text=$2, finished_at=clock_timestamp()
         WHERE id=$1 AND state='running' AND deadline_at>clock_timestamp() RETURNING ${fields}`, [run.id, text],
      );
      if (!row) throw new DomainError(504, 'AI_TEMPLATE_TIMEOUT');
      return row;
    });
  }

  async fail(runId: string, error: DomainError) {
    await transaction(this.pool, tx => writeFailure(tx, runId, error));
  }

  get(scope: Scope, workspaceId: string, runId: string) {
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      await assertWorkspace(tx, scope, workspaceId);
      const { rows: [row] } = await tx.query<RunRow>(
        `SELECT ${fields} FROM ai_template_runs WHERE id=$1 AND workspace_id=$2 AND user_id=$3`,
        [runId, workspaceId, scope.userId],
      );
      if (!row) throw new DomainError(404, 'AI_TEMPLATE_RUN_NOT_FOUND');
      if (row.note_id) await readSource(tx, workspaceId, row.note_id);
      return expireRun(tx, row);
    });
  }

  outlineResults(scope: Scope, workspaceId: string, noteId: string) {
    return transaction(this.pool, async tx => {
      await assertScope(tx, scope);
      await assertWorkspace(tx, scope, workspaceId);
      const source = await readSource(tx, workspaceId, noteId);
      const { rows } = await tx.query<{ id: string; item_key: string; template_version: number; finished_at: Date }>(
        `SELECT DISTINCT ON (item_key) id, item_key, template_version, finished_at FROM ai_template_runs
         WHERE workspace_id=$1 AND note_id=$2 AND source_revision=$3 AND user_id=$4
           AND scene_key='note_outline' AND state='succeeded'
         ORDER BY item_key, finished_at DESC, id DESC`, [workspaceId, noteId, source.part_revision_id, scope.userId],
      );
      return {
        noteId,
        sourceRevision: source.part_revision_id,
        items: rows.map(row => ({
          runId: row.id, itemKey: row.item_key, templateVersion: row.template_version, generatedAt: row.finished_at.toISOString(),
        })),
      };
    });
  }
}
