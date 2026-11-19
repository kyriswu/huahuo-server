import { createHash } from 'node:crypto';
import { kbImages } from '../../lib/kb-images.js';
import { renderEditableKbImages } from '../../lib/kb-image-markdown.js';
import { DomainError } from '../identity/store.js';
import type { Scope } from '../identity/store.js';
import type { StorageService } from '../storage/service.js';

interface Part { contentMarkdown: string }
interface ContentAsset { parts: Record<string, Part> }

/** The client receives one editable Markdown field. Stored canonical content,
 * hashes and idempotency receipts never contain download tokens. */
export async function contentAssetImageViews<T extends ContentAsset>(storage: StorageService, scope: Scope, contentAssets: T[]) {
  const images = contentAssets.map(contentAsset => Object.fromEntries(Object.entries(contentAsset.parts).map(([part, value]) => [part, kbImages(value.contentMarkdown)])));
  const ids = [...new Set(images.flatMap(parts => Object.values(parts).flatMap(list => list.map(image => image.resourceId))))];
  const links = new Map<string, Awaited<ReturnType<StorageService['playbacks']>>[number]>();
  for (let offset = 0; offset < ids.length; offset += 1000)
    for (const link of await storage.playbacks(scope, ids.slice(offset, offset + 1000)))
      if (link.mimeType.startsWith('image/')) links.set(link.resourceId, link);
  return contentAssets.map((contentAsset, i) => ({ ...contentAsset, parts: Object.fromEntries(Object.entries(contentAsset.parts).map(([part, value]) => {
    const list = images[i]![part]!;
    const replacements = new Map(list.flatMap(image => {
      const link = links.get(image.resourceId);
      return link ? [[image.resourceId, link.url] as const] : [];
    }));
    if (list.some(image => !replacements.has(image.resourceId))) throw new DomainError(503, 'CONTENT_ASSET_IMAGE_UNAVAILABLE');
    const contentMarkdown = renderEditableKbImages(value.contentMarkdown, list, replacements);
    return [part, { ...value, contentMarkdown,
      ...('contentSha256' in value ? { contentSha256: createHash('sha256').update(contentMarkdown).digest('hex') } : {}) }];
  })) }));
}

export async function contentAssetPartImageView<T extends Part>(storage: StorageService, scope: Scope, part: T) {
  const [contentAsset] = await contentAssetImageViews(storage, scope, [{ parts: { part } }]);
  return { ...part, ...contentAsset!.parts.part };
}
