import type { TocItem } from './types.js';

/** Add an address for text that doesn't have an author-supplied heading. */
export function readingToc(content: string, headings: TocItem[]): TocItem[] {
  const kind = headings.length ? 'preamble' : 'body';
  const sourceEnd = headings[0]?.sourceStart ?? content.length;
  if (!content.slice(0, sourceEnd).trim()) return headings;
  return [{
    sectionId: `section-${kind}`, kind, title: kind === 'preamble' ? '开头' : '正文',
    level: 0, anchor: '', headingPath: [], sourceStart: 0, sourceEnd, children: [],
  }, ...headings];
}

export function findTocItem<T extends TocItem & { children: T[] }>(items: T[], sectionId: string): T | undefined {
  for (const item of items) {
    if (item.sectionId === sectionId) return item;
    const child = findTocItem(item.children, sectionId);
    if (child) return child;
  }
  return undefined;
}
