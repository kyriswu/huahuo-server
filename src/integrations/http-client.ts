import { traceHeaders, currentTraceId } from '../lib/trace.js';
import { SpanKind } from '@opentelemetry/api';
import { startOperation, logClientObservation } from '../observability/telemetry.js';
import { currentApplicationMetrics, clientDependency, clientOperation, type ClientOutcome } from '../plugins/metrics.js';

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
  constructor(private readonly options: { fetchImpl?: typeof fetch; dependency?: string; operation?: string } = {}) {}

  async request<T>(url: string | URL, init: RequestInit, options: { timeoutMs: number; operation?: string },
    consume: (response: Response) => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new RangeError('HTTP_TIMEOUT_INVALID');
    const dependency = clientDependency(this.options.dependency), operation = clientOperation(options.operation ?? this.options.operation);
    const method = (init.method ?? 'GET').toUpperCase();
    const span = startOperation('http.client', { dependency, operation, 'http.request.method': method }, SpanKind.CLIENT);
    return span.run(async () => {
    const started = process.hrtime.bigint();
    const controller = new AbortController();
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new DOMException('Service request timed out', 'TimeoutError')), options.timeoutMs);
    let response: Response | undefined;
    let outcome: ClientOutcome = 'network_error';
    try {
      signal.throwIfAborted();
      response = await (this.options.fetchImpl ?? fetch)(url, {
        ...init, headers: traceHeaders(init.headers), redirect: 'error', signal,
      });
      const result = await consume(response);
      outcome = response.ok ? 'success' : 'http_error';
      return result;
    } catch (error) {
      if (signal.aborted) outcome = controller.signal.aborted || signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'timeout' : 'cancelled';
      else if (response && !response.ok) outcome = 'http_error';
      else if (response) {
        let code = '';
        try { if (error && typeof error === 'object') { const value = Reflect.get(error, 'code'); if (typeof value === 'string') code = value; } }
        catch { /* A diagnostic getter must not replace the original exception. */ }
        outcome = error instanceof ServiceHttpError || /RESPONSE|INVALID|MISMATCH|TOO_LARGE|EMPTY/.test(code) ? 'response_error' : 'business_error';
      }
      throw error;
    } finally {
      clearTimeout(timer);
      // Native readers and readJsonResponse release their locks before this point.
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      try { currentApplicationMetrics()?.recordOutbound?.({ dependency, operation, method, status: response?.status, outcome, seconds }); } catch { /* Telemetry never changes business results. */ }
      logClientObservation({ dependency, operation, method, status: response?.status, outcome, durationMs: seconds * 1000, traceId: currentTraceId() });
      span.end({ outcome, 'http.response.status_code': response?.status, ...(outcome === 'success' ? {} : { 'error.type': outcome }) }, outcome !== 'success');
    }
    });
  }
}
