import { describe, expect, it, vi } from 'vitest';
import * as diff from 'diff';
import { splitTextIntoChunks } from '../../../src/lib/document-processing/splitter.js';
import type { SplitTextInput } from '../../../src/lib/document-processing/types.js';
import { planNoteChunks, type IndexedNoteChunk } from '../../../src/modules/ingestion/delta.js';

vi.mock('diff', async importOriginal => {
  const original = await importOriginal<typeof diff>();
  return { ...original, diffChars: vi.fn(original.diffChars) };
});
const boundedDiff: { diffChars: (old: string, next: string, options: { timeout: number; maxEditLength: number }) => ReturnType<typeof diff.diffChars> | undefined } = diff;

const oldText = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN';
const input = (content: string, overlapTokens = 0): SplitTextInput => ({
  content,
  format: 'text',
  options: {
    tokenizer: { id: 'code-points', model: 'test', maxInputTokens: 30, count: text => [...text].length },
    targetTokens: 20,
    maxEmbeddingTokens: 30,
    targetSourceChars: 10,
    maxSourceChars: 10,
    overlapTokens,
    respectSections: false,
  },
});

async function indexedChunks(source: SplitTextInput, cuts?: readonly number[]): Promise<IndexedNoteChunk[]> {
  const chunks = await splitTextIntoChunks(source, cuts ? { cuts, recutStarts: new Set() } : undefined);
  return chunks.map((chunk, index) => ({
    id: String(index),
    start: chunk.source_start,
    end: chunk.source_end,
    coreStart: chunk.core_start,
    coreEnd: chunk.core_end,
    text: chunk.content,
    embeddingText: chunk.embedding_text,
  }));
}

