import { fromMarkdown } from 'mdast-util-from-markdown';
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: true });
export const imageUuid = (value: string) => /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
export const imageResourceId = (value: string): string | undefined => {
  const id = value.startsWith('asset://') ? value.slice(8) : value;
  return imageUuid(id) ? id.toLowerCase() : undefined;
};
interface Node {
  type: string; url?: string; identifier?: string; alt?: string | null; title?: string | null;
  children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } };
}
export interface MarkdownImage {
  url: string; alt: string; start: number; end: number;
  nodeStart: number; nodeEnd: number; kind: 'markdown' | 'html' | 'kbimage';
  replacementPrefix?: string; replacementSuffix?: string;
}

function destination(source: string, start: number, end: number, definition: boolean, expectedUrl: string) {
  const raw = source.slice(start, end);
  const state = new markdown.inline.State(raw, markdown, {}, []);
  const labelEnd = markdown.helpers.parseLinkLabel(state, definition ? 0 : 1, false);
  let at = labelEnd + 2;
  if (labelEnd < 0) throw new Error('MARKDOWN_IMAGE_POSITION_INVALID');
  let continuedLine = false;
  while (at < raw.length) {
    if (/\s/u.test(raw[at]!)) { continuedLine ||= raw[at] === '\n' || raw[at] === '\r'; at++; }
    else if (continuedLine && raw[at] === '>') at++; // CommonMark blockquote continuation.
    else break;
  }
  const parsed = markdown.helpers.parseLinkDestination(raw, at, raw.length);
  if (!parsed.ok || parsed.str !== expectedUrl) throw new Error('MARKDOWN_IMAGE_POSITION_INVALID');
  return { start: start + at + (raw[at] === '<' ? 1 : 0), end: start + parsed.pos - (raw[at] === '<' ? 1 : 0) };
}

