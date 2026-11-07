import { buffer } from 'node:stream/consumers';
import type { TocItem } from '../../lib/document-processing/types.js';
import { DomainError } from '../identity/store.js';
import type { StoragePort } from '../storage/port.js';

export interface CanonicalTocItem extends Omit<TocItem, 'children'> {
  byteStart: number;
  byteEnd: number;
  children: CanonicalTocItem[];
}

/** Convert ordered, nested UTF-16 ranges to UTF-8 byte positions in one pass. */
export function indexTocBytes(content: string, toc: TocItem[]): CanonicalTocItem[] {
  let offset = 0;
  let bytes = 0;
  function advance(end: number) {
    bytes += Buffer.byteLength(content.slice(offset, end), 'utf8');
    offset = end;
    return bytes;
  }
  function visit(item: TocItem): CanonicalTocItem {
    const byteStart = advance(item.sourceStart);
    const children = item.children.map(visit);
    return { ...item, byteStart, byteEnd: advance(item.sourceEnd), children };
  }
  return toc.map(visit);
}

export function publicToc(items: CanonicalTocItem[]): TocItem[] {
  return items.map(({ sectionId, kind, title, level, anchor, headingPath, sourceStart, sourceEnd, children }) => ({
    sectionId, kind, title, level, anchor, headingPath, sourceStart, sourceEnd, children: publicToc(children),
  }));
}

export async function readCanonicalSection(storage: Pick<StoragePort, 'read'>, key: string, section: CanonicalTocItem): Promise<string> {
  try {
    const { byteStart, byteEnd } = section;
    const bytes = await buffer(await storage.read(key, { start: byteStart, end: byteEnd - 1 }));
    if (bytes.length !== byteEnd - byteStart) throw new Error('Canonical byte range mismatch');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new DomainError(503, 'DOCUMENT_SECTION_UNAVAILABLE');
  }
}
