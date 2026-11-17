import { fromMarkdown } from 'mdast-util-from-markdown';
import MarkdownIt from 'markdown-it';
import { kbImages, kbImageTag } from './kb-images.js';

const markdown = new MarkdownIt({ html: true });
interface Node {
  type: string; url?: string; identifier?: string; alt?: string | null; title?: string | null;
  children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } };
}
export interface InputImage {
  url: string; alt: string; title?: string;
  nodeStart: number; nodeEnd: number; kind: 'markdown' | 'html' | 'kbimage';
  width?: string; height?: string;
  sourceHash?: string;
  imageOnlyDefinitions?: readonly { start: number; end: number }[];
}

function htmlImages(source: string, start: number, end: number, protectedImages: readonly InputImage[], ignore: (start: number, end: number) => void): InputImage[] {
  const result: InputImage[] = [];
  let at = start;
  while (at < end) {
    at = source.indexOf('<', at);
    if (at < 0 || at >= end) break;
    const protectedImage = protectedImages.find(image => image.nodeStart <= at && image.nodeEnd > at);
    if (protectedImage) { at = protectedImage.nodeEnd; continue; }
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
    if (!closing && name === 'img') {
      const attrs = [...raw.matchAll(/\s+([a-z_:][a-z\d_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu)];
      const values = (key: string) => attrs.filter(attr => attr[1]!.toLowerCase() === key);
      for (const key of ['src', 'alt', 'title', 'width', 'height']) if (values(key).length > 1) throw new Error('MARKDOWN_IMAGE_ATTRIBUTE_DUPLICATE');
      const value = (key: string) => { const attr = values(key)[0]; return attr ? markdown.utils.unescapeAll(attr[2] ?? attr[3] ?? attr[4]!) : undefined; };
      const url = value('src');
      if (url === undefined || !url) throw new Error('MARKDOWN_IMAGE_SOURCE_REQUIRED');
      result.push({ url, alt: value('alt') ?? '', nodeStart: at, nodeEnd: at + raw.length, kind: 'html',
        ...(value('title') !== undefined ? { title: value('title')! } : {}),
        ...(value('width') !== undefined ? { width: value('width')! } : {}),
        ...(value('height') !== undefined ? { height: value('height')! } : {}),
      });
    }
    at += raw.length;
  }
  return result;
}

/** Write-side input adapter. CommonMark is parsed only while accepting content;
 * stored content and query/display paths use the canonical KBIMAGE scanner. */
export function inputImages(source: string): InputImage[] {
  const canonical: InputImage[] = kbImages(source).map(image => ({ url: `asset://${image.resourceId}`, alt: image.alt,
    nodeStart: image.nodeStart, nodeEnd: image.nodeEnd, kind: 'kbimage' }));
  if (!source.includes('![') && !/<img\b/iu.test(source)) return canonical;
  const tree: Node = fromMarkdown(source);
  const definitions = new Map<string, Node[]>(), linkedDefinitions = new Set<string>();
  const ignored: Array<{ start: number; end: number }> = [], html = new Map<Node, InputImage[]>();
  const visit = (node: Node, fn: (node: Node) => void) => { fn(node); for (const child of node.children ?? []) visit(child, fn); };
  const protectedAt = (start: number) => canonical.some(image => image.nodeStart <= start && image.nodeEnd > start);
  visit(tree, node => {
    if (node.type === 'html' && node.position?.start.offset !== undefined && node.position.end.offset !== undefined)
      html.set(node, htmlImages(source, node.position.start.offset, node.position.end.offset, canonical, (start, end) => ignored.push({ start, end })));
    if (node.position?.start.offset !== undefined && protectedAt(node.position.start.offset)) return;
    if (node.type === 'definition') definitions.set(node.identifier!, [...definitions.get(node.identifier!) ?? [], node]);
    if (node.type === 'linkReference') linkedDefinitions.add(node.identifier!);
  });
  const result: InputImage[] = [];
  visit(tree, node => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === 'html') { result.push(...html.get(node)!); return; }
    if (protectedAt(start)) return;
    if (node.type !== 'image' && node.type !== 'imageReference') return;
    const referenced = node.type === 'imageReference' ? definitions.get(node.identifier!) : undefined;
    const target = node.type === 'imageReference' ? referenced?.[0] : node;
    if (!target?.url) throw new Error('MARKDOWN_IMAGE_SOURCE_REQUIRED');
    result.push({ url: target.url, alt: node.alt ?? '', nodeStart: start, nodeEnd: end, kind: 'markdown',
      ...(target.title !== null && target.title !== undefined ? { title: target.title } : {}),
      ...(referenced && !linkedDefinitions.has(node.identifier!) ? { imageOnlyDefinitions: referenced.flatMap(definition => {
        const definitionStart = definition.position?.start.offset, definitionEnd = definition.position?.end.offset;
        return definitionStart === undefined || definitionEnd === undefined ? [] : [{ start: definitionStart, end: definitionEnd }];
      }) } : {}),
    });
  });
  const ordinary = result.filter(image => !ignored.some(range => image.nodeStart >= range.start && image.nodeStart < range.end));
  for (const image of ordinary) {
    const fragment = image.url.indexOf('#');
    if (fragment < 0) continue;
    const marker = image.url.slice(fragment);
    if (!marker.startsWith('#kbimage=')) continue;
    if (!/^#kbimage=[a-f\d]{64}$/iu.test(marker)) throw new Error('MARKDOWN_IMAGE_ORIGIN_INVALID');
    image.sourceHash = marker.slice(9).toLowerCase();
  }
  return [...canonical.filter(image => !ordinary.some(outer => outer.nodeStart < image.nodeStart && outer.nodeEnd > image.nodeEnd)), ...ordinary]
    .sort((a, b) => a.nodeStart - b.nodeStart);
}

const attribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
/** Replace image occurrences and remove their now-unused definitions. Shared
 * link definitions and other bytes remain intact; KBIMAGE retains metadata/OCR. */
export function normalizeImageTags(source: string, images: readonly InputImage[], resourceIds: ReadonlyMap<string, string>): string {
  const edits = new Map<number, { start: number; end: number; text: string }>();
  for (const image of images) {
    const resourceId = resourceIds.get(image.url);
    if (!resourceId) throw new Error('MARKDOWN_IMAGE_RESOURCE_REQUIRED');
    if (image.kind === 'kbimage') continue;
    let tag = kbImageTag(resourceId, image.alt, image.title);
    const dimensions = [image.width !== undefined ? ` width="${attribute(image.width)}"` : '', image.height !== undefined ? ` height="${attribute(image.height)}"` : ''].join('');
    if (dimensions) tag = tag.replace(/\s*\/>$/u, `${dimensions} />`);
    edits.set(image.nodeStart, { start: image.nodeStart, end: image.nodeEnd, text: tag });
    for (const definition of image.imageOnlyDefinitions ?? []) edits.set(definition.start, { ...definition, text: '' });
  }
  const result: string[] = []; let cursor = 0;
  for (const edit of [...edits.values()].sort((a, b) => a.start - b.start)) {
    if (edit.start < cursor) throw new Error('MARKDOWN_IMAGE_OVERLAP');
    result.push(source.slice(cursor, edit.start), edit.text); cursor = edit.end;
  }
  result.push(source.slice(cursor));
  return result.join('');
}
