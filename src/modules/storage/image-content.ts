import type pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import { inputImages, normalizeImageTags } from '../../lib/markdown-images.js';
import { DomainError, type Scope } from '../identity/store.js';
import type { NormalizedImageParts } from './image-origins.js';
import type { ResourceClaims } from './resource-claims.js';
import { ownedObjectKey } from './object-locator.js';
export { restoreOwnedImageParts, type NormalizedImageParts, type ImageOrigin } from './image-origins.js';

const MAX_REFS = 1000;
const imageUuid = (value: string) => /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(value);
function parseInputImages(content: string) {
  try { return inputImages(content); }
  catch { throw new DomainError(400, 'IMAGE_MARKDOWN_INVALID'); }
}

/** URL signatures are never an identity or authorization source. Only known
 * first-party OSS objects are mapped, followed by an owned-resource lookup.
 * Unmapped images require an owned upload; file contents are never fetched here.
 */
function imageTarget(value: string, config?: AppConfig): { id?: string; key?: string } | undefined {
  const identity=value.split('#',1)[0]!;
  const candidate=identity.startsWith('asset://')?identity.slice(8):identity;
  const id=imageUuid(candidate)?candidate.toLowerCase():undefined;
  if (id) return { id };
  if (value.startsWith('asset://')) throw new DomainError(400, 'IMAGE_RESOURCE_INVALID');
  let url: URL;
  try { url = new URL(value); } catch { throw new DomainError(400, 'IMAGE_UPLOAD_REQUIRED'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new DomainError(400, 'IMAGE_UPLOAD_REQUIRED');
  if (!config) return undefined;
  try {
    const key = ownedObjectKey(value, config);
    return key === undefined ? undefined : { key };
  } catch { throw new DomainError(400, 'IMAGE_URL_INVALID'); }
}

export async function normalizeOwnedImageParts(tx: pg.PoolClient, scope: Scope, workspaceId: string, parts: Record<string, string>, config?: AppConfig, claims?: ResourceClaims): Promise<NormalizedImageParts> {
  const parsed = Object.entries(parts).map(([part, text]) => ({ part, text, images: parseInputImages(text) }));
  const imageCount = parsed.reduce((total, part) => total + part.images.length, 0);
  if (imageCount > MAX_REFS) throw new DomainError(400, 'IMAGE_LIMIT_EXCEEDED');
  if (!imageCount) return { parts: { ...parts }, imageOrigins: [] };
  const oss = config?.storageAliyunOss;
  if (config?.storageDriver !== 'aliyun-oss' || !oss) throw new DomainError(503, 'DIRECT_READ_NOT_CONFIGURED');
  const targets = new Map<string, { id?: string; key?: string }>();
  for (const part of parsed) for (const image of part.images) {
    const target = imageTarget(image.url, config);
    if (!target) throw new DomainError(400, 'IMAGE_UPLOAD_REQUIRED');
    targets.set(image.url, target);
  }
  const ids = [...new Set([...targets.values()].flatMap(target => target.id ? [target.id] : []))];
  const keys = [...new Set([...targets.values()].flatMap(target => target.key && imageUuid(target.key) ? [target.key] : []))];
  await claims?.ensure(tx, scope, workspaceId, [...ids, ...keys]);
  // Object keys are UUIDs in the current schema. Keep the typed equality indexed;
  // arbitrary filenames still fail the owned lookup without reaching a UUID cast.
  const rows = (await tx.query<{ resource_id: string; object_key: string; mime_type: string }>(`SELECT r.resource_id,r.object_key,r.mime_type
    FROM resources r JOIN workspaces w ON w.id=$2 AND w.user_id=r.user_id AND w.state='ready'
    WHERE r.user_id=$1 AND r.status='ready'
    AND r.storage_driver='aliyun-oss' AND r.storage_bucket=$5
    AND (r.resource_id=ANY($3::uuid[]) OR r.object_key=ANY($4::uuid[])) ORDER BY r.resource_id FOR UPDATE OF r FOR SHARE OF w`,
  [scope.userId, workspaceId, ids, keys, oss.bucket])).rows;
  const byId = new Map(rows.map(row => [row.resource_id, row])), byKey = new Map(rows.map(row => [String(row.object_key), row]));
  const replacements = new Map<string, string>();
  for (const [url, target] of targets) {
    const row = target.id ? byId.get(target.id) : byKey.get(target.key!);
    if (!row) throw new DomainError(404, 'RESOURCE_NOT_FOUND');
    if (!row.mime_type.startsWith('image/')) throw new DomainError(409, 'IMAGE_RESOURCE_NOT_IMAGE');
    replacements.set(url, row.resource_id);
  }
  return {
    parts: Object.fromEntries(parsed.map(part => [part.part, normalizeImageTags(part.text, part.images, replacements)])),
    imageOrigins: parsed.flatMap(part => part.images.flatMap((image, ordinal) => image.kind === 'kbimage' ? [] : [{
      part: part.part, ordinal, resourceId: replacements.get(image.url)!, format: image.kind,
      ...(image.sourceHash ? { hash: image.sourceHash } : {}),
    }])),
  };
}
