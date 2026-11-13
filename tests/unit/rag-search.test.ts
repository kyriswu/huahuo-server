import { describe, expect, it, vi } from 'vitest';
import { dedupeByChunkKey, HttpRerankAdapter, MockRerankAdapter, rerankWithinBudget, type RagSearchCandidate, type RerankAdapter } from '../../src/modules/rag/search.js';

const row = (chunkKey: string, parentId = 'doc-1'): RagSearchCandidate => ({
  chunkKey,
  documentKey: 'doc-1',
  parentId,
  content: `content ${chunkKey}`,
  chunkIndex: Number(chunkKey.replace(/\D/g, '')) || 0,
  chunkCount: 3,
  denseScore: 0,
  keywordScore: 0,
  rrfScore: 0.03,
});

describe('RAG query ranking helpers', () => {
  it('deduplicates logical chunk keys without treating equal text as the same chunk', () => {
    const result = dedupeByChunkKey([row('c0'), { ...row('c0'), rrfScore: 0.05 }, { ...row('c1'), content: row('c0').content }]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ chunkKey: 'c0', rrfScore: 0.05 });
  });

  it('keeps the highest scored duplicate and supports the explicit Mock reranker', async () => {
    const merged = [row('c0'), row('c1'), row('c2')];
    const duplicate = [...merged, { ...merged[0]!, rerankScore: 99 }];
    const deduped = dedupeByChunkKey(duplicate);
    expect(deduped.filter((item) => item.chunkKey === 'c0')).toHaveLength(1);
    expect(deduped.find((item) => item.chunkKey === 'c0')?.rerankScore).toBe(99);
    const reranked = await new MockRerankAdapter().rerank('content c1', merged);
    expect(reranked[0]?.chunkKey).toBe('c1');
  });

  it('maps an OpenAI-compatible rerank response back to original candidates', async () => {
    const candidates = [row('c0'), row('c1')];
    const reranker = new HttpRerankAdapter({
      baseUrl: 'https://rerank.test/v1',
      model: 'rerank-test',
      fetchImpl: async () => new Response(JSON.stringify({ results: [{ index: 1, relevance_score: 0.95 }, { index: 0, relevance_score: 0.2 }] }), { status: 200 }),
    });
    const result = await reranker.rerank('question', candidates);
    expect(result.map((item) => item.chunkKey)).toEqual(['c1', 'c0']);
    expect(result[0]?.rerankScore).toBe(0.95);
  });

  it('cancels a slow HTTP reranker at the Note deadline and retains Milvus order', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const adapter = new HttpRerankAdapter({ baseUrl: 'https://rerank.test/v1', model: 'mock', fetchImpl: async (_url, options) => {
        signal = options?.signal ?? undefined;
        return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      } });
      const candidates = [row('c1'), row('c0')];
      const result = rerankWithinBudget(adapter, 'question', candidates, 200);
      await vi.advanceTimersByTimeAsync(200);
      expect(await result).toEqual({ candidates, fallback: 'timeout' });
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('bounds adapters that ignore cancellation and isolates late mutation', async () => {
    vi.useFakeTimers();
    try {
      const candidates = [row('c1'), row('c0')];
      const adapter: RerankAdapter = { rerank: async (_query, input) => { input.reverse(); input[0]!.content = 'not authoritative'; return new Promise(() => {}); } };
      const result = rerankWithinBudget(adapter, 'question', candidates, 200);
      await vi.advanceTimersByTimeAsync(200);
      expect(await result).toEqual({ candidates, fallback: 'timeout' });
      expect(candidates[0]?.chunkKey).toBe('c1');
      expect(candidates[1]?.content).toBe('content c0');
    } finally { vi.useRealTimers(); }
  });

  it.each(['error', 'invalid_response'] as const)('falls back on %s without trusting returned content', async reason => {
    const candidates = [row('c1'), row('c0')];
    const adapter: RerankAdapter = { rerank: async () => {
      if (reason === 'error') throw new Error('provider failed');
      return [row('outside-permission-scope'), row('c0')].map(candidate => ({ ...candidate, rerankScore: 1 }));
    } };
    expect(await rerankWithinBudget(adapter, 'question', candidates, 200)).toEqual({ candidates, fallback: reason });
  });

  it('uses scores from a successful rerank but keeps authoritative PostgreSQL content', async () => {
    const candidates = [row('c1'), row('c0')];
    const adapter: RerankAdapter = { rerank: async (_query, input) => input.map((candidate, i) => ({ ...candidate, content: 'untrusted', rerankScore: i })) };
    const result = await rerankWithinBudget(adapter, 'question', candidates, 200);
    expect(result.fallback).toBeUndefined();
    expect(result.candidates.map(candidate => [candidate.chunkKey, candidate.content])).toEqual([['c0', 'content c0'], ['c1', 'content c1']]);
  });
});

