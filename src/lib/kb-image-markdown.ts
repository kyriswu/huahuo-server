import { createHash } from 'node:crypto';
import { kbImageAttributes, type KbImage } from './kb-images.js';

// Signed links and instance fingerprints expand the editable view. These are
// transport limits; services enforce their existing canonical content limits.
export const EDITABLE_MARKDOWN_MAX_CHARS = 2_000_000;
export const EDITABLE_MARKDOWN_BODY_LIMIT = 8 * 1024 * 1024;

const attribute = (value: string) => value.replace(/[&<>"'\r\n\t]/gu, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\r': '&#13;', '\n': '&#10;', '\t': '&#9;',
})[char]!);
const label = (value: string) => attribute(value).replace(/[\\[\]`*_~|]/gu, '\\$&');

/** Editable Markdown carries a source-node fingerprint in the URL fragment.
 * Browsers never send fragments to OSS, so download signatures are unaffected.
 * OCR stays in canonical storage and is restored on save, not duplicated into
 * editable prose. The fingerprint identifies a node; it grants no access. */
export function renderEditableKbImages(source: string, images: readonly KbImage[], links: ReadonlyMap<string, string>): string {
  if (!images.length) return source;
  const parts: string[] = [];
  let position = 0;
  for (const image of images) {
    const link = links.get(image.resourceId);
    if (!link) throw new Error('KB_IMAGE_DISPLAY_URL_REQUIRED');
    let url: URL;
    try { url = new URL(link); } catch { throw new Error('KB_IMAGE_DISPLAY_URL_INVALID'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('KB_IMAGE_DISPLAY_URL_INVALID');
    if (image.nodeStart < position || image.nodeEnd > source.length) throw new Error('KB_IMAGE_RANGE_INVALID');
    const original = source.slice(image.nodeStart, image.nodeEnd);
    url.hash = 'kbimage=' + createHash('sha256').update(original).digest('hex');
    const attrs = kbImageAttributes(source, image), title = attrs.get('title');
    const width = attrs.get('width'), height = attrs.get('height');
    const dimension = (name: string, value: string | undefined) => value !== undefined && /^(?:[1-9]\d{0,4}|(?:100|[1-9]?\d)%)$/u.test(value) ? ` ${name}="${value}"` : '';
    const dimensions = dimension('width', width) + dimension('height', height);
    // CommonMark does not parse image syntax inside a raw HTML table block.
    // Raw img is standard Markdown HTML and retains explicit image dimensions.
    const markdown = image.htmlBlock || dimensions
      ? `<img src="${attribute(url.href)}" alt="${attribute(image.alt)}"${title === undefined ? '' : ` title="${attribute(title)}"`}${dimensions} />`
      : `![${label(image.alt)}](<${url.href}>${title === undefined ? '' : ` "${label(title)}"`})`;
    parts.push(source.slice(position, image.nodeStart), markdown);
    position = image.nodeEnd;
  }
  parts.push(source.slice(position));
  return parts.join('');
}
