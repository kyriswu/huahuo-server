import { readJsonResponse, ServiceHttpError } from '../../integrations/http-client.js';
import { traceHeaders } from '../../lib/trace.js';
import { DomainError, type Scope } from '../identity/store.js';
import { MaxOutputChars } from './model.js';

type AgentInput = { prompt: string; text: string; stream: boolean };
type AgentEvent = { type: 'delta' | 'result'; text: string };
type AuthMethod = 'bearer' | 'cookie';
const maxFrameBytes = MaxOutputChars * 6 + 512;

const badResponse = () => new DomainError(502, 'AI_TEMPLATE_AGENT_RESPONSE_INVALID');

function resultText(text: unknown): string {
  if (typeof text !== 'string' || !text.trim() || text.length > MaxOutputChars || text.includes('\u0000')) {
    throw badResponse();
  }
  return text.trim();
}

function decode(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw badResponse(); }
}

async function* readFrames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let start = 0;
      for (let end = value.indexOf(10); end >= 0; end = value.indexOf(10, start)) {
        const line = Buffer.concat([buffer, value.subarray(start, end)]);
        if (line.length > maxFrameBytes) throw badResponse();
        if (line.length) yield decode(line);
        buffer = new Uint8Array(0);
        start = end + 1;
      }
      if (buffer.length + value.length - start > maxFrameBytes) throw badResponse();
      buffer = Buffer.concat([buffer, value.subarray(start)]);
    }
    if (buffer.length) yield decode(buffer);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class AiTemplateAgentClient {
  constructor(private readonly origin: string | undefined, private readonly request: typeof fetch = fetch) {}

  get available() { return Boolean(this.origin); }

  async *execute(input: AgentInput, scope: Scope, method: AuthMethod, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    if (!this.origin) throw new DomainError(503, 'AI_TEMPLATE_EXECUTOR_UNAVAILABLE');
    try {
      const response = await this.request(new URL('/internal/v1/ai-template-runs', this.origin), {
        method: 'POST', redirect: 'error', signal,
        headers: traceHeaders({
          'content-type': 'application/json',
          accept: input.stream ? 'application/x-ndjson' : 'application/json',
          'x-huahuo-user-id': scope.userId,
          'x-huahuo-session-id': scope.sessionId,
          'x-huahuo-auth-method': method,
          'x-trace-id': scope.traceId,
        }),
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new DomainError(response.status === 503 ? 503 : 502, 'AI_TEMPLATE_GENERATION_FAILED');
      }
      const expected = input.stream ? 'application/x-ndjson' : 'application/json';
      if (!response.body || response.headers.get('content-type')?.split(';')[0]?.trim() !== expected) {
        await response.body?.cancel().catch(() => undefined);
        throw badResponse();
      }
      if (!input.stream) {
        const result = await readJsonResponse(response, maxFrameBytes) as { text?: unknown } | null;
        yield { type: 'result', text: resultText(result?.text) };
        return;
      }
      let outputLength = 0;
      for await (const frame of readFrames(response.body)) {
        if (!frame || typeof frame !== 'object') throw badResponse();
        const { type, text } = frame as { type?: unknown; text?: unknown };
        if (type === 'result') {
          yield { type: 'result', text: resultText(text) };
          return;
        }
        if (type === 'error') throw new DomainError(502, 'AI_TEMPLATE_GENERATION_FAILED');
        if (type !== 'delta' || typeof text !== 'string') throw badResponse();
        outputLength += text.length;
        if (outputLength > MaxOutputChars || text.includes('\u0000')) throw badResponse();
        yield { type: 'delta', text };
      }
      throw badResponse();
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof DomainError) throw error;
      if (error instanceof ServiceHttpError) throw badResponse();
      throw new DomainError(503, 'AI_TEMPLATE_EXECUTOR_UNAVAILABLE');
    }
  }
}
