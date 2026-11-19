import type pg from 'pg';
import MarkdownIt from 'markdown-it';
import { DomainError } from '../identity/store.js';

export const CONTENT_ASSET_PAGE_SIZE = 20;
export const CONTENT_ASSET_PREVIEW_LENGTH = 200;
const previewSourceLength = 2048;
const markdown = new MarkdownIt({ html: true });
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
interface Cursor { wid: string; updatedAt: string; contentAssetId: string }

function decodeCursor(value: string | undefined, wid: string): Cursor | undefined {
  if (value === undefined) return;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/u.test(value)) throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const cursor: unknown = JSON.parse(bytes.toString('utf8'));
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new Error();
    const c = cursor as Record<string, unknown>;
    if (Object.keys(c).length !== 3 || c.wid !== wid || typeof c.contentAssetId !== 'string' || !uuid.test(c.contentAssetId)
      || typeof c.updatedAt !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(c.updatedAt)) throw new Error();
    // Validate the calendar date while preserving the SQL timestamp's microseconds.
    if (new Date(c.updatedAt).toISOString() !== `${c.updatedAt.slice(0, 23)}Z`) throw new Error();
    return { wid, updatedAt: c.updatedAt, contentAssetId: c.contentAssetId };
  } catch {
    throw new DomainError(400, 'CONTENT_ASSET_CURSOR_INVALID');
  }
}

/** A bounded plain-text preview, not a generated summary or canonical contentAsset content. */
function preview(source: string): string {
  const text: string[] = [];
  const collect = (tokens: ReturnType<typeof markdown.parse>) => {
    for (const token of tokens) {
      if (token.children) collect(token.children);
      else if (['text', 'code_inline', 'code_block', 'fence'].includes(token.type)) text.push(token.content);
      if (token.block || token.type === 'softbreak' || token.type === 'hardbreak') text.push(' ');
    }
  };
  collect(markdown.parse(source, {}));
  return [...text.join('').replace(/\s+/gu, ' ').trim()].slice(0, CONTENT_ASSET_PREVIEW_LENGTH).join('');
}

interface ContentAssetListRow {
  content_asset_id: string; folder_id: string | null; title: string; state: string; content_asset_revision_id: string;
  etag: string; source_kind: string; source_id: string | null; created_at: Date; updated_at: Date;
  cursor_updated_at: string; content_cursor: string; preview_markdown: string | null;
}

/** Called after session/workspace authorization, on the same transaction connection. */
export async function listContentAssetPage(tx: pg.PoolClient, userId: string, wid: string, cursor?: string) {
  const after = decodeCursor(cursor, wid);
  // The time upper bound lets content_assets_scope start at the requested page, including
  // deep pages. The UUID breaks timestamp ties without depending on anchor existence.
  const boundary = after ? 'AND n.updated_at <= $3::timestamptz AND (n.updated_at < $3::timestamptz OR n.content_asset_id > $4::uuid)' : '';
  const result = await tx.query<ContentAssetListRow>(`SELECT page.*,
    coalesce((SELECT next_cursor::text FROM workspace_content_state WHERE workspace_id=$1), '0') AS content_cursor,
    (SELECT f.folder_id FROM content_asset_folders f JOIN asset_folders a ON a.folder_id=f.folder_id
      WHERE f.content_asset_id=page.content_asset_id AND a.workspace_id=$1 AND a.state='active' ORDER BY f.folder_id LIMIT 1) AS folder_id,
    part.preview_markdown
    FROM (
      SELECT n.content_asset_id,n.title,n.state,n.content_asset_revision_id,n.etag,n.source_kind,n.source_id,n.created_at,n.updated_at,
        to_char(n.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at
      FROM content_assets n JOIN content_asset_workspaces w ON w.content_asset_id=n.content_asset_id AND w.workspace_id=$1
      WHERE n.user_id=$2 AND n.state='active' ${boundary}
      ORDER BY n.updated_at DESC,n.content_asset_id ASC LIMIT ${CONTENT_ASSET_PAGE_SIZE + 1}
    ) page
    LEFT JOIN LATERAL (
      SELECT left(content_markdown, ${previewSourceLength}) AS preview_markdown FROM content_asset_parts
      WHERE content_asset_id=page.content_asset_id AND part='raw'
    ) part ON true
    ORDER BY page.updated_at DESC,page.content_asset_id ASC`, after ? [wid, userId, after.updatedAt, after.contentAssetId] : [wid, userId]);
  const rows = result.rows.slice(0, CONTENT_ASSET_PAGE_SIZE);
  const last = rows.at(-1);
  return {
    items: rows.map(n => ({
      contentAssetId: n.content_asset_id, workspaceId: wid, folderId: n.folder_id, title: n.title, state: n.state,
      contentAssetRevisionId: n.content_asset_revision_id, etag: n.etag, contentCursor: n.content_cursor,
      sourceKind: n.source_kind, sourceRef: n.source_id ? { kind: n.source_kind, id: n.source_id } : null,
      createdAt: n.created_at.toISOString(), updatedAt: n.updated_at.toISOString(), preview: preview(n.preview_markdown ?? ''),
    })),
    nextCursor: result.rows.length > CONTENT_ASSET_PAGE_SIZE && last
      ? Buffer.from(JSON.stringify({ wid, updatedAt: last.cursor_updated_at, contentAssetId: last.content_asset_id } satisfies Cursor)).toString('base64url')
      : null,
  };
}
