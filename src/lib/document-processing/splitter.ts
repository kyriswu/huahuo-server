import { createHash } from 'node:crypto';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { markdownParser, sourceBoundary, sourceLineOffsets } from './structure.js';
import { DocumentProcessingError, type ChunkDraft, type SectionRange, type SplitTextInput, type TokenCounter } from './types.js';

export const SPLITTER_VERSION = 'langchain-recursive-source-budgets';
const separators = ['\n\n', '\n', '。', '！', '？', '；', '，', '. ', '! ', '? ', '; ', ', ', ' ', ''];
const readingBreaks = /(?:\r\n|[\r\n])+|[。！？]+[”’」』）】]*|[.!?]+["')\]]*(?=\s)/gu;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** LC owns recursive splitting; only its UTF-16 fallback is made Unicode safe. */
class UnicodeRecursiveSplitter extends RecursiveCharacterTextSplitter {
  protected override splitOnSeparator(text: string, separator: string): string[] {
    return separator ? super.splitOnSeparator(text, separator) : [...graphemes.segment(text)].map(part => part.segment);
  }
}

async function count(tokenizer: TokenCounter, text: string): Promise<number> {
  const tokens = await tokenizer.count(text);
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new DocumentProcessingError('TOKENIZER_RESULT_INVALID', 'Tokenizer must return a nonnegative integer');
  return tokens;
}

interface Span { start: number; end: number; }
interface ContextSpan extends Span { assetRefs: string[]; tableHeader?: string; }
export interface MappedChunkBoundaries {
  /** Sorted UTF-16 positions of surviving cuts in the new source. */
  cuts: readonly number[];
  /** Starts of ranges where an edit crossed and removed an old cut. */
  recutStarts: ReadonlySet<number>;
}

function codePointLength(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; length += 1) {
    index += text.codePointAt(index)! > 0xFFFF ? 2 : 1;
  }
  return length;
}

/** A mapped span can be larger than the proposal after restoring whitespace. */
function capSourceSpan(content: string, span: Span, limit: number): Span[] {
  if (span.end - span.start <= limit) return [span];
  const raw = content.slice(span.start, span.end);
  if (codePointLength(raw) <= limit) return [span];
  const spans: Span[] = [];
  let start = span.start, end = span.start, size = 0;
  function append(units: number, chars: number) {
    if (size + chars > limit) {
      spans.push({ start, end });
      start = end;
      size = 0;
    }
    end += units;
    size += chars;
  }
  for (const { segment } of graphemes.segment(raw)) {
    const chars = codePointLength(segment);
    if (chars <= limit) append(segment.length, chars);
    else for (const point of segment) append(point.length, 1);
  }
  spans.push({ start, end });
  return spans.filter(part => content.slice(part.start, part.end).trim());
}

function markdownContexts(content: string): ContextSpan[] {
  const offsets = sourceLineOffsets(content);
  const tokens = markdownParser.parse(content, {});
  const paragraphs: Array<Span & { text: string; refs: string[] }> = [];
  const contexts: ContextSpan[] = [];
  for (const [index, token] of tokens.entries()) {
    if (!token.map || token.level !== 0) continue;
    const start = offsets[token.map[0]] ?? content.length;
    const end = offsets[token.map[1]] ?? content.length;
    if (token.type === 'table_open') {
      const headerEnd = offsets[Math.min(token.map[0] + 2, token.map[1])] ?? end;
      contexts.push({ start, end, assetRefs: [], tableHeader: content.slice(start, headerEnd) });
    }
    if (token.type !== 'paragraph_open') continue;
    const inline = tokens[index + 1];
    const refs = inline?.children?.filter(child => child.type === 'image').map(child => child.attrGet('src')).filter((ref): ref is string => typeof ref === 'string' && ref.startsWith('asset://')) ?? [];
    paragraphs.push({ start, end, text: content.slice(start, end), refs });
  }
  for (const [index, paragraph] of paragraphs.entries()) {
    if (!paragraph.refs.length) continue;
    let start = paragraph.start;
    // Existing enriched Markdown places OCR/caption immediately before the
    // asset image. Bind those existing paragraphs without rewriting the source.
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const prior = paragraphs[previous]!;
      if (!/^\s*图片(?:文字|描述)[：:]/u.test(prior.text) || content.slice(prior.end, start).trim()) break;
      start = prior.start;
    }
    contexts.push({ start, end: paragraph.end, assetRefs: [...paragraph.refs] });
  }
  return contexts;
}

