import { imageResourceId, markdownImages, rewriteImageUrls } from '../../lib/markdown-images.js';
import type { Scope } from '../identity/store.js';
import type { StorageService } from '../storage/service.js';

interface Part { contentMarkdown: string }
interface Note { parts: Record<string, Part> }

/** A response-only view: canonical Markdown and its hash never contain a token.
 * Run after idempotent writes so expiring URLs are not saved in receipts. */
export async function noteImageViews<T extends Note>(storage: StorageService, scope: Scope, workspaceId: string, notes: T[]) {
  const images = notes.map(note => Object.fromEntries(Object.entries(note.parts).map(([part, value]) => [part, markdownImages(value.contentMarkdown)])));
  const ids = [...new Set(images.flatMap(parts => Object.values(parts).flatMap(list => list.flatMap(image => imageResourceId(image.url) ? [imageResourceId(image.url)!] : []))))];
  const links = new Map<string, Awaited<ReturnType<StorageService['playbacks']>>[number]>();
  for (let offset = 0; offset < ids.length; offset += 1000)
    for (const link of await storage.playbacks(scope, ids.slice(offset, offset + 1000), workspaceId))
      if (link.mimeType.startsWith('image/')) links.set(link.resourceId, link);
  return notes.map((note, i) => ({ ...note, parts: Object.fromEntries(Object.entries(note.parts).map(([part, value]) => {
    const list = images[i]![part]!;
    const replacements = new Map(list.flatMap(image => {
      const link = links.get(imageResourceId(image.url) ?? '');
      return link ? [[image.url, link.url] as const] : [];
    }));
    return [part, { ...value, displayMarkdown: rewriteImageUrls(value.contentMarkdown, list, replacements),
      imageLinks: [...new Set(list.map(image => imageResourceId(image.url)).filter(id => id !== undefined))].flatMap(id => links.has(id) ? [links.get(id)!] : []) }];
  })) }));
}

export async function notePartImageView<T extends Part>(storage: StorageService, scope: Scope, workspaceId: string, part: T) {
  const [note] = await noteImageViews(storage, scope, workspaceId, [{ parts: { part } }]);
  return { ...part, ...note!.parts.part };
}
