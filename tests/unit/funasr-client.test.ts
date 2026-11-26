import { createHmac } from 'node:crypto';
import { createServer, type RequestListener, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FunAsrClient, verifyFunAsrCallback } from '../../src/integrations/funasr/client.js';

const taskId = 'task_' + 'a'.repeat(32);
const eventId = 'evt_' + 'b'.repeat(32);
const token = 'test-api-token';
const secret = 'test-callback-secret';
const now = 1_800_000_000;
const success = {
  event_id: eventId, event: 'task.succeeded', task_id: taskId, status: 'succeeded',
  result: {
    text: '您好。', duration_seconds: 4.523, processing_seconds: 0.831,
    segments: [{ start_ms: 0, end_ms: 952, speaker_id: null, text: '您好。', timestamps_ms: [[0, 470], [480, 950]] }],
    language: 'zh', timestamps_ms: [], speakers: [],
  },
  error: null,
};

function signed(body: Buffer, { stamp = String(now), id = eventId } = {}) {
  return {
    timestamp: stamp,
    eventId: id,
    signature: 'v1=' + createHmac('sha256', secret).update(`${stamp}.${id}.`, 'ascii').update(body).digest('hex'),
  };
}

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

describe('FunASR async HTTP client', () => {
  it('sends audio as a stream with a private callback URL and stable idempotency key', async () => {
    const callbackUrl = 'https://server.internal/internal/v1/funasr/callbacks/local-id';
    const audio = Buffer.from([1, 2, 3, 4, 255]);
    const field = vi.fn();
    const baseUrl = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const bytes = Buffer.concat(chunks);
        field({ url: request.url, method: request.method, headers: request.headers, bytes });
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ task_id: taskId, status: 'queued' }));
      });
    });
    const client = new FunAsrClient({ apiToken: token });
    await expect(client.submit(baseUrl, {
      body: Readable.from([audio.subarray(0, 1), audio.subarray(1)]), filename: '录音\r\n.wav',
      mimeType: 'audio/wav', sizeBytes: audio.length, callbackUrl, idempotencyKey: 'attempt-id',
    })).resolves.toEqual({ taskId });
    expect(field).toHaveBeenCalledOnce();
    const received = field.mock.calls[0]?.[0] as { url: string; method: string; headers: Record<string, string>; bytes: Buffer };
    expect(received).toMatchObject({
      url: '/v1/tasks', method: 'POST',
      headers: {
        authorization: `Bearer ${token}`, 'idempotency-key': 'attempt-id',
        'content-type': expect.stringMatching(/^multipart\/form-data; boundary=/u),
      },
    });
    expect(Number(received.headers['content-length'])).toBe(received.bytes.length);
    const multipart = await new Response(new Uint8Array(received.bytes), { headers: { 'content-type': received.headers['content-type']! } }).formData();
    expect(multipart.get('callback_url')).toBe(callbackUrl);
    const file = multipart.get('file') as File;
    expect(file.type).toBe('audio/wav');
    expect(file.name).not.toMatch(/[\r\n]/u);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(audio);
  });

  it.each([[404, 'missing'], [409, 'pending'], [410, 'consumed']])('interprets result status %s as %s', async (status, state) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ detail: 'fixture' }, { status }));
    const client = new FunAsrClient({ apiToken: token, fetchImpl });
    await expect(client.result('http://fixture.test', taskId)).resolves.toEqual({ state });
    expect(fetchImpl).toHaveBeenCalledWith(new URL(`http://fixture.test/v1/tasks/${taskId}/result`), expect.objectContaining({ redirect: 'error' }));
  });

  it('validates a result against its requested task ID and acknowledges only an exact match', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...success, task_id: 'task_' + 'c'.repeat(32) }))
      .mockResolvedValueOnce(Response.json(success))
      .mockResolvedValueOnce(Response.json({ task_id: taskId, event_id: eventId, acknowledged: true, consumed_by: 'callback' }))
      .mockResolvedValueOnce(Response.json({ task_id: taskId, event_id: 'evt_' + 'c'.repeat(32), acknowledged: true, consumed_by: 'ack' }));
    const client = new FunAsrClient({ apiToken: token, fetchImpl });
    await expect(client.result('http://fixture.test', taskId)).rejects.toMatchObject({ code: 'FUNASR_RESULT_TASK_MISMATCH', retryable: false });
    await expect(client.result('http://fixture.test', taskId)).resolves.toMatchObject({ state: 'event', event: { taskId, eventId, status: 'succeeded' } });
    await expect(client.ack('http://fixture.test', taskId, eventId)).resolves.toBe('acknowledged');
    await expect(client.ack('http://fixture.test', taskId, eventId)).rejects.toMatchObject({ code: 'FUNASR_ACK_RESPONSE_INVALID', retryable: true });
    expect(fetchImpl.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ event_id: eventId }));
  });

  it('classifies upstream refusal and an unknown submission response without silently retrying', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('provider details'))
      .mockResolvedValueOnce(Response.json({ detail: 'provider details' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ detail: 'provider details' }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ detail: 'provider details' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ bad: 'provider details' }, { status: 202 }));
    const baseUrl = 'http://fixture.test';
    const client = new FunAsrClient({ apiToken: token, fetchImpl });
    const submit = () => client.submit(baseUrl, {
      body: Readable.from([Buffer.from([7])]), filename: 'fixture.wav', mimeType: 'audio/wav', sizeBytes: 1,
      callbackUrl: 'http://server.internal/callback', idempotencyKey: 'stable-key',
    });
    await expect(submit()).rejects.toMatchObject({ code: 'FUNASR_TRANSPORT_FAILED', retryable: true });
    await expect(submit()).rejects.toMatchObject({ code: 'FUNASR_PROVIDER_HTTP_ERROR', retryable: false, status: 409 });
    await expect(submit()).rejects.toMatchObject({ code: 'FUNASR_PROVIDER_HTTP_ERROR', retryable: true, status: 429 });
    await expect(submit()).rejects.toMatchObject({ code: 'FUNASR_PROVIDER_HTTP_ERROR', retryable: true, status: 503 });
    await expect(submit()).rejects.toMatchObject({ code: 'FUNASR_SUBMIT_RESPONSE_INVALID', retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('enforces the maximum result payload before parsing', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(success));
    const client = new FunAsrClient({ apiToken: token, fetchImpl, maxResultBytes: 64 });
    await expect(client.result('http://fixture.test', taskId)).rejects.toMatchObject({ code: 'FUNASR_RESULT_TOO_LARGE', retryable: false });
  });
});