describe('Note offset delta planning', () => {
  it('preserves an edited block ID when its trailing half is deleted', async () => {
    const old = await indexedChunks(input(oldText));
    const next = oldText.slice(0, 15) + oldText.slice(20);
    const { chunks, fallback } = await planNoteChunks(input(next), oldText, old);
    expect(fallback).toBe(false);
    expect(chunks.map(chunk => [chunk.content, chunk.core_start, chunk.core_end, chunk.reuseId, chunk.previousId])).toEqual([
      ['abcdefghij', 0, 10, '0', undefined],
      ['klmno', 10, 15, undefined, '1'],
      ['uvwxyzABCD', 15, 25, '2', undefined],
      ['EFGHIJKLMN', 25, 35, '3', undefined],
    ]);
  });

  it('resplits the crossed blocks and maps unaffected blocks with UTF-16 offsets', async () => {
    const old = await indexedChunks(input(oldText));
    const next = oldText.slice(0, 16) + '😀' + oldText.slice(24);
    const { chunks, fallback } = await planNoteChunks(input(next), oldText, old);
    expect(fallback).toBe(false);
    expect(chunks.map(chunk => chunk.content).join('')).toBe(next);
    expect(chunks.map(chunk => chunk.reuseId)).toEqual(['0', undefined, undefined, '3']);
    expect(chunks.at(-1)).toMatchObject({ core_start: 24, core_end: 34, reuseId: '3' });
  });

  it('falls back when the edit budget is exhausted and still reuses exact matches', async () => {
    const old = await indexedChunks(input(oldText));
    const next = oldText.slice(0, 10) + '改'.repeat(20) + oldText.slice(30);
    const { chunks, fallback } = await planNoteChunks(input(next), oldText, old, { maxEditLength: 2 });
    expect(fallback).toBe(true);
    expect(chunks.map(chunk => chunk.content).join('')).toBe(next);
    expect(chunks.map(chunk => chunk.reuseId)).toEqual(['0', undefined, undefined, '3']);
  });

  it('keeps a shifted suffix cut after a length-changing edit exceeds the diff budget', async () => {
    const old = await indexedChunks(input(oldText));
    const next = oldText.slice(0, 10) + '改'.repeat(21) + '😀' + oldText.slice(30);
    const { chunks, fallback } = await planNoteChunks(input(next), oldText, old, { maxEditLength: 2 });
    expect(fallback).toBe(true);
    expect(chunks.map(chunk => chunk.content).join('')).toBe(next);
    expect(chunks.map(chunk => chunk.reuseId)).toEqual(['0', undefined, undefined, undefined, '3']);
    expect(chunks.at(-1)).toMatchObject({ core_start: 33, core_end: 43, reuseId: '3' });
  });

  it('keeps the first old core after a large leading insertion exceeds the diff budget', async () => {
    const old = await indexedChunks(input(oldText));
    const next = '改'.repeat(13) + oldText;
    const { chunks, fallback } = await planNoteChunks(input(next), oldText, old, { maxEditLength: 2 });
    expect(fallback).toBe(true);
    expect(chunks.map(chunk => chunk.content).join('')).toBe(next);
    expect(chunks.map(chunk => chunk.reuseId)).toEqual([undefined, undefined, '0', '1', '2', '3']);
  });

  it('retains the first surviving core when a deletion consumes two whole blocks', async () => {
    const next = 'ABCDEFG\nHIJK';
    const text = 'abcdefghijkl' + next;
    const source = input(text);
    source.options.targetSourceChars = 8;
    source.options.maxSourceChars = 12;
    const old = await indexedChunks(source, [6, 12]);
    const { chunks } = await planNoteChunks({ ...source, content: next }, text, old);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ core_start: 0, core_end: next.length, reuseId: '2' });
  });

  it('rechecks the context of an untouched core whose overlap changed', async () => {
    const text = 'abcdefghi\njklmnopqr\nstuvwxyzA\nBCDEFGHIJ\n';
    const source = input(text, 2);
    source.options.targetSourceChars = 8;
    source.options.maxSourceChars = 12;
    const old = await indexedChunks(source);
    const cut = old[0]!.coreEnd;
    const next = text.slice(0, cut - 2) + '新' + text.slice(cut - 1);
    const edited = { ...source, content: next };
    const { chunks } = await planNoteChunks(edited, text, old);
    const following = chunks.find(chunk => chunk.core_start === cut);
    expect(following?.content).toContain('新');
    expect(following?.reuseId).toBeUndefined();
    expect(following?.previousId).toBe('1');
  });

  it.each([0, 20, oldText.length])('F02 preserves original cores after a large paste at %i', async offset => {
    const old = await indexedChunks(input(oldText));
    const pasted = '新'.repeat(32);
    const next = oldText.slice(0, offset) + pasted + oldText.slice(offset);
    const { chunks, fallback } = await planNoteChunks(input(next), oldText, old, { maxEditLength: 2 });
    expect(fallback).toBe(true);
    expect(chunks.map(chunk => chunk.content).join('')).toBe(next);
    expect(chunks.flatMap(chunk => chunk.reuseId ? [chunk.reuseId] : [])).toEqual(old.map(chunk => chunk.id));
  });

  it('F03 retains the shifted suffix when most of the document is deleted', async () => {
    const old = await indexedChunks(input(oldText));
    const next = oldText.slice(30);
    const { chunks, fallback } = await planNoteChunks(input(next), oldText, old, { maxEditLength: 2 });
    expect(fallback).toBe(true);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ core_start: 0, core_end: next.length, reuseId: '3', content: next });
  });

  it('F05 uses the same bounded fallback when the diff deadline expires', async () => {
    const old = await indexedChunks(input(oldText));
    const next = oldText.slice(0, 10) + '截止期限😀' + oldText.slice(30);
    const timedOut = vi.spyOn(boundedDiff, 'diffChars').mockReturnValueOnce(undefined);
    try {
      const { chunks, fallback } = await planNoteChunks(input(next), oldText, old, { timeout: 1, maxEditLength: 1000 });
      expect(timedOut).toHaveBeenCalledWith(oldText, next, { timeout: 1, maxEditLength: 1000 });
      expect(fallback).toBe(true);
      expect(chunks.map(chunk => chunk.content).join('')).toBe(next);
      expect(chunks.flatMap(chunk => chunk.reuseId ? [chunk.reuseId] : [])).toEqual(['0', '3']);
    } finally { timedOut.mockRestore(); }
  });

  it.each(['small', 'large', 'repetitive'])('F06/F07 handles a %s edit in 10000 unbroken characters', async operation => {
    const repeated = '甲乙丙丁'.repeat(2500);
    const original = operation === 'repetitive' ? repeated : Array.from({ length: 10000 }, (_, index) => String.fromCharCode(0x4e00 + index)).join('');
    const source = input(original);
    Object.assign(source.options, { targetSourceChars: 300, maxSourceChars: 500, targetTokens: 450, maxEmbeddingTokens: 500 });
    source.options.tokenizer = { ...source.options.tokenizer, maxInputTokens: 500 };
    const old = await indexedChunks(source);
    const next = operation === 'small' ? original.slice(0, 875) + '😀' + original.slice(875)
      : operation === 'large' ? original.slice(0, 2000) + '新'.repeat(3222) + original.slice(6000)
        : '新头' + original.slice(2, 2500) + '新中段' + original.slice(2502, 8900) + original.slice(9000) + '新尾';
    const { chunks, fallback } = await planNoteChunks({ ...source, content: next }, original, old, { maxEditLength: operation === 'large' ? 20 : 500 });
    expect(fallback).toBe(operation === 'large');
    expect(chunks.map(chunk => chunk.content).join('')).toBe(next);
    const reused = chunks.flatMap(chunk => chunk.reuseId ? [chunk.reuseId] : []);
    expect(reused.length).toBeGreaterThan(old.length / 2);
    expect(new Set(reused).size).toBe(reused.length);
    for (const chunk of chunks) {
      expect(next.slice(chunk.source_start, chunk.source_end)).toBe(chunk.content);
      expect([...chunk.content].length).toBeLessThanOrEqual(500);
      expect(chunk.embedding_token_count).toBeLessThanOrEqual(500);
    }
  });

  it.each([{ start: 0.5 }, { coreStart: -1 }, { coreEnd: 99 }])('F08 discards invalid stored bounds %j', async invalid => {
    const old = await indexedChunks(input(oldText));
    old[0] = { ...old[0]!, ...invalid };
    const next = oldText.slice(0, 5) + '改' + oldText.slice(6);
    const { chunks, fallback } = await planNoteChunks(input(next), oldText, old);
    expect(fallback).toBe(true);
    expect(chunks.map(chunk => chunk.content).join('')).toBe(next);
    expect(chunks.flatMap(chunk => chunk.reuseId ? [chunk.reuseId] : [])).toEqual(['1', '2', '3']);
  });
});
