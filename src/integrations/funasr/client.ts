import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { readJsonResponse, ServiceHttpClient, ServiceHttpError } from '../http-client.js';

export const FUNASR_DEFAULT_MAX_RESULT_BYTES = 16 * 1024 * 1024;
const controlResponseBytes = 16 * 1024;
const taskIdPattern = /^task_[0-9a-f]{32}$/u;
const eventIdPattern = /^evt_[0-9a-f]{32}$/u;

export class FunAsrError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, readonly status?: number) {
    super(code);
    this.name = 'FunAsrError';
  }
}

interface FunAsrUpload {
  body: Readable;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  callbackUrl: string;
  idempotencyKey: string;
}

interface FunAsrClientOptions {
  apiToken: string;
  requestTimeoutMs?: number;
  uploadTimeoutMs?: number;
  maxResultBytes?: number;
  fetchImpl?: typeof fetch;
}

interface FunAsrSegment {
  text: string;
  startMs: number;
  endMs: number;
  speakerId: string | null;
}

interface FunAsrSpeaker {
  speakerId: string;
  personId?: string;
  displayName?: string;
}

interface FunAsrTranscript {
  text: string;
  durationSeconds: number;
  processingSeconds: number;
  segments: FunAsrSegment[];
  language?: string;
  speakers: FunAsrSpeaker[];
}

export type FunAsrEvent = { eventId: string; taskId: string } & (
  | { status: 'succeeded'; result: FunAsrTranscript; error: null }
  | { status: 'failed'; result: null; error: { code: string; message: string } }
);

type FunAsrResult =
  | { state: 'pending' | 'consumed' | 'missing' }
  | { state: 'event'; event: FunAsrEvent };

type CallbackHeaders = {
  eventId: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validTaskId(value: unknown): value is string {
  return typeof value === 'string' && taskIdPattern.test(value);
}

function validEventId(value: unknown): value is string {
  return typeof value === 'string' && eventIdPattern.test(value);
}

function validSpeakerId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validText(value: unknown): value is string {
  // PostgreSQL rejects NUL and unpaired UTF-16 surrogates in JSONB.
  return typeof value === 'string' && !value.includes('\u0000') && !/[\uD800-\uDFFF]/u.test(value);
}

function invalidEvent(): never {
  throw new FunAsrError('FUNASR_EVENT_INVALID', false, 400);
}

function parseLanguage(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64) return;
  try { return Intl.getCanonicalLocales(value)[0]; }
  catch { return undefined; }
}

function parseSegment(value: unknown): FunAsrSegment {
  const { start_ms: startMs, end_ms: endMs, speaker_id: speakerId, text } = object(value);
  if (!nonnegative(startMs) || !Number.isSafeInteger(startMs) || !nonnegative(endMs)
    || !Number.isSafeInteger(endMs) || endMs < startMs || !validText(text)
    || (speakerId !== null && !validSpeakerId(speakerId))) {
    return invalidEvent();
  }
  return { text, startMs, endMs, speakerId };
}

function parseSpeakers(segments: FunAsrSegment[], value: unknown): FunAsrSpeaker[] {
  const speakers = new Map<string, FunAsrSpeaker>();
  for (const { speakerId } of segments) {
    if (speakerId !== null && !speakers.has(speakerId)) speakers.set(speakerId, { speakerId });
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const { speaker_id: speakerId, identity } = object(item);
      if (!validSpeakerId(speakerId) || speakers.get(speakerId)?.personId) continue;
      const { source, person_id: personId, display_name: displayName } = object(identity);
      const speaker: FunAsrSpeaker = { speakerId };
      if (source === 'milvus' && validSpeakerId(personId)) {
        speaker.personId = personId;
        if (validText(displayName) && displayName.length <= 128 && displayName.trim()) {
          speaker.displayName = displayName.trim();
        }
      }
      speakers.set(speakerId, speaker);
    }
  }
  return [...speakers.values()];
}

function parseEvent(value: unknown): FunAsrEvent {
  const { event_id: eventId, task_id: taskId, event, status, result, error } = object(value);
  if (!validTaskId(taskId) || !validEventId(eventId)) return invalidEvent();
  if (status === 'failed' && event === 'task.failed' && result === null) {
    const { code, message } = object(error);
    if (typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(code) || !validText(message)) {
      return invalidEvent();
    }
    return { eventId, taskId, status, result: null, error: { code, message } };
  }
  if (status !== 'succeeded' || event !== 'task.succeeded' || error !== null) return invalidEvent();
  const { text, duration_seconds: durationSeconds, processing_seconds: processingSeconds,
    segments, language, speakers } = object(result);
  if (!validText(text) || !nonnegative(durationSeconds) || !nonnegative(processingSeconds) || !Array.isArray(segments)) {
    return invalidEvent();
  }
  const parsedSegments = segments.map(parseSegment);
  const languageTag = parseLanguage(language);
  return { eventId, taskId, status, error: null, result: {
    text, durationSeconds, processingSeconds, segments: parsedSegments,
    ...(languageTag ? { language: languageTag } : {}), speakers: parseSpeakers(parsedSegments, speakers),
  } };
}