function htmlImages(source: string, start: number, end: number, ignore: (start: number, end: number) => void): MarkdownImage[] {
  const result: MarkdownImage[] = [];
  let at = start;
  while (at < end) {
    at = source.indexOf('<', at);
    if (at < 0 || at >= end) break;
    const tail = source.slice(at, end);
    if (tail.startsWith('<!--') || tail.startsWith('<![CDATA[')) {
      const closing = tail.startsWith('<!--') ? '-->' : ']]>';
      const next = source.indexOf(closing, at);
      at = next < 0 ? end : next + closing.length;
      continue;
    }
    const tag = /^<\/?([a-z][a-z\d:-]*)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/iu.exec(tail);
    if (!tag) { at++; continue; }
    const name = tag[1]!.toLowerCase(), raw = tag[0], closing = raw.startsWith('</');
    if (!closing && ['script', 'style', 'pre', 'code', 'textarea'].includes(name)) {
      const close = new RegExp(`</${name}\\s*>`, 'giu'); close.lastIndex = at + raw.length;
      const matched = close.exec(source); ignore(at, matched ? close.lastIndex : source.length); at = matched ? close.lastIndex : end;
      continue;
    }
    if (!closing && (name === 'img' || name === 'kbimage')) {
      const wanted = name === 'img' ? 'src' : 'uuid';
      const attrs = [...raw.matchAll(/\s+([a-z_:][a-z\d_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu)];
      const values = attrs.filter(a => a[1]!.toLowerCase() === wanted);
      if (values.length > 1) throw new Error('MARKDOWN_IMAGE_ATTRIBUTE_DUPLICATE');
      const attr = values[0];
      if (attr) {
        const value = attr[2] ?? attr[3] ?? attr[4]!;
        const valueOffset = attr[0].indexOf('=') + 1;
        let offset = valueOffset;
        while (/\s/u.test(attr[0][offset] ?? '') && offset < attr[0].length) offset++;
        if (['"', "'"].includes(attr[0][offset]!)) offset++;
        const alt = attrs.find(a => a[1]!.toLowerCase() === 'alt');
        result.push({ url: name === 'kbimage' ? `asset://${value}` : markdown.utils.unescapeAll(value),
          alt: alt ? markdown.utils.unescapeAll(alt[2] ?? alt[3] ?? alt[4]!) : '',
          start: at + attr.index + offset, end: at + attr.index + offset + value.length,
          nodeStart: at, nodeEnd: at + raw.length, kind: name === 'img' ? 'html' : 'kbimage' });
      }
    }
    at += raw.length;
  }
  return result;
}

/** CommonMark positions address the unchanged input, including CRLF and emoji.
 * Only actual image nodes (or their definitions) are eligible for replacement.
 * Code, ordinary links, comments, and image-looking text are never rewritten.
 */
export function markdownImages(source: string): MarkdownImage[] {
  const tree: Node = fromMarkdown(source);
  const definitions = new Map<string, Node>(), shared = new Set<string>();
  const ignored: Array<{start: number; end: number}> = [], html = new Map<Node, MarkdownImage[]>();
  const visit = (node: Node, fn: (node: Node) => void) => { fn(node); for (const child of node.children ?? []) visit(child, fn); };
  visit(tree, node => {
    if (node.type === 'definition' && !definitions.has(node.identifier!)) definitions.set(node.identifier!, node);
    if (node.type === 'linkReference') shared.add(node.identifier!);
    if (node.type === 'html' && node.position?.start.offset !== undefined && node.position.end.offset !== undefined)
      html.set(node, htmlImages(source, node.position.start.offset, node.position.end.offset, (start, end) => ignored.push({start, end})));
  });
  const result: MarkdownImage[] = [];
  visit(tree, node => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === 'html') { result.push(...html.get(node)!); return; }
    if (node.type !== 'image' && node.type !== 'imageReference') return;
    const target = node.type === 'imageReference' ? definitions.get(node.identifier!) : node;
    if (!target?.url || target.position?.start.offset === undefined || target.position.end.offset === undefined) return;
    const span = destination(source, target.position.start.offset, target.position.end.offset, node.type === 'imageReference', target.url);
    if (node.type === 'imageReference' && shared.has(node.identifier!)) {
      // A definition shared with an ordinary link cannot be rewritten globally.
      // Expand just the image usage, preserving its original escaped alt label.
      const raw = source.slice(start, end), state = new markdown.inline.State(raw, markdown, {}, []);
      const labelEnd = markdown.helpers.parseLinkLabel(state, 1, false);
      result.push({url: target.url, alt: node.alt ?? '', start, end, nodeStart: start, nodeEnd: end, kind: 'markdown',
        replacementPrefix: raw.slice(0, labelEnd + 1) + '(<', replacementSuffix: '>' + (target.title ? ` "${target.title.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : '') + ')'});
    } else result.push({ ...span, url: target.url, alt: node.alt ?? '', nodeStart: start, nodeEnd: end, kind: 'markdown' });
  });
  return result.filter(image => !ignored.some(range => image.nodeStart >= range.start && image.nodeStart < range.end)).sort((a, b) => a.nodeStart - b.nodeStart);
}

/** Change only destination bytes, not surrounding Markdown, spacing, or OCR. */
export function rewriteImageUrls(source: string, images: readonly MarkdownImage[], replacements: ReadonlyMap<string, string>): string {
  const edits = new Map<number, { end: number; text: string }>();
  for (const image of images) {
    const next = replacements.get(image.url);
    if (!next) continue;
    if (image.kind === 'kbimage' && !next.startsWith('asset://')) continue; // UUID attributes remain UUIDs in views.
    const text = image.kind === 'kbimage' ? next.slice(8) : image.kind === 'html'
      ? next.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#39;').replaceAll('<', '&lt;') : next;
    edits.set(image.start, { end: image.end, text: (image.replacementPrefix ?? '') + text + (image.replacementSuffix ?? '') });
  }
  let result = source;
  for (const [start, edit] of [...edits].sort(([a], [b]) => b - a)) result = result.slice(0, start) + edit.text + result.slice(edit.end);
  return result;
}
