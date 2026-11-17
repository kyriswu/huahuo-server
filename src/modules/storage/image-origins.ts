import { createHash } from 'node:crypto';
import { kbImages, kbImageAttributes, type KbImage } from '../../lib/kb-images.js';
import { DomainError } from '../identity/store.js';

export interface ImageOrigin {
  part: string;
  ordinal: number;
  resourceId: string;
  hash?: string;
  format: 'markdown' | 'html';
}
export interface NormalizedImageParts { parts: Record<string, string>; imageOrigins: ImageOrigin[] }
interface StoredImage { image: KbImage; node: string; attributes: ReadonlyMap<string, string>; hash: string; metadata: string }
interface Edit { start: number; end: number; text: string }
const escapeAttribute = (value: string) => value.replace(/[&<>"'\r\n\t]/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\r': '&#13;', '\n': '&#10;', '\t': '&#9;' })[char]!);
const space = (char: string | undefined) => char !== undefined && /[\t\n\r ]/u.test(char);
function replace(source: string, edits: Edit[]): string {
  const result: string[] = []; let cursor = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    result.push(source.slice(cursor, edit.start), edit.text); cursor = edit.end;
  }
  result.push(source.slice(cursor)); return result.join('');
}

/** Change presentation attributes only. The validated tag's other attribute
 * bytes, paired content, CDATA and closing tag are copied without alteration. */
function withPresentation(original: StoredImage, incoming: ReadonlyMap<string, string>, format: ImageOrigin['format']): string {
  const keys = format === 'html' ? ['alt', 'title', 'width', 'height'] : ['alt', 'title'];
  const changes = new Map<string, string | undefined>();
  for (const key of keys) {
    const previous = original.attributes.get(key), next = incoming.get(key);
    if ((key === 'alt' ? previous ?? '' : previous) !== (key === 'alt' ? next ?? '' : next)) changes.set(key, next);
  }
  if (!changes.size) return original.node;
  const source = original.node;
  let attributesEnd = original.image.contentStart - original.image.nodeStart - 1;
  while (space(source[attributesEnd - 1])) attributesEnd--;
  if (source[attributesEnd - 1] === '/') attributesEnd--;
  while (space(source[attributesEnd - 1])) attributesEnd--;
  const edits: Edit[] = [];
  let at = 8;
  while (at < attributesEnd) {
    const start = at;
    while (space(source[at])) at++;
    if (at >= attributesEnd) break;
    const nameStart = at;
    while (at < attributesEnd && /[a-z\d_.:-]/iu.test(source[at]!)) at++;
    const name = source.slice(nameStart, at).toLowerCase();
    const nameEnd = at;
    while (space(source[at])) at++;
    if (source[at] === '=') {
      at++; while (space(source[at])) at++;
      const quote = source[at];
      if (quote === '"' || quote === "'") { at++; while (at < attributesEnd && source[at] !== quote) at++; at++; }
      else while (at < attributesEnd && !space(source[at])) at++;
    } else at = nameEnd;
    if (changes.has(name)) {
      const value = changes.get(name);
      edits.push({ start, end: at, text: value === undefined ? '' : ` ${name}="${escapeAttribute(value)}"` });
      changes.delete(name);
    }
  }
  const additions = [...changes].flatMap(([name, value]) => value === undefined ? [] : [` ${name}="${escapeAttribute(value)}"`]).join('');
  if (additions) edits.push({ start: attributesEnd, end: attributesEnd, text: additions });
  return replace(source, edits);
}

/** Called inside the idempotent transaction, after loading the current body.
 * URL signatures are already gone; only owned identity and the node fingerprint
 * select metadata. A retry therefore never depends on a newer current revision. */
export function restoreOwnedImageParts(currentParts: Record<string, string>, prepared: NormalizedImageParts): Record<string, string> {
  if (!prepared.imageOrigins.length) return { ...prepared.parts };
  const byResource = new Map<string, StoredImage[]>();
  for (const source of Object.values(currentParts)) for (const image of kbImages(source)) {
    const node = source.slice(image.nodeStart, image.nodeEnd), attributes = kbImageAttributes(source, image);
    const metadata = JSON.stringify([
      [...attributes].filter(([name]) => !['uuid', 'alt', 'title'].includes(name)).sort(([a], [b]) => a.localeCompare(b)),
      source.slice(image.contentStart, image.contentEnd),
    ]);
    const entry = { image, node, attributes, hash: createHash('sha256').update(node).digest('hex'), metadata };
    const existing = byResource.get(image.resourceId);
    if (existing) existing.push(entry); else byResource.set(image.resourceId, [entry]);
  }
  const result = { ...prepared.parts };
  for (const [part, source] of Object.entries(prepared.parts)) {
    const images = kbImages(source), edits: Edit[] = [];
    for (const origin of prepared.imageOrigins.filter(origin => origin.part === part)) {
      const image = images[origin.ordinal];
      if (!image || image.resourceId !== origin.resourceId) throw new Error('NOTE_IMAGE_ORIGIN_RANGE_INVALID');
      const candidates = byResource.get(origin.resourceId) ?? [];
      let original: StoredImage | undefined;
      if (origin.hash) {
        original = candidates.find(candidate => candidate.hash === origin.hash);
        if (!original) throw new DomainError(409, 'NOTE_IMAGE_ORIGIN_NOT_FOUND');
      } else {
        if (new Set(candidates.map(candidate => candidate.metadata)).size > 1) throw new DomainError(409, 'NOTE_IMAGE_ORIGIN_AMBIGUOUS');
        original = candidates[0];
      }
      if (original) edits.push({ start: image.nodeStart, end: image.nodeEnd, text: withPresentation(original, kbImageAttributes(source, image), origin.format) });
    }
    if (edits.length) result[part] = replace(source, edits);
  }
  return result;
}
