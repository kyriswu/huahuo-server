import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleEmbeddingClient, type EmbeddingAttempt } from '../../src/modules/rag/adapters/embedding.js';

const options = { baseUrl: 'https://embedding.test/v1', apiKey: 'test-only-not-a-real-key', model: 'test', dimensions: 2, sendDimensions: false, timeoutMs: 1000, maxRetries: 2 };
const vector = () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }));

describe('Embedding attempt observations', () => {
  it('records each retry separately without credentials, input or vectors', async () => {
    const attempts: EmbeddingAttempt[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(vector());
    const client = new OpenAICompatibleEmbeddingClient({ ...options, fetchImpl });
    expect(await client.embed(['private text'], { onAttempt: attempt => attempts.push(attempt) })).toEqual([[1, 2]]);
    expect(attempts).toEqual([
      expect.objectContaining({ attempt: 0, status: 503, succeeded: false, durationMs: expect.any(Number), firstByteMs: expect.any(Number) }),
      expect.objectContaining({ attempt: 1, status: 200, succeeded: true, durationMs: expect.any(Number), firstByteMs: expect.any(Number) }),
    ]);
    expect(JSON.stringify(attempts)).not.toMatch(/private|test-only|embedding|authorization/iu);
    expect(attempts[0]!.durationMs).toBeLessThan(100);
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(sent).toEqual({ model: 'test', input: ['private text'], encoding_format: 'float' });
  });

  it('reports failed network attempts and preserves errors even when diagnostics fail', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const client = new OpenAICompatibleEmbeddingClient({ ...options, maxRetries: 0, fetchImpl });
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
    const client = new OpenAICompatibleEmbeddingClient({ ...options, fetchImpl });
    await expect(client.embed(['text'], { signal: controller.signal })).rejects.toMatchObject({ code: 'EMBEDDING_PROVIDER_TIMEOUT' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
