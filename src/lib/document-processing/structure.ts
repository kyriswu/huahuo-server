import MarkdownIt from 'markdown-it';
import { createHash } from 'node:crypto';
import { DocumentProcessingError, type DocumentStructure, type SectionNode, type SectionRange, type StructureOptions, type TocItem } from './types.js';

export const STRUCTURE_VERSION = 'markdown-ast-sections';
export const markdownParser = new MarkdownIt({ html: false, linkify: false });

/** Line positions are mapped to the original string, including CRLF/CR. */
export function sourceLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\r') { if (content[index + 1] === '\n') index += 1; offsets.push(index + 1); }
    else if (content[index] === '\n') offsets.push(index + 1);
  }
  return offsets;
}

function frontMatterEnd(content: string, offsets: number[]): number {
  const line = (index: number) => content.slice(offsets[index], offsets[index + 1] ?? content.length).trimEnd();
  if (line(0).replace(/^\uFEFF/u, '') !== '---') return 0;
  let first = 1;
  while (first < offsets.length && /^\s*(?:#.*)?$/u.test(line(first))) first += 1;
  // Require a YAML mapping so an opening horizontal rule in ordinary prose
  // doesn't hide real headings before a later horizontal rule.
  if (first === offsets.length || !/^\S[^:]*:(?:\s|$)/u.test(line(first))) return 0;
  for (let index = first + 1; index < offsets.length; index += 1) {
    if (['---', '...'].includes(line(index))) return offsets[index + 1] ?? content.length;
  }
  return 0;
}

/** Parse heading positions without rewriting the source or doing IO. */
export async function analyzeDocumentStructure(content: string, options: StructureOptions = {}): Promise<DocumentStructure> {
  const maxDepth = options.maxHeadingDepth ?? 6;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 6) throw new DocumentProcessingError('STRUCTURE_OPTIONS_INVALID', 'Heading depth must be between 1 and 6');
  const offsets = sourceLineOffsets(content);
  const roots: SectionNode[] = [];
  const stack: SectionNode[] = [];
  const ordered: SectionNode[] = [];
  const anchors = new Map<string, number>();
  const usedAnchors = new Set<string>();
  // The BOM is part of the stored source, but does not precede the first
  // Markdown token. Removing it for parsing keeps line positions intact.
  const tokens = options.format === 'text' ? [] : markdownParser.parse(content.replace(/^\uFEFF/u, ''), {});
  const metadataEnd = tokens.length ? frontMatterEnd(content, offsets) : 0;
  for (const [index, token] of tokens.entries()) {
    // A heading token inside a list/blockquote is ordinary nested content here.
    if (token.type !== 'heading_open' || token.level !== 0 || !token.map) continue;
    const level = Number(token.tag.slice(1));
    if (level > maxDepth) continue;
    const inline = tokens[index + 1];
    const title = inline?.children?.map(child => child.type === 'image' ? child.content : child.type === 'text' || child.type === 'code_inline' ? child.content : child.type === 'softbreak' ? ' ' : '').join('').trim() || inline?.content.trim() || '';
    const start = offsets[token.map[0]] ?? content.length;
    if (start < metadataEnd) continue;
    while (stack.length && stack.at(-1)!.level >= level) stack.pop()!.sourceEnd = start;
    const parent = stack.at(-1);
    const slug = title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/gu, '-') || 'section';
    let occurrence = anchors.get(slug) ?? 0;
    let anchor = occurrence ? `${slug}-${occurrence + 1}` : slug;
    while (usedAnchors.has(anchor)) { occurrence += 1; anchor = `${slug}-${occurrence + 1}`; }
    anchors.set(slug, occurrence + 1); usedAnchors.add(anchor);
    const sectionId = `section-${createHash('sha256').update(`${start}:${level}:${anchor}`).digest('hex').slice(0, 20)}`;
    const node: SectionNode = { sectionId, kind: 'heading', parentSectionId: parent?.sectionId ?? null, title, level, anchor, headingPath: [...(parent?.headingPath ?? []), title], sourceStart: start, sourceEnd: content.length, children: [] };
    (parent?.children ?? roots).push(node); ordered.push(node); stack.push(node);
  }
  const ranges: SectionRange[] = [];
  if (!ordered.length) { if (content.length) ranges.push({ sourceStart: 0, sourceEnd: content.length, sectionId: null, headingPath: [] }); }
  else {
    if (ordered[0]!.sourceStart > 0) ranges.push({ sourceStart: 0, sourceEnd: ordered[0]!.sourceStart, sectionId: null, headingPath: [] });
    for (const [index, section] of ordered.entries()) ranges.push({ sourceStart: section.sourceStart, sourceEnd: ordered[index + 1]?.sourceStart ?? content.length, sectionId: section.sectionId, headingPath: [...section.headingPath] });
  }
  const toc = (nodes: SectionNode[]): TocItem[] => nodes.map(node => ({ sectionId: node.sectionId, kind: node.kind, title: node.title, level: node.level, anchor: node.anchor, headingPath: [...node.headingPath], sourceStart: node.sourceStart, sourceEnd: node.sourceEnd, children: toc(node.children) }));
  return { toc: toc(roots), sections: roots, ranges, offsetUnit: 'utf16', version: STRUCTURE_VERSION };
}
