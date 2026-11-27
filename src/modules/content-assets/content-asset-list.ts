import type pg from 'pg';
import MarkdownIt from 'markdown-it';
import { DomainError } from '../identity/store.js';
import { assetKinds, type AssetKind } from '../../contracts/asset-kind.js';
import type { ContentStatus } from '../../contracts/content-status.js';

export const CONTENT_ASSET_PAGE_SIZE = 20;
export const CONTENT_ASSET_PREVIEW_LENGTH = 200;
const previewSourceLength = 2048;
const markdown = new MarkdownIt({ html: true });
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
interface Cursor { assetKind?: string; userId: string; updatedAt: string; contentAssetId: string }

function decodeCursor(value: string | undefined, userId: string, assetKind?: string): Cursor | undefined {
  if (value === undefined) return;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/u.test(value)) throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const cursor: unknown = JSON.parse(bytes.toString('utf8'));
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new Error();
    const c = cursor as Record<string, unknown>;
    if (Object.keys(c).length !== (assetKind === undefined ? 3 : 4) || c.assetKind !== assetKind || c.userId !== userId || typeof c.contentAssetId !== 'string' || !uuid.test(c.contentAssetId)
      || typeof c.updatedAt !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(c.updatedAt)) throw new Error();
    // Validate the calendar date while preserving the SQL timestamp's microseconds.
    if (new Date(c.updatedAt).toISOString() !== `${c.updatedAt.slice(0, 23)}Z`) throw new Error();
    return { userId, updatedAt: c.updatedAt, contentAssetId: c.contentAssetId };
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
  content_asset_id: string; active_folder_id: string | null; title: string; state: string; content_asset_revision_id: string;
  etag: string; asset_kind: AssetKind; processing_status: ContentStatus; source_kind: string; source_id: string | null; created_at: Date; updated_at: Date;
  cursor_updated_at: string; content_cursor: string; preview_markdown: string | null;
}

/** Called after session authorization, on the same transaction connection. */
export async function listContentAssetPage(tx: pg.PoolClient, userId: string, cursor?: string, selectedKinds?: AssetKind[]) {
  const kinds = selectedKinds && [...new Set(selectedKinds)].sort();
  // Single selections retain the assetKind value encoded by older cursors.
  const assetKind = kinds?.join(',');
  const after = decodeCursor(cursor, userId, assetKind);
  // The time upper bound lets content_assets_scope start at the requested page, including
  // deep pages. The UUID breaks timestamp ties without depending on anchor existence.
  const boundary = after ? 'AND asset.updated_at <= $2::timestamptz AND (asset.updated_at < $2::timestamptz OR asset.content_asset_id > $3::uuid)' : '';
  const params: (string | AssetKind[])[] = after ? [userId, after.updatedAt, after.contentAssetId] : [userId];
  const kindFilter = kinds === undefined ? '' : `AND asset.asset_kind = ANY($${params.push(kinds)}::text[])`;
  const result = await tx.query<ContentAssetListRow>(`SELECT page.*,
    coalesce((SELECT next_cursor::text FROM account_content_state WHERE user_id=$1), '0') AS content_cursor,
    folder.folder_id AS active_folder_id,
    part.preview_markdown
    FROM (
      SELECT asset.content_asset_id,asset.folder_id,asset.title,asset.state,asset.content_asset_revision_id,asset.etag,asset.asset_kind,asset.processing_status,asset.source_kind,asset.source_id,asset.created_at,asset.updated_at,
        to_char(asset.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at
      FROM content_assets asset
      WHERE asset.user_id=$1 AND asset.state='active' ${boundary} ${kindFilter}
      ORDER BY asset.updated_at DESC,asset.content_asset_id ASC LIMIT ${CONTENT_ASSET_PAGE_SIZE + 1}
    ) page
    LEFT JOIN asset_folders folder ON folder.folder_id=page.folder_id AND folder.user_id=$1 AND folder.state='active'
    LEFT JOIN LATERAL (
      SELECT left(content_markdown, ${previewSourceLength}) AS preview_markdown FROM content_asset_parts
      WHERE content_asset_id=page.content_asset_id AND part='raw'
    ) part ON true
    ORDER BY page.updated_at DESC,page.content_asset_id ASC`, params);
  const rows = result.rows.slice(0, CONTENT_ASSET_PAGE_SIZE);
  const last = rows.at(-1);
  return {
    assetKinds,
    items: rows.map(asset => ({
      contentAssetId: asset.content_asset_id, folderId: asset.active_folder_id, title: asset.title, state: asset.state,
      contentAssetRevisionId: asset.content_asset_revision_id, etag: asset.etag, contentCursor: asset.content_cursor,
      assetKind: asset.asset_kind, contentStatus: asset.processing_status,
      sourceKind: asset.source_kind, sourceRef: asset.source_id ? { kind: asset.source_kind, id: asset.source_id } : null,
      createdAt: asset.created_at.toISOString(), updatedAt: asset.updated_at.toISOString(), preview: preview(asset.preview_markdown ?? ''),
    })),
    nextCursor: result.rows.length > CONTENT_ASSET_PAGE_SIZE && last
      ? Buffer.from(JSON.stringify({ userId, assetKind, updatedAt: last.cursor_updated_at, contentAssetId: last.content_asset_id } satisfies Cursor)).toString('base64url')
      : null,
  };
}
