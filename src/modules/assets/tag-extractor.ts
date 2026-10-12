export interface TagExtractionInput {
  noteId: string;
  noteRevisionId: string;
  title: string;
  rawText: string;
  segment?: { index: number; count: number };
}

export interface TagExtractionResult {
  provider: string;
  labels: unknown;
}

/** Provider boundary for tag extraction. It never owns note/tag persistence. */
export interface TagExtractor {
  readonly provider: string;
  extract(input: TagExtractionInput): Promise<TagExtractionResult>;
}

const stopWords = new Set(['的', '了', '是', 'and', 'the', 'this', 'that']);

/** Local deterministic fixture used only when explicitly selected in development/test. */
export class DeterministicTagExtractor implements TagExtractor {
  readonly provider = 'deterministic-fixture';

  async extract(input: TagExtractionInput): Promise<TagExtractionResult> {
    // Bounded chunks keep this fixture representative of a provider budget without
    // creating embeddings or a vector/chunk index.
    const bounded = `${input.title}\n${input.rawText}`;
    const candidates: string[] = [];
    for (let offset = 0; offset < bounded.length && candidates.length < 5; offset += 4_000) {
      const chunk = bounded.slice(offset, offset + 4_000);
      for (const value of chunk.match(/[\p{L}\p{N}]{2,24}/gu) ?? []) {
        const label = value.normalize('NFKC').trim().toLocaleLowerCase();
        if (!stopWords.has(label) && !candidates.includes(label)) candidates.push(label);
        if (candidates.length >= 5) break;
      }
    }
    return { provider: this.provider, labels: candidates };
  }
}

export class UnavailableTagExtractor implements TagExtractor {
  constructor(readonly provider: string) {}
  async extract(): Promise<TagExtractionResult> {
    throw new Error(`TAG_PROVIDER_UNAVAILABLE:${this.provider}`);
  }
}

export function tagExtractorFor(provider: 'deterministic' | 'disabled' | 'llm' | 'dify'): TagExtractor {
  if (provider === 'deterministic') return new DeterministicTagExtractor();
  return new UnavailableTagExtractor(provider);
}

export function validateTagLabels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 5) throw new Error('TAG_OUTPUT_NOT_ARRAY');
  const labels: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('TAG_OUTPUT_NOT_STRING');
    const label = item.normalize('NFKC').trim();
    if (label.length < 1 || [...label].length > 24) throw new Error('TAG_OUTPUT_LENGTH');
    const normalized = label.toLowerCase();
    if ([...normalized].length > 24 || [...label].some(ch => ch.codePointAt(0)! < 32 || ch.codePointAt(0) === 127)) throw new Error('TAG_OUTPUT_INVALID');
    if (!labels.some(existing => existing.toLocaleLowerCase() === normalized)) labels.push(label);
    if (labels.length > 5) throw new Error('TAG_OUTPUT_TOO_MANY');
  }
  return labels;
}

/** Sequential, bounded provider calls; text segments are transient, never indexed. */
export async function extractBoundedTags(provider: TagExtractor, input: TagExtractionInput): Promise<TagExtractionResult> {
  const chunkSize = 16_000;
  const count = Math.max(1, Math.ceil(input.rawText.length / chunkSize));
  if (count > 32) throw new Error('TAG_INPUT_BUDGET_EXCEEDED');
  const candidates = new Map<string, { label: string; count: number }>();
  for (let index = 0; index < count; index++) {
    const result = await provider.extract({ ...input, rawText: input.rawText.slice(index * chunkSize, (index + 1) * chunkSize), segment: { index, count } });
    if (result.provider !== provider.provider) throw new Error('TAG_OUTPUT_PROVIDER_INVALID');
    for (const label of validateTagLabels(result.labels)) {
      const key = label.toLowerCase(), previous = candidates.get(key);
      candidates.set(key, { label: previous?.label ?? label, count: (previous?.count ?? 0) + 1 });
    }
  }
  return { provider: provider.provider, labels: [...candidates.values()].sort((a, b) => b.count - a.count).slice(0, 5).map(x => x.label) };
}
