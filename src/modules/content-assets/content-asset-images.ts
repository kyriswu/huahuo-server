import type pg from 'pg';
import { kbImages } from '../../lib/kb-images.js';
import { DomainError, type Scope } from '../identity/store.js';
import {replaceResourceRefs} from '../storage/references.js';

export interface ContentAssetResourceRef { resourceId: string; usage: string; anchor?: string | null; alt?: string | null }
const MAX_REFS = 1000;
const imageUuid = (value: string) => /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(value);
function parseContentAssetImages(content: string) {
  try { return kbImages(content); }
  catch { throw new DomainError(400, 'CONTENT_ASSET_IMAGE_MARKDOWN_INVALID'); }
}

export function inlineContentAssetRefs(parts: Record<string, string>): ContentAssetResourceRef[] {
  const refs = new Map<string, ContentAssetResourceRef>();
  for (const [part, text] of Object.entries(parts)) for (const image of parseContentAssetImages(text)) {
    const id = image.resourceId;
    refs.set(`${part}:${id}`, { resourceId: id, usage: 'inline-image', anchor: part, alt: image.alt });
  }
  return [...refs.values()];
}

const refKey = (ref: ContentAssetResourceRef) => JSON.stringify([ref.resourceId, ref.usage, ref.anchor ?? null, ref.alt ?? null]);
const refIdentity = (ref: ContentAssetResourceRef) => JSON.stringify([ref.resourceId.toLowerCase(), ref.usage, ref.anchor ?? null]);
export async function syncContentAssetRefs(tx: pg.PoolClient, scope: Scope, workspaceId: string, contentAssetId: string, parts: Record<string, string>, declared?: ContentAssetResourceRef[]): Promise<boolean> {
  const old = (await tx.query<{ resource_id: string; usage: string; anchor: string | null; alt: string | null }>(
    'SELECT resource_id,usage,anchor,alt FROM content_asset_resource_refs WHERE content_asset_id=$1 ORDER BY ref_order', [contentAssetId])).rows
    .map(row => ({ resourceId: row.resource_id, usage: row.usage, anchor: row.anchor, alt: row.alt }));
  const wanted = new Map<string, ContentAssetResourceRef>();
  // Inline pins are derived from the complete current body, never from a stale
  // client-supplied resourceRefs array. Unmentioned attachments remain attached.
  for (const ref of [...(declared ?? old).filter(ref => ref.usage !== 'inline-image'), ...inlineContentAssetRefs(parts)]) wanted.set(refIdentity(ref), { ...ref, resourceId: ref.resourceId.toLowerCase() });
  const refs = [...wanted.values()], ids = [...new Set(refs.map(ref => ref.resourceId))].sort();
  if (refs.length > MAX_REFS || ids.some(id => !imageUuid(id))) throw new DomainError(400, 'CONTENT_ASSET_RESOURCE_REFS_INVALID');
  if (ids.length) {
    const owned = (await tx.query<{ resource_id: string; mime_type: string }>(`SELECT r.resource_id,r.mime_type FROM resources r
      JOIN workspaces w ON w.id=$3 AND w.user_id=r.user_id AND w.state='ready'
      WHERE r.resource_id=ANY($1::uuid[]) AND r.user_id=$2 AND r.status='ready'
      ORDER BY r.resource_id FOR UPDATE OF r FOR SHARE OF w`, [ids, scope.userId, workspaceId])).rows;
    if (owned.length !== ids.length) throw new DomainError(404, 'RESOURCE_NOT_FOUND');
    const images = new Set(refs.filter(ref => ref.usage === 'inline-image').map(ref => ref.resourceId));
    if (owned.some(row => images.has(row.resource_id) && !row.mime_type.startsWith('image/'))) throw new DomainError(409, 'CONTENT_ASSET_RESOURCE_NOT_IMAGE');
  }
  if (JSON.stringify(old.map(refKey)) === JSON.stringify(refs.map(refKey))) return false;
  await tx.query('DELETE FROM content_asset_resource_refs WHERE content_asset_id=$1', [contentAssetId]);
  if (refs.length) await tx.query(`INSERT INTO content_asset_resource_refs(content_asset_id,resource_id,ref_order,usage,anchor,alt)
    SELECT $1,x.id,x.ord-1,x.usage,x.anchor,x.alt FROM unnest($2::uuid[],$3::text[],$4::text[],$5::text[]) WITH ORDINALITY x(id,usage,anchor,alt,ord)`,
  [contentAssetId, refs.map(ref => ref.resourceId), refs.map(ref => ref.usage), refs.map(ref => ref.anchor ?? null), refs.map(ref => ref.alt ?? null)]);
  await replaceResourceRefs(tx,scope.userId,'content_asset',contentAssetId,ids,workspaceId);
  return true;
}