/** Never put transport URLs or inline image binary into the model input. */
export function embeddingBody(content: string): string {
  return content
    .replace(/!\[([^\]]*)\]\((?:https?:\/\/|data:)[^)]*\)/giu, '[$1 image]')
    .replace(/data:[^\s;,]+;base64,[A-Za-z0-9+/=]+/giu, '[image data]')
    .replace(/https?:\/\/[^\s)\]>]+/giu, '[link]');
}

function transportSpans(content: string): Span[] {
  return [...content.matchAll(/data:[^\s;,]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[^\s)\]>]+/giu)].map(match => ({ start: match.index, end: match.index + match[0].length }));
}

function withoutTransport(content: string, start: number, end: number, redactions: Span[]): string {
  let cursor = start; let output = '';
  for (const span of redactions) {
    if (span.end <= start || span.start >= end) continue;
    const from = Math.max(start, span.start);
    output += content.slice(cursor, from);
    if (span.start >= start) output += '[link]';
    cursor = Math.min(end, span.end);
  }
  return output + content.slice(cursor, end);
}

function validateRanges(content: string, input: SplitTextInput): SectionRange[] {
  const hints = input.structureHints;
  if (!hints) return [{ sourceStart: 0, sourceEnd: content.length, sectionId: null, headingPath: [] }];
  let cursor = 0;
  for (const range of hints.ranges) {
    if (range.sourceStart !== cursor || !Number.isInteger(range.sourceEnd) || range.sourceEnd < range.sourceStart || range.sourceEnd > content.length || !sourceBoundary(content, range.sourceStart) || !sourceBoundary(content, range.sourceEnd)) throw new DocumentProcessingError('STRUCTURE_HINTS_INVALID', 'Section traversal must partition this source in reading order');
    cursor = range.sourceEnd;
  }
  if (cursor !== content.length) throw new DocumentProcessingError('STRUCTURE_HINTS_INVALID', 'Section traversal does not cover the source');
  return hints.ranges;
}

/** Prefer the last nearby break at or before target, then the first break after it. */
function* sourceWindows(content: string, range: SectionRange, target: number, limit: number): Generator<SectionRange> {
  const clusters = graphemes.segment(content);
  const minimum = Math.ceil(target * 0.8);
  for (let start = range.sourceStart; start < range.sourceEnd;) {
    let end = start;
    let near = start;
    let preferred: number | undefined;
    for (let chars = 1; chars <= limit && end < range.sourceEnd; chars += 1) {
      end += content.codePointAt(end)! > 0xFFFF ? 2 : 1;
      if (chars === minimum) near = end;
      if (chars === target) preferred = end;
    }
    if (end < range.sourceEnd) {
      const boundary = clusters.containing(end)!.index;
      if (boundary > start) end = boundary;
    }
    if (preferred !== undefined && end > preferred) {
      let cut: number | undefined;
      for (const match of content.slice(near - 1, end).matchAll(readingBreaks)) {
        const boundary = near - 1 + match.index + match[0].length;
        if (boundary < end && clusters.containing(boundary)?.index !== boundary) continue;
        if (boundary > preferred && cut !== undefined) break;
        cut = boundary;
        if (boundary >= preferred) break;
      }
      end = cut ?? end;
    }
    yield { ...range, sourceStart: start, sourceEnd: end };
    start = end;
  }
}

