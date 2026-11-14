import type pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import { imageResourceId, imageUuid, markdownImages, rewriteImageUrls } from '../../lib/markdown-images.js';
import { DomainError, type Scope } from '../identity/store.js';

export interface NoteResourceRef { resourceId: string; usage: string; anchor?: string | null; alt?: string | null }
const MAX_REFS = 1000;
export function parseNoteImages(content: string) {
  try { return markdownImages(content); }
  catch { throw new DomainError(400, 'NOTE_IMAGE_MARKDOWN_INVALID'); }
}

function objectPath(path: string, prefix: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(path).replace(/^\//u, ''); }
  catch { throw new DomainError(400, 'NOTE_IMAGE_URL_INVALID'); }
  if (decoded.includes('\\') || decoded.split('/').some(part => part === '..' || part === '.') || decoded.includes('//')) throw new DomainError(400, 'NOTE_IMAGE_URL_INVALID');
  const base = prefix.replace(/^\/+|\/+$/gu, '');
  if (base && !decoded.startsWith(base + '/')) throw new DomainError(404, 'RESOURCE_NOT_FOUND');
  return base ? decoded.slice(base.length + 1) : decoded;
}

/** URL signatures are never an identity or authorization source. Only known
 * first-party routes/objects are mapped, followed by an owned-resource lookup.
 * External HTTPS images remain external; this operation performs no network IO.
 */
function imageTarget(value: string, config?: AppConfig): { id?: string; key?: string } | undefined {
  const id = imageResourceId(value);
  if (id) return { id };
  if (value.startsWith('asset://')) throw new DomainError(400, 'NOTE_IMAGE_RESOURCE_INVALID');
  let url: URL;
  try { url = new URL(value); } catch { throw new DomainError(400, 'NOTE_IMAGE_UPLOAD_REQUIRED'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new DomainError(400, 'NOTE_IMAGE_UPLOAD_REQUIRED');
  if (!config) return undefined;
  const base = new URL(config.appPublicBaseUrl);
  if (url.origin === base.origin) {
    const match = /^\/api\/v1\/media\/resources\/([a-f\d-]{36})\/(?:object|playback)$/iu.exec(url.pathname);
    if (!match || !imageUuid(match[1]!)) throw new DomainError(400, 'NOTE_IMAGE_URL_INVALID');
    return { id: match[1]!.toLowerCase() };
  }
  const oss = config.storageAliyunOss;
  if (oss) {
    const endpoint = new URL(oss.endpoint);
    if (url.hostname === `${oss.bucket}.${endpoint.hostname}` || (endpoint.hostname.startsWith(oss.bucket + '.') && url.hostname === endpoint.hostname)) {
      if (url.port !== endpoint.port || url.protocol !== endpoint.protocol) throw new DomainError(400, 'NOTE_IMAGE_URL_INVALID');
      return { key: objectPath(url.pathname, oss.keyPrefix ?? '') };
    }
  }
  const s3 = config.storageS3;
  if (s3 && url.origin === new URL(s3.endpoint).origin) return { key: objectPath(url.pathname, `${s3.bucket}/huahuo`) };
  return undefined;
}

export async function normalizeNoteParts(tx: pg.PoolClient, scope: Scope, workspaceId: string, parts: Record<string, string>, config?: AppConfig): Promise<Record<string, string>> {
  const parsed = Object.entries(parts).map(([part, text]) => ({ part, text, images: parseNoteImages(text) }));
  if (parsed.reduce((total, part) => total + part.images.length, 0) > MAX_REFS) throw new DomainError(400, 'NOTE_IMAGE_LIMIT_EXCEEDED');
  const targets = new Map<string, { id?: string; key?: string }>();
  for (const part of parsed) for (const image of part.images) {
    const target = imageTarget(image.url, config);
    if (target) targets.set(image.url, target);
  }
  if (!targets.size) return { ...parts };
  const ids = [...new Set([...targets.values()].flatMap(target => target.id ? [target.id] : []))];
  const keys = [...new Set([...targets.values()].flatMap(target => target.key ? [target.key] : []))];
  // The object-key lookup also works when the locator later becomes a prefixed
  // string. No UUID is guessed from an arbitrary filename or CDN URL.
  const rows = (await tx.query<{ resource_id: string; object_key: string; mime_type: string }>(`SELECT r.resource_id,r.object_key,r.mime_type
    FROM resources r JOIN workspaces w ON w.id=r.workspace_id AND w.user_id=r.user_id AND w.state='ready'
    WHERE r.user_id=$1 AND r.workspace_id=$2 AND r.status='ready'
    AND (r.resource_id=ANY($3::uuid[]) OR r.object_key::text=ANY($4::text[])) ORDER BY r.resource_id FOR UPDATE OF r FOR SHARE OF w`,
  [scope.userId, workspaceId, ids, keys])).rows;
  const byId = new Map(rows.map(row => [row.resource_id, row])), byKey = new Map(rows.map(row => [String(row.object_key), row]));
  const replacements = new Map<string, string>();
  for (const [url, target] of targets) {
    const row = target.id ? byId.get(target.id) : byKey.get(target.key!);
    if (!row) throw new DomainError(404, 'RESOURCE_NOT_FOUND');
    if (!row.mime_type.startsWith('image/')) throw new DomainError(409, 'NOTE_RESOURCE_NOT_IMAGE');
    replacements.set(url, `asset://${row.resource_id}`);
  }
  return Object.fromEntries(parsed.map(part => [part.part, rewriteImageUrls(part.text, part.images, replacements)]));
}

export function inlineNoteRefs(parts: Record<string, string>): NoteResourceRef[] {
  const refs = new Map<string, NoteResourceRef>();
  for (const [part, text] of Object.entries(parts)) for (const image of parseNoteImages(text)) {
    const id = imageResourceId(image.url);
    if (id) refs.set(`${part}:${id}`, { resourceId: id, usage: 'inline-image', anchor: part, alt: image.alt });
  }
  return [...refs.values()];
}

const refKey = (ref: NoteResourceRef) => JSON.stringify([ref.resourceId, ref.usage, ref.anchor ?? null, ref.alt ?? null]);
const refIdentity = (ref: NoteResourceRef) => JSON.stringify([ref.resourceId.toLowerCase(), ref.usage, ref.anchor ?? null]);
export async function syncNoteRefs(tx: pg.PoolClient, scope: Scope, workspaceId: string, noteId: string, parts: Record<string, string>, declared?: NoteResourceRef[]): Promise<boolean> {
  const old = (await tx.query<{ resource_id: string; usage: string; anchor: string | null; alt: string | null }>(
    'SELECT resource_id,usage,anchor,alt FROM note_resource_refs WHERE note_id=$1 ORDER BY ref_order', [noteId])).rows
    .map(row => ({ resourceId: row.resource_id, usage: row.usage, anchor: row.anchor, alt: row.alt }));
  const wanted = new Map<string, NoteResourceRef>();
  // Inline pins are derived from the complete current body, never from a stale
  // client-supplied resourceRefs array. Unmentioned attachments remain attached.
  for (const ref of [...(declared ?? old).filter(ref => ref.usage !== 'inline-image'), ...inlineNoteRefs(parts)]) wanted.set(refIdentity(ref), { ...ref, resourceId: ref.resourceId.toLowerCase() });
  const refs = [...wanted.values()], ids = [...new Set(refs.map(ref => ref.resourceId))].sort();
  if (refs.length > MAX_REFS || ids.some(id => !imageUuid(id))) throw new DomainError(400, 'NOTE_RESOURCE_REFS_INVALID');
  if (ids.length) {
    const owned = (await tx.query<{ resource_id: string; mime_type: string }>(`SELECT r.resource_id,r.mime_type FROM resources r
      JOIN workspaces w ON w.id=r.workspace_id AND w.user_id=r.user_id AND w.state='ready'
      WHERE r.resource_id=ANY($1::uuid[]) AND r.user_id=$2 AND r.workspace_id=$3 AND r.status='ready'
      ORDER BY r.resource_id FOR UPDATE OF r FOR SHARE OF w`, [ids, scope.userId, workspaceId])).rows;
    if (owned.length !== ids.length) throw new DomainError(404, 'RESOURCE_NOT_FOUND');
    const images = new Set(refs.filter(ref => ref.usage === 'inline-image').map(ref => ref.resourceId));
    if (owned.some(row => images.has(row.resource_id) && !row.mime_type.startsWith('image/'))) throw new DomainError(409, 'NOTE_RESOURCE_NOT_IMAGE');
  }
  if (JSON.stringify(old.map(refKey)) === JSON.stringify(refs.map(refKey))) return false;
  await tx.query('DELETE FROM note_resource_refs WHERE note_id=$1', [noteId]);
  if (refs.length) await tx.query(`INSERT INTO note_resource_refs(note_id,resource_id,ref_order,usage,anchor,alt)
    SELECT $1,x.id,x.ord-1,x.usage,x.anchor,x.alt FROM unnest($2::uuid[],$3::text[],$4::text[],$5::text[]) WITH ORDINALITY x(id,usage,anchor,alt,ord)`,
  [noteId, refs.map(ref => ref.resourceId), refs.map(ref => ref.usage), refs.map(ref => ref.anchor ?? null), refs.map(ref => ref.alt ?? null)]);
  await tx.query("DELETE FROM resource_refs WHERE user_id=$1 AND workspace_id=$2 AND ref_kind='note' AND ref_id_external=$3 AND NOT(resource_id=ANY($4::uuid[]))", [scope.userId, workspaceId, noteId, ids]);
  if (ids.length) await tx.query(`INSERT INTO resource_refs(resource_id,user_id,workspace_id,ref_kind,ref_id_external)
    SELECT id,$2,$3,'note',$4 FROM unnest($1::uuid[]) x(id) ON CONFLICT DO NOTHING`, [ids, scope.userId, workspaceId, noteId]);
  return true;
}

/** Historical Markdown is still readable: its images retain pins until that
 * revision is explicitly retired, instead of disappearing on a later edit. */
export async function pinPartImages(tx: pg.PoolClient, scope: Scope, workspaceId: string, revisionId: string, content: string) {
  const ids = [...new Set(inlineNoteRefs({ part: content }).map(ref => ref.resourceId))];
  if (ids.length) await tx.query(`INSERT INTO resource_refs(resource_id,user_id,workspace_id,ref_kind,ref_id_external)
    SELECT id,$2,$3,'note_revision',$4 FROM unnest($1::uuid[]) x(id) ON CONFLICT DO NOTHING`, [ids, scope.userId, workspaceId, revisionId]);
}
