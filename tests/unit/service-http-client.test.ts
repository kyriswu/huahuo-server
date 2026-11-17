import { createServer, type RequestListener, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJsonResponse, ServiceHttpClient } from '../../src/integrations/http-client.js';
import { withTraceId } from '../../src/lib/trace.js';

const servers: Server[] = [];
async function listen(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('LOOPBACK_REQUIRED');
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

describe('shared service HTTP transport, loopback and explicit substitutes only', () => {
  it('propagates the request trace and reuses a connection for sequential consumed responses', async () => {
    const connections = new Set<Socket>(), received: string[] = [];
    const base = await listen((request, response) => {
      connections.add(request.socket);
      received.push(String(request.headers['x-trace-id']));
      response.setHeader('Content-Type', 'application/json');
      response.end('{"ok":true}');
    });
    const client = new ServiceHttpClient();
    await withTraceId('service-test-trace', async () => {
      for (let i = 0; i < 3; i++) {
        expect(await client.request(base, {}, { timeoutMs: 1000 }, response => readJsonResponse(response, 100))).toEqual({ ok: true });
        // Allow native fetch to return the fully consumed socket to its pool.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    });
    expect(received).toEqual(Array(3).fill('service-test-trace'));
    expect(connections.size).toBe(1);
  });

  it('bounds response-body consumption as well as waiting for response headers', async () => {
    const base = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.flushHeaders();
      response.write('{');
    });
    const client = new ServiceHttpClient();
    await expect(client.request(base, {}, { timeoutMs: 50 }, response => readJsonResponse(response, 100)))
      .rejects.toMatchObject({ name: expect.stringMatching(/AbortError|TimeoutError/u) });
  });

  it('rejects redirects without forwarding credentials or automatically retrying a submission', async () => {
    const target = vi.fn();
    const redirected = await listen((_request, response) => { target(); response.end('{}'); });
    const initial = vi.fn();
    const base = await listen((_request, response) => { initial(); response.writeHead(307, { location: redirected }); response.end(); });
    await expect(new ServiceHttpClient().request(base, { method: 'POST', headers: { authorization: 'Bearer fixture' }, body: '{}' },
      { timeoutMs: 1000 }, response => readJsonResponse(response, 100))).rejects.toThrow();
    expect(initial).toHaveBeenCalledOnce();
    expect(target).not.toHaveBeenCalled();
  });

  it('preserves caller cancellation and skips an already-cancelled call', async () => {
    const controller = new AbortController(), fetchImpl = vi.fn<typeof fetch>();
    controller.abort();
    await expect(new ServiceHttpClient({ fetchImpl }).request('https://fixture.test', { signal: controller.signal },
      { timeoutMs: 1000 }, response => readJsonResponse(response, 100))).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cancels unused error response bodies', async () => {
    const cancel = vi.fn(), fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel }), { status: 503 }));
    expect(await new ServiceHttpClient({ fetchImpl }).request('https://fixture.test', {}, { timeoutMs: 1000 }, async response => response.status)).toBe(503);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('caps streamed bytes even when content-length is missing and releases the reader on overflow', async () => {
    const cancel = vi.fn(), response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(4)); }, cancel,
    }));
    await expect(readJsonResponse(response, 7)).rejects.toMatchObject({ code: 'HTTP_RESPONSE_TOO_LARGE' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
  });

  it.each([[null, 'HTTP_RESPONSE_EMPTY'], ['', 'HTTP_RESPONSE_EMPTY'], ['{broken', 'HTTP_RESPONSE_INVALID']] as const)('rejects empty or malformed JSON (%s)', async (body, code) => {
      await expect(readJsonResponse(new Response(body), 100)).rejects.toMatchObject({ code });
    });
});
