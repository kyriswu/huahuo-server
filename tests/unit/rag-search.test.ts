import { describe, expect, it, vi } from 'vitest';
import { HttpRerankAdapter, MockRerankAdapter, rerankWithinBudget, type RagSearchCandidate, type RerankAdapter } from '../../src/modules/rag/search.js';

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
  it('supports the explicit Mock reranker', async () => {
    const merged = [row('c0'), row('c1'), row('c2')];
    const reranked = await new MockRerankAdapter().rerank('content c1', merged);
    expect(reranked[0]?.chunkKey).toBe('c1');
  });

  it('maps a native DashScope rerank response back to original candidates', async () => {
    const candidates = [row('c0'), row('c1')];
    const reranker = new HttpRerankAdapter({
      baseUrl: 'https://rerank.test/v1',
      model: 'rerank-test',
      fetchImpl: async () => new Response(JSON.stringify({ output: { results: [{ index: 1, relevance_score: 0.95 }, { index: 0, relevance_score: 0.2 }] } }), { status: 200 }),
    });
    const result = await reranker.rerank('question', candidates);
    expect(result.map((item) => item.chunkKey)).toEqual(['c1', 'c0']);
    expect(result[0]?.rerankScore).toBe(0.95);
  });

  it('sends native input/parameters and rejects duplicate or malformed result indexes',async()=>{
    const fetchImpl=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({output:{results:[{index:1,relevance_score:0.9},{index:0,relevance_score:0.1}]}})));
    const adapter=new HttpRerankAdapter({baseUrl:'https://rerank.test/api/v1',apiKey:'fixture-key',model:'qwen3.7-text-rerank',fetchImpl});
    await adapter.rerank('question',[row('c0'),row('c1')]);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://rerank.test/api/v1/services/rerank/text-rerank/text-rerank');
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toEqual({model:'qwen3.7-text-rerank',input:{query:'question',documents:['content c0','content c1']},parameters:{top_n:2}});
    for(const results of [[{index:0,relevance_score:0.9},{index:0,relevance_score:0.8}],[{index:0,relevance_score:1.1},{index:1,relevance_score:0.8}],[{index:'0',relevance_score:0.9},{index:1,relevance_score:0.8}]]){
      fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({output:{results}})));
      await expect(adapter.rerank('question',[row('c0'),row('c1')])).rejects.toMatchObject({code:'RERANK_RESPONSE_INVALID'});
    }
  });

  it('cancels a slow HTTP reranker at the content asset deadline and retains Milvus order', async () => {
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
  it('rejects an oversized rerank body without another provider request',async()=>{
    const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(new Response(' '.repeat(1024*1024+1)));
    const adapter=new HttpRerankAdapter({baseUrl:'https://rerank.test/v1',model:'fixture',fetchImpl});
    await expect(adapter.rerank('question',[row('c0')])).rejects.toMatchObject({code:'RERANK_RESPONSE_INVALID',retryable:false});
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('includes the rerank response body in its timeout budget',async()=>{
    vi.useFakeTimers();
    try{
      const fetchImpl=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>new Response(new ReadableStream({start(controller){
        init!.signal!.addEventListener('abort',()=>controller.error(init!.signal!.reason),{once:true});
      }})));
      const adapter=new HttpRerankAdapter({baseUrl:'https://rerank.test/v1',model:'fixture',timeoutMs:20,fetchImpl});
      const pending=expect(adapter.rerank('question',[row('c0')])).rejects.toMatchObject({code:'RERANK_PROVIDER_TIMEOUT',retryable:true});
      await vi.advanceTimersByTimeAsync(20);await pending;
      expect(fetchImpl).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    }finally{vi.useRealTimers();}
  });

});

