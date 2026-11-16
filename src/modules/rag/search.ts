/** Reranker contract and stable-key deduplication shared by RAG queries.
 *
 * These helpers deliberately know nothing about PostgreSQL, Milvus, or the
 * document parser.  The query service is responsible for applying workspace,
 * active-index, and ready-state filters before passing candidates here.
 */

export interface RagSearchCandidate {
  chunkKey: string;
  documentKey: string;
  /** Whole source record ID; sections do not form persisted chunk parents. */
  parentId: string;
  content: string;
  chunkIndex: number;
  chunkCount: number;
  denseScore: number;
  keywordScore: number;
  /** Retrieval fusion score, supplied by a native or application-composed index. */
  rrfScore: number;
  rerankScore?: number;
  embeddingProfile?: string;
  indexBuildId?: string;
  metadata?: Record<string, unknown>;
}

function finiteScore(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Remove duplicate logical chunks, preferring ready/active results upstream. */
export function dedupeByChunkKey<T extends { chunkKey: string; rrfScore?: number; rerankScore?: number }>(rows: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    const current = byKey.get(row.chunkKey);
    if (!current || finiteScore(row.rerankScore ?? row.rrfScore) > finiteScore(current.rerankScore ?? current.rrfScore)) byKey.set(row.chunkKey, row);
  }
  return [...byKey.values()];
}

export interface RerankAdapter {
  rerank(query: string, candidates: RagSearchCandidate[], options?: { signal?: AbortSignal }): Promise<Array<RagSearchCandidate & { rerankScore: number }>>;
}

export type RerankFallback = 'timeout' | 'error' | 'invalid_response';

/** Retain only authorized candidates in their Milvus order on failure. The
 * deadline includes body decoding and also bounds adapters ignoring abort. */
export async function rerankWithinBudget(adapter: RerankAdapter, query: string, candidates: RagSearchCandidate[], budgetMs: number): Promise<{ candidates: RagSearchCandidate[]; fallback?: RerankFallback }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const original = candidates.map(candidate => ({ ...candidate }));
  try {
    const ranked = await Promise.race([
      Promise.resolve().then(() => adapter.rerank(query, original.map(candidate => ({ ...candidate })), { signal: controller.signal })),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new RerankError('RERANK_BUDGET_EXCEEDED', 'Rerank deadline reached')); }, budgetMs); }),
    ]);
    const byKey = new Map(original.map(candidate => [candidate.chunkKey, candidate]));
    const seen = new Set<string>();
    if (ranked.length !== original.length) return { candidates: original, fallback: 'invalid_response' };
    const trusted: RagSearchCandidate[] = [];
    for (const row of ranked) {
      const candidate = byKey.get(row.chunkKey);
      if (!candidate || seen.has(row.chunkKey) || !Number.isFinite(row.rerankScore)) return { candidates: original, fallback: 'invalid_response' };
      seen.add(row.chunkKey);
      trusted.push({ ...candidate, rerankScore: row.rerankScore });
    }
    return { candidates: trusted.sort((a, b) => b.rerankScore! - a.rerankScore!) };
  } catch (error) {
    return { candidates: original, fallback: error instanceof RerankError && error.code === 'RERANK_BUDGET_EXCEEDED' ? 'timeout' : 'error' };
  } finally { if (timer) clearTimeout(timer); }
}

export class RerankError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RerankError';
  }
}

export interface HttpRerankOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface RerankProviderRow { index?: unknown; relevance_score?: unknown }

/** Native DashScope rerank API. Only scores and input indexes are trusted. */
export class HttpRerankAdapter implements RerankAdapter {
  constructor(private readonly options: HttpRerankOptions) {}

  async rerank(query: string, candidates: RagSearchCandidate[], options?: { signal?: AbortSignal }): Promise<Array<RagSearchCandidate & { rerankScore: number }>> {
    if (!candidates.length) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl.replace(/\/$/u, '')}/services/rerank/text-rerank/text-rerank`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.options.model, input: { query, documents: candidates.map((candidate) => candidate.content) }, parameters: { top_n: candidates.length } }),
        redirect: 'error',
        signal: options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
      });
      if (!response.ok) { await response.body?.cancel(); throw new RerankError('RERANK_PROVIDER_UNAVAILABLE', `Rerank provider HTTP ${response.status}`, response.status >= 500 || response.status === 429); }
      let payload: unknown;
      try { payload = await response.json(); } catch (error) { throw new RerankError('RERANK_RESPONSE_INVALID', 'Rerank provider returned invalid JSON', false, { cause: error }); }
      const resultObject = payload && typeof payload === 'object' ? payload as { output?: { results?: unknown } } : {};
      const rawRows = Array.isArray(resultObject.output?.results) ? resultObject.output.results : [];
      const rows = rawRows as RerankProviderRow[];
      if (rows.length !== candidates.length) throw new RerankError('RERANK_RESPONSE_INVALID', 'Rerank provider returned an unexpected result count');
      const seen = new Set<number>();
      return rows.map((row) => {
        const index = row?.index;
        const score = row?.relevance_score;
        if (typeof index!=='number'||!Number.isInteger(index) || index < 0 || index >= candidates.length || seen.has(index) || typeof score!=='number'||!Number.isFinite(score)||score<0||score>1) throw new RerankError('RERANK_RESPONSE_INVALID', 'Rerank provider returned an invalid result');
        seen.add(index);
        return { ...candidates[index]!, rerankScore: score };
      }).sort((left, right) => right.rerankScore - left.rerankScore);
    } catch (error) {
      if (error instanceof RerankError) throw error;
      throw new RerankError(error instanceof Error && error.name === 'AbortError' ? 'RERANK_PROVIDER_TIMEOUT' : 'RERANK_PROVIDER_UNAVAILABLE', 'Rerank request failed', true, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Deterministic test adapter used only by tests and explicit mock mode. */
export class MockRerankAdapter implements RerankAdapter {
  async rerank(query: string, candidates: RagSearchCandidate[]): Promise<Array<RagSearchCandidate & { rerankScore: number }>> {
    const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    return candidates.map((candidate) => {
      const content = candidate.content.toLocaleLowerCase();
      const matched = terms.reduce((count, term) => count + (content.includes(term) ? 1 : 0), 0);
      return { ...candidate, rerankScore: matched + candidate.rrfScore };
    }).sort((left, right) => right.rerankScore - left.rerankScore);
  }
}