/** Map zero-overlap LC output by a monotonic cursor, not a content search. */
async function planTokenSpans(content: string, range: SectionRange, input: SplitTextInput): Promise<Span[]> {
  const raw = content.slice(range.sourceStart, range.sourceEnd);
  if (!raw.trim()) return [];
  // The model may add one EOS (or other framing tokens) per encode call. LC
  // adds fragment lengths, so reserve framing once rather than multiplying it
  // by every character/word. Complete model inputs are still checked below.
  const { tokenizer, targetTokens, maxSourceChars } = input.options;
  const framing = await count(tokenizer, '');
  const budget = Math.max(1, targetTokens - framing);
  const splitter = new UnicodeRecursiveSplitter({
    chunkSize: budget, chunkOverlap: 0, keepSeparator: true, separators,
    lengthFunction: async text => {
      const tokens = Math.max(0, await count(tokenizer, text) - framing);
      // Measure both budgets on the same scale so the recursive splitter can
      // prefer paragraph and sentence boundaries for either constraint.
      return maxSourceChars === undefined ? tokens : Math.max(tokens, codePointLength(text) * budget / maxSourceChars);
    },
  });
  const proposals = await splitter.splitText(raw);
  const spans: Span[] = [];
  let cursor = 0;
  for (const proposal of proposals) {
    let startOfText = cursor;
    // LC trims its output; skipped whitespace remains in the source span.
    while (startOfText < raw.length && /\s/u.test(raw[startOfText]!)) startOfText += 1;
    if (!raw.startsWith(proposal, startOfText)) throw new DocumentProcessingError('SPLITTER_POSITION_MISMATCH', 'Splitter output is not a sequential source slice');
    const end = startOfText + proposal.length;
    spans.push({ start: range.sourceStart + cursor, end: range.sourceStart + end }); cursor = end;
  }
  if (!spans.length || raw.slice(cursor).trim()) throw new DocumentProcessingError('SPLITTER_CONTENT_LOSS', 'Splitter did not account for the complete source');
  spans.at(-1)!.end = range.sourceEnd;
  return maxSourceChars === undefined ? spans : spans.flatMap(span => capSourceSpan(content, span, maxSourceChars));
}

async function planSpans(content: string, range: SectionRange, input: SplitTextInput): Promise<Span[]> {
  const { targetSourceChars, maxSourceChars } = input.options;
  if (targetSourceChars === undefined || maxSourceChars === undefined) return planTokenSpans(content, range, input);
  const spans: Span[] = [];
  for (const window of sourceWindows(content, range, targetSourceChars, maxSourceChars)) {
    for (const span of await planTokenSpans(content, window, input)) spans.push(span);
  }
  return spans;
}

async function suffixStart(content: string, start: number, end: number, maxTokens: number, tokenizer: TokenCounter, maxChars: number): Promise<number> {
  if (!maxTokens || maxChars <= 0 || start === end) return end;
  const points = [...graphemes.segment(content.slice(start, end))].map(part => start + part.index);
  points.push(end);
  let low = 0; let high = points.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const suffix = content.slice(points[mid], end);
    if (codePointLength(suffix) <= maxChars && await count(tokenizer, suffix) <= maxTokens) high = mid; else low = mid + 1;
  }
  return points[low]!;
}

