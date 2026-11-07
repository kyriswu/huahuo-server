import { describe, expect, it } from 'vitest';
import { dedupeByChunkKey, HttpRerankAdapter, MockRerankAdapter, type RagSearchCandidate } from '../../src/modules/rag/search.js';

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
});

