import { createHash } from 'node:crypto';
import { kbImages } from '../../lib/kb-images.js';
import { renderEditableKbImages } from '../../lib/kb-image-markdown.js';
import { DomainError } from '../identity/store.js';
import type { Scope } from '../identity/store.js';
import type { StorageService } from '../storage/service.js';

interface Part { contentMarkdown: string }
interface Note { parts: Record<string, Part> }

/** The client receives one editable Markdown field. Stored canonical content,
 * hashes and idempotency receipts never contain download tokens. */
export async function noteImageViews<T extends Note>(storage: StorageService, scope: Scope, workspaceId: string, notes: T[]) {
  const images = notes.map(note => Object.fromEntries(Object.entries(note.parts).map(([part, value]) => [part, kbImages(value.contentMarkdown)])));
  const ids = [...new Set(images.flatMap(parts => Object.values(parts).flatMap(list => list.map(image => image.resourceId))))];
  const links = new Map<string, Awaited<ReturnType<StorageService['playbacks']>>[number]>();
  for (let offset = 0; offset < ids.length; offset += 1000)
    for (const link of await storage.playbacks(scope, ids.slice(offset, offset + 1000), workspaceId))
      if (link.mimeType.startsWith('image/')) links.set(link.resourceId, link);
  return notes.map((note, i) => ({ ...note, parts: Object.fromEntries(Object.entries(note.parts).map(([part, value]) => {
    const list = images[i]![part]!;
    const replacements = new Map(list.flatMap(image => {
      const link = links.get(image.resourceId);
      return link ? [[image.resourceId, link.url] as const] : [];
    }));
    if (list.some(image => !replacements.has(image.resourceId))) throw new DomainError(503, 'NOTE_IMAGE_UNAVAILABLE');
    const contentMarkdown = renderEditableKbImages(value.contentMarkdown, list, replacements);
    return [part, { ...value, contentMarkdown,
      ...('contentSha256' in value ? { contentSha256: createHash('sha256').update(contentMarkdown).digest('hex') } : {}) }];
  })) }));
}

export async function notePartImageView<T extends Part>(storage: StorageService, scope: Scope, workspaceId: string, part: T) {
  const [note] = await noteImageViews(storage, scope, workspaceId, [{ parts: { part } }]);
  return { ...part, ...note!.parts.part };
}