/** Authenticate the exact provider UTF-8 bytes before parsing the event. */
export function verifyFunAsrCallback(headers: CallbackHeaders, body: Buffer, secret: string, nowSeconds = Date.now() / 1000): FunAsrEvent {
  const { eventId, timestamp, signature } = headers;
  const invalid = new FunAsrError('FUNASR_CALLBACK_SIGNATURE_INVALID', false, 401);
  if (!secret || !validEventId(eventId) || !timestamp || !/^\d{1,12}$/u.test(timestamp)
    || Math.abs(nowSeconds - Number(timestamp)) > 300 || !signature || !/^v1=[0-9a-f]{64}$/u.test(signature)) {
    throw invalid;
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${eventId}.`, 'ascii').update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'))) throw invalid;
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { return invalidEvent(); }
  const event = parseEvent(payload);
  if (event.eventId !== eventId) throw new FunAsrError('FUNASR_CALLBACK_EVENT_MISMATCH', false, 400);
  return event;
}

function httpUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new FunAsrError('FUNASR_URL_INVALID', false); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.hash) {
    throw new FunAsrError('FUNASR_URL_INVALID', false);
  }
  return url;
}

async function* multipartStream(upload: FunAsrUpload, header: Buffer, footer: Buffer) {
  let size = 0;
  yield header;
  for await (const chunk of upload.body) {
    if (!(chunk instanceof Uint8Array)) throw new FunAsrError('FUNASR_AUDIO_STREAM_INVALID', false);
    size += chunk.byteLength;
    if (size > upload.sizeBytes) throw new FunAsrError('FUNASR_AUDIO_SIZE_MISMATCH', false);
    yield chunk;
  }
  if (size !== upload.sizeBytes) throw new FunAsrError('FUNASR_AUDIO_SIZE_MISMATCH', false);
  yield footer;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new FunAsrError('FUNASR_CLIENT_CONFIG_INVALID', false);
  return value;
}

export class FunAsrClient {
  private readonly http: ServiceHttpClient;
  private readonly requestTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly maxResultBytes: number;

  constructor(private readonly options: FunAsrClientOptions) {
    if (!/^[\x21-\x7e]+$/u.test(options.apiToken)) throw new FunAsrError('FUNASR_CLIENT_CONFIG_INVALID', false);
    this.http = new ServiceHttpClient({ fetchImpl: options.fetchImpl, dependency: 'funasr' });
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? 10_000);
    this.uploadTimeoutMs = positiveInteger(options.uploadTimeoutMs ?? 300_000);
    this.maxResultBytes = positiveInteger(options.maxResultBytes ?? FUNASR_DEFAULT_MAX_RESULT_BYTES);
  }

  async submit(baseUrl: string, upload: FunAsrUpload, signal?: AbortSignal): Promise<{ taskId: string }> {
    let encodedBody: Readable | undefined;
    try {
      if (!Number.isSafeInteger(upload.sizeBytes) || upload.sizeBytes <= 0
        || !/^[\x21-\x7e]{1,128}$/u.test(upload.idempotencyKey)
        || !/^[\x21-\x7e]{1,2048}$/u.test(upload.callbackUrl) || upload.callbackUrl.includes('#')) {
        throw new FunAsrError('FUNASR_UPLOAD_INVALID', false);
      }
      const callbackUrl = httpUrl(upload.callbackUrl).href;
      const boundary = 'huahuo-' + randomBytes(24).toString('hex');
      const filename = upload.filename.replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 180) || 'audio';
      const mimeType = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(upload.mimeType) ? upload.mimeType : 'application/octet-stream';
      const header = Buffer.from([
        '--' + boundary, 'Content-Disposition: form-data; name="callback_url"', '', callbackUrl,
        '--' + boundary, `Content-Disposition: form-data; name="file"; filename="${filename}"`,
        'Content-Type: ' + mimeType, '', '',
      ].join('\r\n'));
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const contentLength = header.length + upload.sizeBytes + footer.length;
      if (!Number.isSafeInteger(contentLength)) throw new FunAsrError('FUNASR_UPLOAD_INVALID', false);
      encodedBody = Readable.from(multipartStream(upload, header, footer), { objectMode: false });
      const init: RequestInit & { duplex: 'half' } = {
        method: 'POST', signal, duplex: 'half',
        // Node and DOM declare different reader result shapes for the same runtime stream.
        body: Readable.toWeb(encodedBody, { strategy: { highWaterMark: 1 } }) as unknown as ReadableStream<Uint8Array>,
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': String(contentLength),
          'Idempotency-Key': upload.idempotencyKey,
        },
      };
      return await this.request(baseUrl, '/v1/tasks', init, this.uploadTimeoutMs, 'submit', async response => {
        if (response.status !== 202) this.reject(response);
        const { task_id: taskId } = object(await this.read(response, controlResponseBytes, 'FUNASR_SUBMIT_RESPONSE_INVALID', true));
        if (!validTaskId(taskId)) throw new FunAsrError('FUNASR_SUBMIT_RESPONSE_INVALID', true);
        return { taskId };
      });
    } finally {
      encodedBody?.destroy();
      upload.body.destroy();
    }
  }

  async result(baseUrl: string, taskId: string, signal?: AbortSignal): Promise<FunAsrResult> {
    if (!validTaskId(taskId)) throw new FunAsrError('FUNASR_TASK_ID_INVALID', false);
    return this.request(baseUrl, `/v1/tasks/${taskId}/result`, { signal }, this.requestTimeoutMs, 'job_result', async response => {
      if (response.status === 404) return { state: 'missing' };
      if (response.status === 409) return { state: 'pending' };
      if (response.status === 410) return { state: 'consumed' };
      if (response.status !== 200) this.reject(response);
      const event = parseEvent(await this.read(response, this.maxResultBytes, 'FUNASR_RESULT_RESPONSE_INVALID', false));
      if (event.taskId !== taskId) throw new FunAsrError('FUNASR_RESULT_TASK_MISMATCH', false);
      return { state: 'event', event };
    });
  }

  async ack(baseUrl: string, taskId: string, eventId: string, signal?: AbortSignal): Promise<'acknowledged' | 'missing'> {
    if (!validTaskId(taskId)) throw new FunAsrError('FUNASR_TASK_ID_INVALID', false);
    if (!validEventId(eventId)) throw new FunAsrError('FUNASR_EVENT_ID_INVALID', false);
    const init = { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_id: eventId }) };
    return this.request(baseUrl, `/v1/tasks/${taskId}/ack`, init, this.requestTimeoutMs, 'ack', async response => {
      if (response.status === 404) return 'missing';
      if (response.status !== 200) this.reject(response);
      const reply = object(await this.read(response, controlResponseBytes, 'FUNASR_ACK_RESPONSE_INVALID', true));
      if (reply.acknowledged !== true || reply.task_id !== taskId || reply.event_id !== eventId
        || (reply.consumed_by !== 'callback' && reply.consumed_by !== 'ack')) {
        throw new FunAsrError('FUNASR_ACK_RESPONSE_INVALID', true);
      }
      return 'acknowledged';
    });
  }

  private async request<T>(baseUrl: string, path: string, init: RequestInit, timeoutMs: number,
    operation: string, consume: (response: Response) => Promise<T>): Promise<T> {
    const base = httpUrl(baseUrl);
    if (base.pathname !== '/' || base.search) throw new FunAsrError('FUNASR_URL_INVALID', false);
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + this.options.apiToken);
    try {
      return await this.http.request(new URL(path, base), { ...init, headers }, { timeoutMs, operation }, consume);
    } catch (error) {
      if (error instanceof FunAsrError) throw error;
      init.signal?.throwIfAborted();
      throw new FunAsrError('FUNASR_TRANSPORT_FAILED', true);
    }
  }

  private reject(response: Response): never {
    const status = response.status;
    const retryable = status >= 500 || status === 408 || status === 425 || status === 429;
    throw new FunAsrError('FUNASR_PROVIDER_HTTP_ERROR', retryable, status);
  }

  private async read(response: Response, limit: number, invalidCode: string, retryable: boolean): Promise<unknown> {
    try {
      return await readJsonResponse(response, limit);
    } catch (error) {
      if (!(error instanceof ServiceHttpError)) throw error;
      if (!retryable && error.code === 'HTTP_RESPONSE_TOO_LARGE') throw new FunAsrError('FUNASR_RESULT_TOO_LARGE', false);
      throw new FunAsrError(invalidCode, retryable);
    }
  }
}
