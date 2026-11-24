import type pg from 'pg';
import type { AssetKind } from '../../contracts/asset-kind.js';
import { assertScope, transaction, type Scope } from '../identity/store.js';
import { tablesForSource, type KbBuild, type KbSnapshot, type KbSourceType } from './types.js';

export { readSourceBody } from './repository.js';

export interface KbBuildFilters {
  documentKey?: string;
  filters?: {
    folderIds?: string[];
    tagIds?: string[];
    sourceKinds?: string[];
    assetKinds?: AssetKind[];
    from?: string;
    to?: string;
    timeField?: 'created_at' | 'updated_at';
  };
}

export interface KbPublishedBuild extends KbBuild {
  cursor_created_at: string;
  source_body?: string | null;
  source_uri?: string | null;
  chunk?: KbPublishedChunk;
}

export interface KbPublishedChunk {
  build_id: string;
  point_id: string;
  ordinal: number;
  source_start: number;
  source_end: number;
  content_hash: string;
  chunk_count: number;
}

interface BuildLookup {
  sourceType: 'content_asset' | 'file';
  input: KbBuildFilters;
  limit: number;
  cursor?: { createdAt: string; id: string };
  ids?: string[];
  includeBody?: boolean;
  match?: { pointIds: string[]; target: KbSnapshot['target'] };
}

export interface KbChunkCursor {
  buildId: string;
  ordinal: number;
}

interface ChunkLookup {
  sourceType: KbSourceType;
  buildIds: string[];
  limit: number;
  cursor?: KbChunkCursor;
}

