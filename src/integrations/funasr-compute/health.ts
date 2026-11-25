import { ServiceHttpClient, readJsonResponse } from '../http-client.js';

const http = new ServiceHttpClient({ dependency: 'processing_node', operation: 'health' });

export async function checkFunAsrReady(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
  try {
    signal?.throwIfAborted();
    const url = new URL('/readyz', baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    return await http.request(url, { method: 'GET', signal }, { timeoutMs: 3000 }, async response => {
      if (!response.ok) return false;
      const body = await readJsonResponse(response, 4096);
      if (body === null || typeof body !== 'object') return false;
      const readiness = body as Record<string, unknown>;
      return readiness.status === 'ready' && readiness.device === 'cuda:0';
    });
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}
