import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt();
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
const rawTextTags = new Set(['script', 'style', 'pre', 'code', 'textarea']);
const blockTags = new Set(['address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search', 'section', 'source', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul']);

export interface KbImage {
  resourceId: string;
  alt: string;
  nodeStart: number;
  nodeEnd: number;
  contentStart: number;
  contentEnd: number;
  htmlBlock?: true;
}
interface Tag { name: string; closing: boolean; selfClosing: boolean; attributesStart: number; attributesEnd: number; end: number }
const whitespace = (char: string | undefined) => char !== undefined && /[\t\n\r ]/u.test(char);
const decode = (value: string) => value.replace(/&(?:#[xX][a-f\d]+|#\d+|[a-z][a-z\d]+);/giu, entity => markdown.utils.unescapeAll(entity));
const escape = (value: string) => value.replace(/[&<>"'\r\n\t]/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\r': '&#13;', '\n': '&#10;', '\t': '&#9;' })[char]!);
function resourceId(value: string | undefined): string {
  if (!value || !uuid.test(value) || /^0+$/u.test(value.replaceAll('-', ''))) throw new Error('KB_IMAGE_UUID_INVALID');
  return value.toLowerCase();
}

/** Read one tag without treating a quoted > as its end. No source-sized copies. */
function tagAt(source: string, start: number, failed?: Set<number>): Tag | undefined {
  let at = start + 1;
  const closing = source[at] === '/';
  if (closing) at++;
  const nameStart = at;
  if (!/[a-z]/iu.test(source[at] ?? '')) return;
  while (at < source.length && /[a-z\d:-]/iu.test(source[at]!)) at++;
  const name = source.slice(nameStart, at).toLowerCase();
  if (!whitespace(source[at]) && source[at] !== '/' && source[at] !== '>') return;
  const attributesStart = at;
  // Memoize failed lexical suffixes by quote state. Malformed tags containing
  // many quoted < characters must not restart a source-sized scan each time.
  const visited: number[] = [], tokens = /[<>"']/gu;
  let quote = 0;
  tokens.lastIndex = at;
  for (let token = tokens.exec(source); token; token = tokens.exec(source)) {
    const position = token.index, char = token[0], key = position * 3 + quote;
    if (failed?.has(key)) break;
    visited.push(key);
    if (quote) { if (char === (quote === 1 ? '"' : "'")) quote = 0; continue; }
    if (char === '"' || char === "'") { quote = char === '"' ? 1 : 2; continue; }
    if (char === '<') break;
    if (char === '>') {
      let end = position;
      while (end > attributesStart && whitespace(source[end - 1])) end--;
      const selfClosing = source[end - 1] === '/';
      return { name, closing, selfClosing, attributesStart, attributesEnd: selfClosing ? end - 1 : end, end: position + 1 };
    }
  }
  if (failed) for (const key of visited) failed.add(key);
}
function attributes(source: string, tag: Tag): Map<string, string> {
  const result = new Map<string, string>();
  let at = tag.attributesStart;
  while (at < tag.attributesEnd) {
    const before = at;
    while (whitespace(source[at])) at++;
    if (at >= tag.attributesEnd) break;
    if (at === before) throw new Error('KB_IMAGE_ATTRIBUTE_INVALID');
    const start = at;
    if (!/[a-z_:]/iu.test(source[at] ?? '')) throw new Error('KB_IMAGE_ATTRIBUTE_INVALID');
    while (at < tag.attributesEnd && /[a-z\d_.:-]/iu.test(source[at]!)) at++;
    const name = source.slice(start, at).toLowerCase();
    const nameEnd = at;
    while (whitespace(source[at])) at++;
    let value = '';
    if (source[at] === '=') {
      at++;
      while (whitespace(source[at])) at++;
      const quote = source[at];
      if (quote === '"' || quote === "'") {
        const valueStart = ++at;
        while (at < tag.attributesEnd && source[at] !== quote) at++;
        if (at >= tag.attributesEnd) throw new Error('KB_IMAGE_ATTRIBUTE_INVALID');
        value = source.slice(valueStart, at++);
      } else {
        const valueStart = at;
        while (at < tag.attributesEnd && !whitespace(source[at])) {
          if (/["'=<>`]/u.test(source[at]!)) throw new Error('KB_IMAGE_ATTRIBUTE_INVALID');
          at++;
        }
        if (at === valueStart) throw new Error('KB_IMAGE_ATTRIBUTE_INVALID');
        value = source.slice(valueStart, at);
      }
    } else at = nameEnd;
    if (result.has(name)) throw new Error('KB_IMAGE_ATTRIBUTE_DUPLICATE');
    result.set(name, decode(value));
  }
  return result;
}
function opaqueEnd(source: string, at: number): number | undefined {
  if (source.startsWith('<!--', at)) { const end = source.indexOf('-->', at + 4); return end < 0 ? source.length : end + 3; }
  if (source.startsWith('<![CDATA[', at)) { const end = source.indexOf(']]>', at + 9); return end < 0 ? source.length : end + 3; }
}
function imageAt(source: string, start: number, tag: Tag, failed: Set<number>): KbImage {
  const attrs = attributes(source, tag);
  const image: KbImage = { resourceId: resourceId(attrs.get('uuid')), alt: attrs.get('alt') ?? '', nodeStart: start, nodeEnd: tag.end, contentStart: tag.end, contentEnd: tag.end };
  if (tag.selfClosing) return image;
  let at = tag.end;
  while ((at = source.indexOf('<', at)) >= 0) {
    const opaque = opaqueEnd(source, at);
    if (opaque !== undefined) { at = opaque; continue; }
    const next = tagAt(source, at, failed);
    if (!next) { at++; continue; }
    if (next.name === 'kbimage') {
      if (!next.closing || next.selfClosing || source.slice(next.attributesStart, next.attributesEnd).trim()) throw new Error('KB_IMAGE_NESTED_OR_INVALID_CLOSE');
      return { ...image, contentEnd: at, nodeEnd: next.end };
    }
    at = next.end;
  }
  throw new Error('KB_IMAGE_UNCLOSED');
}
function newline(source: string, at: number): number {
  while (at < source.length && source[at] !== '\r' && source[at] !== '\n') at++;
  return at;
}
function afterNewline(source: string, at: number): number { return source[at] === '\r' && source[at + 1] === '\n' ? at + 2 : at + 1; }
interface Prefix { at: number; indent: number; quoteDepth: number; listIndent?: number }
/** Block containers only locate literal code. They do not tokenize body Markdown. */
function linePrefix(source: string, start: number, end: number, previousListIndent: number): Prefix {
  let at = start, indent = 0, quoteDepth = 0;
  const spaces = () => { indent = 0; while (at < end && (source[at] === ' ' || source[at] === '\t')) { indent += source[at] === '\t' ? 4 - indent % 4 : 1; at++; } };
  spaces();
  while (indent <= 3 && source[at] === '>') { quoteDepth++; at++; if (source[at] === ' ' || source[at] === '\t') at++; spaces(); }
  if (previousListIndent && indent >= previousListIndent) indent -= previousListIndent;
  if (indent <= 3) {
    const marker = /^(?:[-+*]|\d{1,9}[.)])([\t ]+)/u.exec(source.slice(at, Math.min(end, at + 32)));
    if (marker) {
      const gap = marker[1]!, width = marker[0].length - gap.length;
      const gapWidth = [...gap].reduce((n, char) => n + (char === '\t' ? 4 - (width + n) % 4 : 1), 0);
      const padding = gapWidth <= 4 ? gapWidth : 1;
      let content = at + marker[0].length, remaining = gapWidth - padding;
      while (remaining <= 3 && source[content] === '>') {
        quoteDepth++; content++; if (source[content] === ' ' || source[content] === '\t') content++;
        remaining = 0; while (content < end && (source[content] === ' ' || source[content] === '\t')) { remaining += source[content] === '\t' ? 4 - remaining % 4 : 1; content++; }
      }
      return { at: content, indent: remaining, quoteDepth, listIndent: previousListIndent + indent + width + padding };
    }
  }
  return { at, indent, quoteDepth };
}
function fenceAt(source: string, at: number, end: number): { marker: string; length: number; rest: string } | undefined {
  const marker = source[at];
  if (marker !== '`' && marker !== '~') return;
  let stop = at;
  while (stop < end && source[stop] === marker) stop++;
  if (stop - at < 3) return;
  return { marker, length: stop - at, rest: source.slice(stop, end) };
}

/** Read only link destinations/titles, never a paragraph's inline syntax. */
function linkDestinationEnd(source: string, at: number, max: number, closing?: string): number | undefined {
  while (at < max && whitespace(source[at])) at++;
  const destination = markdown.helpers.parseLinkDestination(source, at, max);
  if (!destination.ok) return;
  at = destination.pos;
  const before = at;
  while (at < max && whitespace(source[at])) at++;
  if (at > before && ['"', "'", '('].includes(source[at] ?? '')) {
    const title = markdown.helpers.parseLinkTitle(source, at, max);
    if (!title.ok) return;
    at = title.pos;
    while (at < max && whitespace(source[at])) at++;
  }
  return closing ? source[at] === closing ? at + 1 : undefined : at;
}
function definitionEnd(source: string, start: number, end: number, maximum: number): { end: number; label: string } | undefined {
  if (source[start] !== '[') return;
  let at = start + 1;
  for (; at < end && at - start <= 1000; at++) {
    if (source[at] === '\\') { at++; continue; }
    if (source[at] === '[') return;
    if (source[at] === ']') break;
  }
  if (source[at] !== ']' || source[at + 1] !== ':' || at === start + 1) return;
  const label = source.slice(start + 1, at);
  at += 2;
  while (at < maximum && whitespace(source[at])) at++;
  const destination = markdown.helpers.parseLinkDestination(source, at, maximum);
  if (!destination.ok) return;
  at = destination.pos;
  const destinationLineEnd = newline(source, at);
  while (at < maximum && whitespace(source[at])) at++;
  if (at > destination.pos && ['"', "'", '('].includes(source[at] ?? '')) {
    const title = markdown.helpers.parseLinkTitle(source, at, maximum);
    if (title.ok) {
      at = title.pos;
      const titleLineEnd = newline(source, at);
      while (at < titleLineEnd && whitespace(source[at])) at++;
      if (at === titleLineEnd) return { end: at, label };
    }
  }
  // A bad title on a later line does not invalidate the destination-only definition.
  at = destination.pos;
  while (at < destinationLineEnd && whitespace(source[at])) at++;
  return at === destinationLineEnd ? { end: at, label } : undefined;
}

/** Read canonical KBIMAGE nodes in UTF-16 coordinates. Normal prose takes a
 * string-search fast path; image-bearing bodies use a bounded-state scan, not
 * a Markdown syntax tree. Comments, code examples and OCR CDATA stay opaque. */
function scanKbImages(source: string, collectReferences?: Set<string>): KbImage[] {
  if (!/<kbimage\b/iu.test(source)) return [];
  const images: KbImage[] = [];
  const failedTags = new Set<number>();
  let references: Set<string> | undefined;
  const referenceDefined = (label: string): boolean => {
    if (collectReferences || label.length > 999) return false;
    if (!references) { references = new Set<string>(); scanKbImages(source, references); }
    return references.has(markdown.utils.normalizeReference(label));
  };
  let at = 0, lineStart = 0, lineEnd = newline(source, 0), listIndent = 0;
  let paragraph = false, indentedCode = false, htmlBlock = false, htmlContainer = false, headingLine = false, quoteDepth = 0, brackets = 0;
  let fence: { marker: string; length: number; quoteDepth: number } | undefined;
  // Cache failed backtick searches as the inline Markdown tokenizer does, so
  // unmatched runs do not repeatedly scan the same paragraph suffix.
  let ticksScannedTo = -1, paragraphBoundary = -1;
  const lastTicks = new Map<number, number>();
  const jump = (end: number) => {
    while (end > lineEnd) { lineStart = afterNewline(source, lineEnd); lineEnd = newline(source, lineStart); }
    at = end;
  };
  const inlineBoundary = (start: number): number => {
    if (paragraphBoundary >= start) return paragraphBoundary;
    let boundary = newline(source, start), next = boundary;
    if (headingLine) return paragraphBoundary = boundary;
    while (next < source.length) {
      next = afterNewline(source, next);
      const end = newline(source, next), prefix = linePrefix(source, next, end, listIndent);
      const text = source.slice(prefix.at, end);
      if (!text.trim() || (prefix.quoteDepth !== quoteDepth && prefix.quoteDepth !== 0) || prefix.listIndent !== undefined) break;
      const firstTag = source[prefix.at] === '<' ? tagAt(source, prefix.at, failedTags) : undefined;
      if (prefix.indent <= 3 && (firstTag && (blockTags.has(firstTag.name) || rawTextTags.has(firstTag.name)) || /^(?:#{1,6}(?:[\t ]|$)|(?:`{3,}|~{3,})|(?:=+|-+)[\t ]*$|(?:[\t ]*[-*_]){3,}[\t ]*$|<!--|<!\[CDATA\[|<\?|<![A-Z])/u.test(text))) break;
      boundary = end; next = end;
    }
    return paragraphBoundary = boundary;
  };
  const inlineEnd = (start: number, length: number): number | undefined => {
    const boundary = inlineBoundary(start);
    if (ticksScannedTo >= boundary && (lastTicks.get(length) ?? -1) <= start) return;
    let cursor = start + length;
    while ((cursor = source.indexOf('`', cursor)) >= 0 && cursor < boundary) {
      const begin = cursor;
      while (cursor < boundary && source[cursor] === '`') cursor++;
      const width = cursor - begin;
      lastTicks.set(width, begin);
      if (width === length) return cursor;
    }
    ticksScannedTo = Math.max(ticksScannedTo, boundary);
  };
  const labelEnds = new Map<number, number>();
  const labelEnd = (start: number): number | undefined => {
    const known = labelEnds.get(start);
    if (known !== undefined) return known < 0 ? undefined : known;
    const stack = [start], maximum = inlineBoundary(start);
    let cursor = start + 1;
    while (cursor < maximum) {
      const char = source[cursor];
      if (char === '\\') { cursor += 2; continue; }
      if (char === '`') {
        let stop = cursor; while (source[stop] === '`') stop++;
        cursor = inlineEnd(cursor, stop - cursor) ?? stop; continue;
      }
      if (char === '<') {
        const opaque = opaqueEnd(source, cursor), tag = opaque === undefined ? tagAt(source, cursor, failedTags) : undefined;
        if (opaque !== undefined || tag) { cursor = opaque ?? tag!.end; continue; }
      }
      if (char === '[') stack.push(cursor);
      if (char === ']') {
        const opening = stack.pop()!;
        labelEnds.set(opening, cursor);
        if (!stack.length) return cursor;
      }
      cursor++;
    }
    for (const opening of stack) labelEnds.set(opening, -1);
  };
  while (at < source.length) {
    if (at === lineStart) {
      const prefix = linePrefix(source, lineStart, lineEnd, listIndent);
      const blank = prefix.at === lineEnd;
      quoteDepth = prefix.quoteDepth;
      headingLine = /^#{1,6}(?:[\t ]|$)/u.test(source.slice(prefix.at, Math.min(lineEnd, prefix.at + 8)));
      if (blank) { paragraph = false; htmlBlock = false; htmlContainer = false; brackets = 0; }
      if (fence) {
        if (!blank && prefix.quoteDepth < fence.quoteDepth) fence = undefined;
        else {
          const ending = prefix.indent <= 3 ? fenceAt(source, prefix.at, lineEnd) : undefined;
          if (ending && ending.marker === fence.marker && ending.length >= fence.length && !ending.rest.trim()) fence = undefined;
          at = lineEnd;
        }
      }
      if (at !== lineEnd && !htmlBlock) {
        if (prefix.listIndent !== undefined) { listIndent = prefix.listIndent; paragraph = false; }
        else if (!blank && prefix.indent === 0 && prefix.at === lineStart) listIndent = 0;
        if (prefix.indent >= 4 && (indentedCode || !paragraph)) { indentedCode = true; at = lineEnd; }
        else if (!blank) {
          indentedCode = false;
          const opening = prefix.indent <= 3 ? fenceAt(source, prefix.at, lineEnd) : undefined;
          if (opening && (opening.marker !== '`' || !opening.rest.includes('`'))) {
            fence = { marker: opening.marker, length: opening.length, quoteDepth: prefix.quoteDepth };
            paragraph = false; at = lineEnd;
          } else {
            const definition = !paragraph && prefix.indent <= 3 && source[prefix.at] === '[' ? definitionEnd(source, prefix.at, lineEnd, inlineBoundary(prefix.at)) : undefined;
            if (definition !== undefined) { collectReferences?.add(markdown.utils.normalizeReference(definition.label)); paragraph = false; jump(definition.end); continue; }
            const firstTag = source[prefix.at] === '<' ? tagAt(source, prefix.at, failedTags) : undefined;
            htmlContainer = Boolean(firstTag && blockTags.has(firstTag.name));
            htmlBlock = Boolean(firstTag && (htmlContainer || firstTag.name !== 'kbimage' && !paragraph && !source.slice(firstTag.end, lineEnd).trim()));
            paragraph = !htmlBlock && !headingLine;
            at = prefix.at;
          }
        }
      }
    }
    if (at >= lineEnd) {
      if (lineEnd === source.length) break;
      at = afterNewline(source, lineEnd); lineStart = at; lineEnd = newline(source, at); continue;
    }
    const char = source[at];
    if (!htmlBlock && char === '!' && source[at + 1] === '[') {
      const label = labelEnd(at + 1);
      if (label !== undefined) {
        if (source[label + 1] === '(') {
          const end = linkDestinationEnd(source, label + 2, inlineBoundary(at), ')');
          if (end !== undefined) { jump(end); continue; }
        }
        const reference = source[label + 1] === '[' ? labelEnd(label + 1) : undefined;
        const name = reference === undefined || reference === label + 2 ? source.slice(at + 2, label) : source.slice(label + 2, reference);
        if (referenceDefined(name)) { jump(reference === undefined ? label + 1 : reference + 1); continue; }
      }
    }
    if (!htmlBlock && char === '[') { brackets++; at++; continue; }
    if (!htmlBlock && char === ']' && brackets) {
      brackets--;
      if (source[at + 1] === '(') {
        const end = linkDestinationEnd(source, at + 2, inlineBoundary(at), ')');
        if (end !== undefined) { jump(end); continue; }
      }
    }
    if (char === '\\' && !htmlBlock) { at += source[at + 1] === '\r' || source[at + 1] === '\n' ? 1 : 2; continue; }
    if (char === '`' && !htmlBlock) {
      let end = at; while (source[end] === '`') end++;
      jump(inlineEnd(at, end - at) ?? end); continue;
    }
    if (char !== '<') { at++; continue; }
    const opaque = opaqueEnd(source, at);
    if (opaque !== undefined) { jump(opaque); continue; }
    const tag = tagAt(source, at, failedTags);
    if (!tag) {
      if (!collectReferences && /^<kbimage\b/iu.test(source.slice(at, at + 10))) throw new Error('KB_IMAGE_TAG_INVALID');
      at++; continue;
    }
    if (!tag.closing && rawTextTags.has(tag.name) && !tag.selfClosing) {
      const closing = new RegExp(`</${tag.name}\\s*>`, 'giu'); closing.lastIndex = tag.end;
      const found = closing.exec(source); jump(found ? closing.lastIndex : source.length); continue;
    }
    if (tag.name === 'kbimage') {
      if (collectReferences) {
        // Valid canonical OCR is opaque during reference discovery too. An
        // invalid tag may just be an image-alt example; the main pass decides.
        try { jump(imageAt(source, at, tag, failedTags).nodeEnd); } catch { jump(tag.end); }
        continue;
      }
      if (tag.closing) throw new Error('KB_IMAGE_UNEXPECTED_CLOSE');
      const image = imageAt(source, at, tag, failedTags); if (htmlContainer) image.htmlBlock = true; images.push(image); jump(image.nodeEnd); continue;
    }
    jump(tag.end);
  }
  return images;
}

export function kbImages(source: string): KbImage[] { return scanKbImages(source); }

/** Read decoded opening attributes without a second HTML parser. */
export function kbImageAttributes(source: string, image: KbImage): ReadonlyMap<string, string> {
  const opening = tagAt(source, image.nodeStart);
  if (!opening || opening.name !== 'kbimage' || opening.closing || opening.end !== image.contentStart) throw new Error('KB_IMAGE_RANGE_INVALID');
  return attributes(source, opening);
}

/** Canonical output for client Markdown/HTML image inputs. */
export function kbImageTag(id: string, alt: string, title?: string): string {
  return `<KBIMAGE uuid="${resourceId(id)}" alt="${escape(alt)}"${title === undefined ? '' : ` title="${escape(title)}"`} />`;
}

/** Render only authorized image URLs. HTML works in both Markdown prose and
 * existing merged-table HTML. OCR remains text, never newly executable markup. */
export function renderKbImages(source: string, images: readonly KbImage[], links: ReadonlyMap<string, string>): string {
  if (!images.length || !links.size) return source;
  const parts: string[] = [];
  let position = 0;
  for (const image of images) {
    const url = links.get(image.resourceId);
    if (!url) continue;
    if (image.nodeStart < position || image.nodeStart < 0 || image.nodeEnd > source.length || image.contentStart < image.nodeStart || image.contentEnd > image.nodeEnd || image.contentEnd < image.contentStart) throw new Error('KB_IMAGE_RANGE_INVALID');
    let target: URL;
    try { target = new URL(url); } catch { throw new Error('KB_IMAGE_DISPLAY_URL_INVALID'); }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('KB_IMAGE_DISPLAY_URL_INVALID');
    const attrs = kbImageAttributes(source, image), title = attrs.get('title');
    const dimensions = ['width', 'height'].flatMap(name => { const value = attrs.get(name); return value && /^\d{1,5}$/u.test(value) && Number(value) > 0 && Number(value) <= 16384 ? [` ${name}="${Number(value)}"`] : []; }).join('');
    const body = source.slice(image.contentStart, image.contentEnd).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1');
    parts.push(source.slice(position, image.nodeStart), `<img src="${escape(url)}" alt="${escape(image.alt)}"${title === undefined ? '' : ` title="${escape(title)}"`}${dimensions} />`);
    if (body) parts.push(`<span>${escape(body).replace(/[\\`*_[\]~]/gu, char => `&#${char.charCodeAt(0)};`)}</span>`);
    position = image.nodeEnd;
  }
  if (!position) return source;
  parts.push(source.slice(position));
  return parts.join('');
}
