import { findTocItem } from '../../lib/document-processing/toc.js';
import type { TocItem, TocStatus } from '../../lib/document-processing/types.js';
import { DomainError } from '../identity/store.js';

export function requireTocSection<T extends TocItem & { children: T[] }>(tocStatus: TocStatus, toc: T[] | null, sectionId: string): T {
  if (tocStatus !== 'ready' || !toc) throw new DomainError(409, 'DOCUMENT_TOC_NOT_READY');
  const section = findTocItem(toc, sectionId);
  if (!section) throw new DomainError(404, 'DOCUMENT_SECTION_NOT_FOUND');
  return section;
}

export function sectionResult(section: TocItem, documentVersion: string, format: 'markdown' | 'text', content: string) {
  const { sectionId, kind, title, sourceStart, sourceEnd } = section;
  if (content.length !== sourceEnd - sourceStart) throw new DomainError(503, 'DOCUMENT_SECTION_UNAVAILABLE');
  return { sectionId, kind, title, sourceStart, sourceEnd, documentVersion, offsetUnit: 'utf16' as const, format, content };
}