export async function listPublishedBuilds(
  pool: pg.Pool, scope: Scope,
  { sourceType, input, limit, cursor, ids, includeBody = false, match }: BuildLookup,
): Promise<KbPublishedBuild[]> {
  const { builds, chunks } = tablesForSource(sourceType);
  const isAsset = sourceType === 'content_asset';
  return transaction(pool, async tx => {
    await assertScope(tx, scope);
    const values: unknown[] = [
      scope.userId, isAsset ? ['content_asset'] : ['file', 'text'], input.documentKey ?? null,
      cursor?.createdAt ?? null, cursor?.id ?? null, ids ?? null, match?.pointIds.length ?? ids?.length ?? limit,
    ];
    let sourceJoin = isAsset
      ? `JOIN content_assets asset ON asset.content_asset_id=b.source_id AND asset.user_id=b.user_id AND asset.state='active' AND asset.processing_status='ready'
         JOIN content_asset_parts p ON p.content_asset_id=asset.content_asset_id AND p.part='raw' AND p.part_revision_id::text=b.source_revision`
      : `LEFT JOIN rag_ingestion_versions v ON b.source_type='file' AND v.id=b.source_id AND v.user_id=b.user_id AND v.workspace_id=b.workspace_id AND v.content_hash=b.source_revision AND v.active AND v.deleted_at IS NULL AND v.status='SUCCEEDED'
         LEFT JOIN text_ingestion_jobs j ON b.source_type='text' AND j.id=b.source_id AND j.created_by=b.user_id AND j.workspace_id=b.workspace_id AND j.content_hash=b.source_revision AND j.ingest_status='success'`;
    if (isAsset) {
      const { folderIds, sourceKinds, tagIds, assetKinds, from, to, timeField } = input.filters ?? {};
      const timestampColumn = timeField === 'created_at' ? 'asset.created_at' : 'asset.updated_at';
      if (folderIds?.length) sourceJoin += ` AND asset.folder_id=ANY($${values.push(folderIds)}::uuid[])
        AND EXISTS(SELECT 1 FROM asset_folders f WHERE f.folder_id=asset.folder_id AND f.user_id=asset.user_id AND f.state='active')`;
      if (sourceKinds?.length) sourceJoin += ` AND asset.source_kind=ANY($${values.push(sourceKinds)}::text[])`;
      if (tagIds?.length) sourceJoin += ` AND EXISTS(SELECT 1 FROM content_asset_tags membership JOIN asset_tags at ON at.tag_id=membership.tag_id AND at.user_id=b.user_id WHERE membership.content_asset_id=asset.content_asset_id AND membership.tag_id=ANY($${values.push(tagIds)}::uuid[]))`;
      if (assetKinds?.length) sourceJoin += ` AND asset.asset_kind=ANY($${values.push(assetKinds)}::text[])`;
      if (from) sourceJoin += ` AND date_trunc('milliseconds',${timestampColumn}) >= $${values.push(new Date(from).toISOString())}::timestamptz`;
      if (to) sourceJoin += ` AND date_trunc('milliseconds',${timestampColumn}) <= $${values.push(new Date(to).toISOString())}::timestamptz`;
    }
    let chunkProjection = '', matchedTarget = '';
    if (match) {
      sourceJoin += ` JOIN ${chunks} c ON c.build_id=b.id AND c.index_status='ready' AND c.point_id=ANY($${values.push(match.pointIds)}::text[])`;
      chunkProjection = ",to_jsonb(c)||jsonb_build_object('chunk_count', b.chunk_count) AS chunk";
      matchedTarget = ` AND b.snapshot #>> '{target,collection}'=$${values.push(match.target.collection)}
        AND b.snapshot #>> '{target,database}'=$${values.push(match.target.database)}
        AND b.snapshot #>> '{target,connectionId}'=$${values.push(match.target.connectionId)}`;
    }
    const revisionProjection = isAsset ? ',asset.content_asset_revision_id::text AS content_asset_revision_id' : '';
    const bodyProjection = isAsset ? ',p.content_markdown AS source_body' : ',j.raw_content AS source_body,v.canonical_content_uri AS source_uri';
    const workspaceJoin = isAsset ? '' : "JOIN workspaces w ON w.id=b.workspace_id AND w.user_id=b.user_id AND w.state='ready'";
    const activeSource = isAsset ? '' : 'AND (v.id IS NOT NULL OR j.id IS NOT NULL)';
    return (await tx.query<KbPublishedBuild>(`
      SELECT b.*,to_char(b.created_at,'YYYY-MM-DD HH24:MI:SS.USOF') AS cursor_created_at
        ${revisionProjection}${includeBody ? bodyProjection : ''}${chunkProjection}
      FROM ${builds} b ${workspaceJoin} ${sourceJoin}
      WHERE b.user_id=$1 AND b.source_type=ANY($2::text[]) AND ($3::text IS NULL OR b.source_id::text=$3)
        AND ($4::timestamptz IS NULL OR (b.created_at,b.id)<($4::timestamptz,$5::uuid))
        AND ($6::uuid[] IS NULL OR b.id=ANY($6::uuid[])) ${activeSource}
        AND b.published AND b.status='ready'${matchedTarget}
      ORDER BY b.created_at DESC,b.id DESC LIMIT $7`, values)).rows;
  });
}

export async function listPublishedChunks(
  pool: pg.Pool, scope: Scope, { sourceType, buildIds, limit, cursor }: ChunkLookup,
): Promise<KbPublishedChunk[]> {
  const tables = tablesForSource(sourceType);
  return transaction(pool, async tx => {
    await assertScope(tx, scope);
    return (await tx.query<KbPublishedChunk>(`
      SELECT c.*,b.chunk_count FROM ${tables.chunks} c JOIN ${tables.builds} b ON b.id=c.build_id
      WHERE c.build_id=ANY($1::uuid[]) AND b.user_id=$2 AND b.published AND b.status='ready' AND c.index_status='ready'
        AND ($3::uuid IS NULL OR (c.build_id,c.ordinal)>($3::uuid,$4::integer))
      ORDER BY c.build_id,c.ordinal LIMIT $5`,
    [buildIds, scope.userId, cursor?.buildId ?? null, cursor?.ordinal ?? null, limit])).rows;
  });
}
