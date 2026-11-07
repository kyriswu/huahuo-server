import { diffChars } from 'diff';
import { splitTextIntoChunks, type MappedChunkBoundaries } from '../../lib/document-processing/splitter.js';
import type { ChunkDraft, SplitTextInput } from '../../lib/document-processing/types.js';

export interface IndexedNoteChunk {
  id: string;
  start: number;
  end: number;
  coreStart: number;
  coreEnd: number;
  text: string;
  embeddingText: string;
}

export interface PlannedNoteChunk extends ChunkDraft {
  /** The exact same stored source and model input can reuse its Milvus point. */
  reuseId?: string;
  /** A changed one-to-one core may retain its logical chunk identity. */
  previousId?: string;
}

interface Edit {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

function editsFromDiff(parts: NonNullable<ReturnType<typeof diffChars>>): Edit[] {
  const edits: Edit[] = [];
  let oldOffset = 0;
  let newOffset = 0;
  let current: Edit | undefined;
  for (const part of parts) {
    // Offsets in PostgreSQL and the splitter are UTF-16, regardless of the
    // diff library's character count.
    const length = part.value.length;
    if (!part.added && !part.removed) {
      current = undefined;
      oldOffset += length;
      newOffset += length;
      continue;
    }
    if (!current) {
      current = { oldStart: oldOffset, oldEnd: oldOffset, newStart: newOffset, newEnd: newOffset };
      edits.push(current);
    }
    if (part.removed) oldOffset += length;
    else newOffset += length;
    current.oldEnd = oldOffset;
    current.newEnd = newOffset;
  }
  return edits;
}

function insideSurrogatePair(text: string, offset: number): boolean {
  const high = text.charCodeAt(offset - 1);
  const low = text.charCodeAt(offset);
  return high >= 0xD800 && high <= 0xDBFF && low >= 0xDC00 && low <= 0xDFFF;
}

/** Treat the entire differing middle as one edit when exact diff stops. */
function edgeEdit(oldText: string, newText: string): Edit {
  let start = 0;
  const limit = Math.min(oldText.length, newText.length);
  while (start < limit && oldText.charCodeAt(start) === newText.charCodeAt(start)) start += 1;
  if (insideSurrogatePair(oldText, start) || insideSurrogatePair(newText, start)) start -= 1;

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  if (insideSurrogatePair(oldText, oldEnd) || insideSurrogatePair(newText, newEnd)) {
    oldEnd += 1;
    newEnd += 1;
  }
  return { oldStart: start, oldEnd, newStart: start, newEnd };
}

function mappedBoundaries(oldChunks: readonly IndexedNoteChunk[], oldText: string, newText: string, edits: Edit[]) {
  const oldCuts = new Set([0, oldText.length]);
  let lastCoreEnd = 0;
  for (const chunk of oldChunks) {
    if (!Number.isSafeInteger(chunk.coreStart) || !Number.isSafeInteger(chunk.coreEnd) ||
      chunk.coreStart < lastCoreEnd || chunk.coreStart >= chunk.coreEnd || chunk.coreEnd > oldText.length ||
      !Number.isSafeInteger(chunk.start) || chunk.start < 0 || chunk.start > chunk.coreStart || chunk.end !== chunk.coreEnd ||
      oldText.slice(chunk.start, chunk.end) !== chunk.text) return undefined;
    oldCuts.add(chunk.coreStart);
    oldCuts.add(chunk.coreEnd);
    lastCoreEnd = chunk.coreEnd;
  }

  const positions = new Map<number, number>([[0, 0], [oldText.length, newText.length]]);
  const cuts: number[] = [];
  const recutStarts = new Set<number>();
  let editIndex = 0;
  let lastCut = 0;
  let droppedCut = false;
  for (const cut of [...oldCuts].sort((left, right) => left - right)) {
    if (cut === 0) continue;
    // Assign an insertion exactly at a shared cut to the block on the left.
    while (editIndex < edits.length && edits[editIndex]!.oldEnd <= cut) editIndex += 1;
    const nextEdit = edits[editIndex];
    if (nextEdit && nextEdit.oldStart < cut) {
      droppedCut = true;
      continue;
    }
    const previousEdit = edits[editIndex - 1];
    const mapped = cut === oldText.length ? newText.length : cut + (previousEdit ? previousEdit.newEnd - previousEdit.oldEnd : 0);
    positions.set(cut, mapped);
    if (mapped === lastCut) {
      droppedCut = false;
      continue;
    }
    if (droppedCut) recutStarts.add(lastCut);
    if (mapped < newText.length) cuts.push(mapped);
    droppedCut = false;
    lastCut = mapped;
  }
  return { boundaries: { cuts, recutStarts } satisfies MappedChunkBoundaries, positions };
}

function assignIdentities(drafts: ChunkDraft[], oldChunks: readonly IndexedNoteChunk[], positions?: Map<number, number>): PlannedNoteChunk[] {
  const oldByCore = new Map<string, IndexedNoteChunk>();
  for (const chunk of oldChunks) {
    const start = positions?.get(chunk.coreStart);
    const end = positions?.get(chunk.coreEnd);
    if (start !== undefined && end !== undefined && start < end) oldByCore.set(`${start}:${end}`, chunk);
  }
  const used = new Set<string>();
  const chunks: PlannedNoteChunk[] = drafts.map(draft => {
    const old = oldByCore.get(`${draft.core_start}:${draft.core_end}`);
    if (old && old.text === draft.content && old.embeddingText === draft.embedding_text) {
      used.add(old.id);
      return { ...draft, reuseId: old.id };
    }
    return draft;
  });

  // A fallback split or an edit that moves text can still reproduce an
  // identical block. Match occurrences one-to-one.
  const oldByText = new Map<string, string[]>();
  for (const old of oldChunks) {
    if (used.has(old.id)) continue;
    const key = JSON.stringify([old.text, old.embeddingText]);
    const ids = oldByText.get(key) ?? [];
    ids.push(old.id);
    oldByText.set(key, ids);
  }
  for (const chunk of chunks) {
    if (chunk.reuseId) continue;
    const id = oldByText.get(JSON.stringify([chunk.content, chunk.embedding_text]))?.pop();
    if (id) {
      chunk.reuseId = id;
      used.add(id);
    }
  }
  for (const chunk of chunks) {
    if (chunk.reuseId) continue;
    const old = oldByCore.get(`${chunk.core_start}:${chunk.core_end}`);
    if (old && !used.has(old.id)) {
      chunk.previousId = old.id;
      used.add(old.id);
    }
  }
  return chunks;
}

/** The caller scopes old chunks to the same model and processing configuration. */
export async function planNoteChunks(
  input: SplitTextInput,
  oldText: string,
  oldChunks: readonly IndexedNoteChunk[],
  { timeout = 50, maxEditLength = 2_000 }: { timeout?: number; maxEditLength?: number } = {},
): Promise<{ chunks: PlannedNoteChunk[]; fallback: boolean }> {
  if (!oldChunks.length || !input.content.trim()) return { chunks: await splitTextIntoChunks(input), fallback: false };
  const parts = oldText === input.content ? [] : diffChars(oldText, input.content, { timeout, maxEditLength });
  let mapped;
  if (parts) {
    mapped = mappedBoundaries(oldChunks, oldText, input.content, editsFromDiff(parts));
  } else {
    const edit = edgeEdit(oldText, input.content);
    mapped = mappedBoundaries(oldChunks, oldText, input.content, [edit]);
    // A large insertion at an old cut can preserve both adjacent cores.
    if (mapped && edit.oldStart === edit.oldEnd && mapped.positions.has(edit.oldStart)) {
      for (const cut of [edit.newStart, edit.newEnd]) {
        if (cut > 0 && cut < input.content.length && !mapped.boundaries.cuts.includes(cut)) mapped.boundaries.cuts.push(cut);
      }
      mapped.boundaries.cuts.sort((left, right) => left - right);
      mapped.boundaries.recutStarts.add(edit.newStart);
    }
    if (!mapped?.boundaries.cuts.length) mapped = undefined;
  }
  const drafts = await splitTextIntoChunks(input, mapped?.boundaries);
  return { chunks: assignIdentities(drafts, oldChunks, mapped?.positions), fallback: !parts || !mapped };
}
