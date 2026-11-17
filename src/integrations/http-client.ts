import { traceHeaders } from '../lib/trace.js';

export class ServiceHttpError extends Error {
  constructor(readonly code: 'HTTP_RESPONSE_TOO_LARGE' | 'HTTP_RESPONSE_EMPTY' | 'HTTP_RESPONSE_INVALID') {
    super(code);
    this.name = 'ServiceHttpError';
  }
}

/** Read an untrusted response within a byte budget; release the connection on every exit. */
export async function readJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('HTTP_RESPONSE_LIMIT_INVALID');
  const reader = response.body?.getReader();
  if (!reader) throw new ServiceHttpError('HTTP_RESPONSE_EMPTY');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new ServiceHttpError('HTTP_RESPONSE_TOO_LARGE');
      chunks.push(chunk.value);
    }
    if (!bytes) throw new ServiceHttpError('HTTP_RESPONSE_EMPTY');
    try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown; }
    catch { throw new ServiceHttpError('HTTP_RESPONSE_INVALID'); }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Shared transport. Native fetch reuses Node's process-wide connection pool.
 * Provider clients own status/protocol checks and retries; a submission is never replayed here.
 * Keep response consumption inside request() so its deadline includes the body.
 */
export class ServiceHttpClient {
  constructor(private readonly options: { fetchImpl?: typeof fetch } = {}) {}

  async request<T>(url: string | URL, init: RequestInit, options: { timeoutMs: number },
    consume: (response: Response) => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new RangeError('HTTP_TIMEOUT_INVALID');
    const controller = new AbortController();
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    signal.throwIfAborted();
    const timer = setTimeout(() => controller.abort(new DOMException('Service request timed out', 'TimeoutError')), options.timeoutMs);
    let response: Response | undefined;
    try {
      response = await (this.options.fetchImpl ?? fetch)(url, {
        ...init, headers: traceHeaders(init.headers), redirect: 'error', signal,
      });
      return await consume(response);
    } finally {
      clearTimeout(timer);
      // Native readers and readJsonResponse release their locks before this point.
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    }
  }
}
