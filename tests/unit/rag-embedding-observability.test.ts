import { describe, expect, it, vi } from 'vitest';
import { BailianEmbeddingClient, type EmbeddingAttempt } from '../../src/modules/rag/adapters/embedding.js';

const options = { baseUrl: 'https://embedding.test/v1', apiKey: 'test-only-not-a-real-key', model: 'test', dimensions: 2, timeoutMs: 1000, maxRetries: 2 };
const vector = () => new Response(JSON.stringify({ output: { embeddings: [{ text_index: 0, embedding: [1, 2] }] } }));

describe('Embedding attempt observations', () => {
  it('uses the native Beijing route, query/document semantics, and restores text_index order',async()=>{
    const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({output:{embeddings:[{text_index:1,embedding:[3,4]},{text_index:0,embedding:[1,2]}]}})));
    const client=new BailianEmbeddingClient({...options,fetchImpl});
    expect(await client.embed(['one','two'],{textType:'query'})).toEqual([[1,2],[3,4]]);
    expect(fetchImpl).toHaveBeenCalledWith('https://embedding.test/v1/services/embeddings/text-embedding/text-embedding',expect.objectContaining({redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer test-only-not-a-real-key'}}));
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toEqual({model:'test',input:{texts:['one','two']},parameters:{text_type:'query'}});
  });
  it('splits oversized logical batches at the provider limit of 20 without losing order',async()=>{
    const fetchImpl=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
      const body=JSON.parse(String(init!.body)) as {input:{texts:string[]}};
      return new Response(JSON.stringify({output:{embeddings:body.input.texts.map((text,text_index)=>({text_index,embedding:[Number(text),1]})).reverse()}}));
    });
    const result=await new BailianEmbeddingClient({...options,fetchImpl}).embed(Array.from({length:43},(_,i)=>String(i)));
    expect(fetchImpl.mock.calls.map(c=>JSON.parse(String(c[1]!.body)).input.texts.length)).toEqual([20,20,3]);
    expect(result.map(v=>v[0])).toEqual(Array.from({length:43},(_,i)=>i));
  });
  it.each([
    [{text_index:0,embedding:[1]}],
    [{text_index:0,embedding:[1,2]},{text_index:0,embedding:[3,4]}],
    [{embedding:[1,2]}],
    [{text_index:0.5,embedding:[1,2]}],
    [{text_index:0,embedding:[null,2]}],
  ].map(embeddings=>({embeddings})))('rejects invalid native vectors without retrying',async({embeddings})=>{
    const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({output:{embeddings}})));
    await expect(new BailianEmbeddingClient({...options,fetchImpl}).embed(embeddings.length===2?['a','b']:['a'])).rejects.toMatchObject({retryable:false});
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('rejects oversized input before sending it upstream',async()=>{
    const fetchImpl=vi.fn<typeof fetch>();
    await expect(new BailianEmbeddingClient({...options,fetchImpl}).embed(['😀'.repeat(32000)])).rejects.toMatchObject({code:'EMBEDDING_INPUT_INVALID'});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('records each retry separately without credentials, input or vectors', async () => {
    const attempts: EmbeddingAttempt[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(vector());
    const client = new BailianEmbeddingClient({ ...options, fetchImpl });
    expect(await client.embed(['private text'], { onAttempt: attempt => attempts.push(attempt) })).toEqual([[1, 2]]);
    expect(attempts).toEqual([
      expect.objectContaining({ attempt: 0, status: 503, succeeded: false, durationMs: expect.any(Number), firstByteMs: expect.any(Number) }),
      expect.objectContaining({ attempt: 1, status: 200, succeeded: true, durationMs: expect.any(Number), firstByteMs: expect.any(Number) }),
    ]);
    expect(JSON.stringify(attempts)).not.toMatch(/private|test-only|embedding|authorization/iu);
    expect(attempts[0]!.durationMs).toBeLessThan(100);
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(sent).toEqual({ model: 'test', input: { texts: ['private text'] }, parameters: { text_type: 'document' } });
  });

  it('reports failed network attempts and preserves errors even when diagnostics fail', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const client = new BailianEmbeddingClient({ ...options, maxRetries: 0, fetchImpl });
    const attempts: EmbeddingAttempt[] = [];
    await expect(client.embed(['text'], { onAttempt: attempt => { attempts.push(attempt); throw new Error('diagnostic failure'); } })).rejects.toMatchObject({ code: 'EMBEDDING_PROVIDER_UNAVAILABLE' });
    expect(attempts).toEqual([{ attempt: 0, durationMs: expect.any(Number), succeeded: false }]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('honors cancellation without launching another paid retry', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      controller.abort();
    }));
    const client = new BailianEmbeddingClient({ ...options, fetchImpl });
    await expect(client.embed(['text'], { signal: controller.signal })).rejects.toMatchObject({ code: 'EMBEDDING_PROVIDER_TIMEOUT' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