describe('FunASR signed callbacks', () => {
  it('authenticates raw non-ASCII bytes and normalizes the matching terminal event', () => {
    const body = Buffer.from(JSON.stringify(success, null, 2));
    expect(verifyFunAsrCallback(signed(body), body, secret, now)).toEqual({
      taskId, eventId, status: 'succeeded', error: null,
      result: { text: '您好。', durationSeconds: 4.523, processingSeconds: 0.831,
        segments: [{ startMs: 0, endMs: 952, speakerId: null, text: '您好。' }], language: 'zh', speakers: [] },
    });
    expect(() => verifyFunAsrCallback(signed(body), Buffer.from(JSON.stringify(success)), secret, now))
      .toThrow('FUNASR_CALLBACK_SIGNATURE_INVALID');
    expect(() => verifyFunAsrCallback(signed(body, { stamp: String(now - 301) }), body, secret, now))
      .toThrow('FUNASR_CALLBACK_SIGNATURE_INVALID');
    expect(() => verifyFunAsrCallback(signed(body, { id: 'evt_' + 'c'.repeat(32) }), body, secret, now))
      .toThrow('FUNASR_CALLBACK_EVENT_MISMATCH');
  });

  it('preserves recording-local speaker IDs and accepts receipts without usable language metadata', () => {
    const body = Buffer.from(JSON.stringify({ ...success, result: {
      ...success.result,
      language: 'unexpected value',
      segments: [{ ...success.result.segments[0], speaker_id: 'speaker_1' }],
      speakers: [
        { speaker_id: 'speaker_0', voiceprint: { speaker_id: 'person-0', name: '测试姓名' } },
        { speaker_id: 'speaker_1' }, { speaker_id: 'speaker_1' }, { speaker_id: 'invalid ID' },
        { speaker_id: 'speaker_1', identity: { source: 'milvus', person_id: 'person-1', display_name: '陈先生' } },
      ],
    } }));
    const receipt = verifyFunAsrCallback(signed(body), body, secret, now);
    expect(receipt.result).not.toHaveProperty('language');
    expect(receipt.result).toMatchObject({ segments: [{ speakerId: 'speaker_1' }] });
    expect(receipt.status === 'succeeded' && receipt.result.speakers).toEqual([
      { speakerId: 'speaker_1', personId: 'person-1', displayName: '陈先生' }, { speakerId: 'speaker_0' },
    ]);
  });

  it('accepts failed and silent results while rejecting inconsistent event payloads', () => {
    const failed = Buffer.from(JSON.stringify({ ...success, status: 'failed', event: 'task.failed', result: null,
      error: { code: 'invalid_audio', message: 'Decoding failed' } }));
    expect(verifyFunAsrCallback(signed(failed), failed, secret, now)).toMatchObject({
      taskId, eventId, status: 'failed', result: null, error: { code: 'invalid_audio' },
    });
    const silent = Buffer.from(JSON.stringify({ ...success, result: { ...success.result, text: '', segments: [] } }));
    expect(verifyFunAsrCallback(signed(silent), silent, secret, now)).toMatchObject({ result: { text: '', segments: [] } });
    const malformedText = Buffer.from(JSON.stringify({ ...success, result: { ...success.result, text: '\u0000' } }));
    expect(() => verifyFunAsrCallback(signed(malformedText), malformedText, secret, now)).toThrow('FUNASR_EVENT_INVALID');
    const reversed = Buffer.from(JSON.stringify({ ...success, result: { ...success.result,
      segments: [{ start_ms: 100, end_ms: 10, text: '', speaker_id: null }] } }));
    expect(() => verifyFunAsrCallback(signed(reversed), reversed, secret, now)).toThrow('FUNASR_EVENT_INVALID');
  });
});