async function embeddingText(body: string, headings: string[], contexts: ContextSpan[], redactions: Span[], start: number, end: number, input: SplitTextInput): Promise<{ text: string; refs: string[]; reduced: boolean }> {
  const tokenizer = input.options.tokenizer;
  const matching = contexts.filter(span => span.start < end && span.end > start);
  const refs = [...new Set(matching.flatMap(span => span.assetRefs))];
  const missingRefs = refs.filter(ref => !body.includes(ref));
  const mandatory = missingRefs.length ? `图片标识：${missingRefs.join(' ')}\n\n` : '';
  // Redact by original ranges so a URL/base64 hard-split across chunks cannot
  // leak its trailing fragment after the scheme has fallen in an earlier chunk.
  const sanitized = withoutTransport(input.content, start, end, redactions);
  const rawBody = sanitized.trim() ? sanitized : '[link]';
  if (await count(tokenizer, mandatory + rawBody) > input.options.maxEmbeddingTokens) throw new DocumentProcessingError('CHUNK_INPUT_TOO_LARGE', 'Chunk body and required asset references exceed the model input limit');
  const optional = [...(headings.length ? [embeddingBody(headings.join(' > '))] : []), ...matching.flatMap(span => span.tableHeader && start > span.start ? [embeddingBody(span.tableHeader.trimEnd())] : [])];
  let prefix = optional.join('\n\n');
  const full = prefix ? `${prefix}\n\n${mandatory}${rawBody}` : mandatory + rawBody;
  if (await count(tokenizer, full) <= input.options.maxEmbeddingTokens) return { text: full, refs, reduced: false };
  // Generated context can be reduced; original body is never truncated.
  const pieces = [...graphemes.segment(prefix)].map(part => part.segment);
  let low = 0; let high = pieces.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${pieces.slice(0, mid).join('')}\n\n${mandatory}${rawBody}`;
    if (await count(tokenizer, candidate) <= input.options.maxEmbeddingTokens) low = mid; else high = mid - 1;
  }
  prefix = pieces.slice(0, low).join('');
  return { text: prefix ? `${prefix}\n\n${mandatory}${rawBody}` : mandatory + rawBody, refs, reduced: true };
}

/** Stateless, source-preserving splitter. It never analyzes TOC or does IO. */
export async function splitTextIntoChunks(input: SplitTextInput, mapped?: MappedChunkBoundaries): Promise<ChunkDraft[]> {
  const { content, options } = input;
  if (!['markdown', 'text'].includes(input.format) || ![options.targetTokens, options.maxEmbeddingTokens, options.overlapTokens, options.tokenizer.maxInputTokens].every(Number.isSafeInteger)
    || !options.tokenizer.id || !options.tokenizer.model || options.overlapTokens < 0 || options.overlapTokens >= options.targetTokens || options.targetTokens > options.maxEmbeddingTokens || options.maxEmbeddingTokens > options.tokenizer.maxInputTokens) throw new DocumentProcessingError('SPLIT_OPTIONS_INVALID', 'Require 0 <= overlap < target <= embedding limit <= model input limit');
  const { targetSourceChars, maxSourceChars } = options;
  if (maxSourceChars !== undefined && (!Number.isSafeInteger(maxSourceChars) || maxSourceChars < 1)) throw new DocumentProcessingError('SPLIT_OPTIONS_INVALID', 'Source character limit must be a positive integer');
  if (targetSourceChars !== undefined && (!Number.isSafeInteger(targetSourceChars) || targetSourceChars < 1 || maxSourceChars === undefined || targetSourceChars > maxSourceChars)) throw new DocumentProcessingError('SPLIT_OPTIONS_INVALID', 'Require 0 < target source characters <= source character limit');
  if (!content.trim()) return [];
  const hintRanges = validateRanges(content, input);
  const plannedRanges = options.respectSections && input.structureHints ? hintRanges : [{ sourceStart: 0, sourceEnd: content.length, sectionId: null, headingPath: [] }];
  const ranges: SectionRange[] = [];
  let pendingStart: number | undefined;
  for (const range of plannedRanges) {
    if (!content.slice(range.sourceStart, range.sourceEnd).trim()) { pendingStart ??= range.sourceStart; continue; }
    ranges.push({ ...range, sourceStart: pendingStart ?? range.sourceStart }); pendingStart = undefined;
  }
  if (pendingStart !== undefined && ranges.length) ranges.at(-1)!.sourceEnd = content.length;
  const contexts = input.format === 'markdown' ? markdownContexts(content) : [];
  const redactions = transportSpans(content);
  const chunks: ChunkDraft[] = [];
  const mappedRanges = mapped && { ...mapped, clusters: graphemes.segment(content) };
  let cutIndex = 0;
  for (const range of ranges) {
    let previous: Span | undefined;
    let spans: Span[];
    if (mappedRanges) {
      const { cuts, recutStarts, clusters } = mappedRanges;
      spans = [];
      let start = range.sourceStart;
      let droppedBoundary = false;
      async function append(end: number): Promise<void> {
        const body = content.slice(start, end);
        if (body.trim()) {
          if (droppedBoundary || recutStarts.has(start) ||
            (maxSourceChars !== undefined && codePointLength(body) > maxSourceChars)) {
            spans.push(...await planSpans(content, { ...range, sourceStart: start, sourceEnd: end }, input));
          } else {
            spans.push({ start, end });
          }
        }
        start = end;
        droppedBoundary = false;
      }
      while (cutIndex < cuts.length && cuts[cutIndex]! <= range.sourceStart) cutIndex += 1;
      while (cutIndex < cuts.length && cuts[cutIndex]! < range.sourceEnd) {
        const cut = cuts[cutIndex++]!;
        if (clusters.containing(cut)?.index === cut) await append(cut);
        else droppedBoundary = true;
      }
      await append(range.sourceEnd);
    } else {
      spans = await planSpans(content, range, input);
    }
    for (let position = 0; position < spans.length; position += 1) {
      const span = spans[position]!;
      const sourceChars = maxSourceChars === undefined ? 0 : codePointLength(content.slice(span.start, span.end));
      const overlapLimit = targetSourceChars !== undefined && sourceChars <= targetSourceChars ? targetSourceChars : maxSourceChars;
      const remainingChars = (overlapLimit ?? Infinity) - sourceChars;
      let start = previous?.end === span.start ? await suffixStart(content, previous.start, previous.end, options.overlapTokens, options.tokenizer, remainingChars) : span.start;
      const hint = options.respectSections && input.structureHints ? range : hintRanges.find(candidate => candidate.sourceStart <= span.start && candidate.sourceEnd > span.start);
      let body = content.slice(start, span.end);
      // LC estimates each split before merging; real BPE counts plus overlap are
      // checked again on the exact body. Drop optional overlap if necessary.
      if (await count(options.tokenizer, embeddingBody(body)) > options.maxEmbeddingTokens) { start = span.start; body = content.slice(start, span.end); }
      let prepared: Awaited<ReturnType<typeof embeddingText>>;
      try {
        try { prepared = await embeddingText(body, hint?.headingPath ?? [], contexts, redactions, start, span.end, input); }
        catch (error) {
          // An asset reference can consume space not present in raw token
          // counts. Retry without optional overlap before refining the body.
          if (!(error instanceof DocumentProcessingError) || error.code !== 'CHUNK_INPUT_TOO_LARGE' || start === span.start) throw error;
          start = span.start; body = content.slice(start, span.end);
          prepared = await embeddingText(body, hint?.headingPath ?? [], contexts, redactions, start, span.end, input);
        }
      } catch (error) {
        if (!(error instanceof DocumentProcessingError) || error.code !== 'CHUNK_INPUT_TOO_LARGE') throw error;
        // LC trims whitespace before evaluating its proposals. Reattaching that
        // exact source whitespace, or adding mandatory asset context, can exceed
        // a tight hard cap. Refine the source range, never truncate its text.
        const raw = content.slice(span.start, span.end);
        const leading = raw.trimStart();
        const visible = leading.trimEnd();
        // An oversized edge of whitespace can outgrow the model budget by
        // itself. Keep the text together when that whitespace can't be indexed.
        if (maxSourceChars !== undefined && visible.length < raw.length &&
          await count(options.tokenizer, raw) - await count(options.tokenizer, visible) >= options.maxEmbeddingTokens) {
          span.start += raw.length - leading.length;
          span.end = span.start + visible.length;
          position -= 1;
          continue;
        }
        const boundaries = [...graphemes.segment(raw)].map(part => span.start + part.index);
        if (boundaries.length < 2) throw error;
        let middle = boundaries[Math.floor(boundaries.length / 2)]!;
        if (!content.slice(span.start, middle).trim() || !content.slice(middle, span.end).trim()) {
          const safe = boundaries.slice(1).find(boundary => content.slice(span.start, boundary).trim() && content.slice(boundary, span.end).trim());
          if (safe !== undefined) middle = safe;
          else if (maxSourceChars === undefined) throw error;
        }
        const refined = [{ start: span.start, end: middle }, { start: middle, end: span.end }];
        spans.splice(position, 1, ...refined.filter(part => content.slice(part.start, part.end).trim()));
        position -= 1; continue;
      }
      const tokenCount = await count(options.tokenizer, body);
      const embeddingTokenCount = await count(options.tokenizer, prepared.text);
      if (embeddingTokenCount > options.maxEmbeddingTokens) throw new DocumentProcessingError('CHUNK_INPUT_TOO_LARGE', 'Final embedding text exceeds the configured model limit');
      chunks.push({ ordinal: chunks.length, content: body, embedding_text: prepared.text, source_start: start, source_end: span.end, core_start: span.start, core_end: span.end, heading_path: [...(hint?.headingPath ?? [])], char_count: codePointLength(body), embedding_char_count: codePointLength(prepared.text), token_count: tokenCount, embedding_token_count: embeddingTokenCount, content_hash: sha(body), embedding_text_hash: sha(prepared.text), metadata: { splitterVersion: SPLITTER_VERSION, tokenizerId: options.tokenizer.id, structureHintsUsed: Boolean(input.structureHints), sectionId: hint?.sectionId ?? null, assetRefs: prepared.refs, prefixReduced: prepared.reduced } });
      previous = span;
    }
  }
  return chunks;
}
