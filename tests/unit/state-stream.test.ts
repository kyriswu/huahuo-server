import { Writable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeStateStreams, streamState } from '../../src/lib/state-stream.js';

class Response extends Writable {
  readonly frames: string[] = [];
  readonly writeHead = vi.fn();
  private readonly pending: Array<(error?: Error | null) => void> = [];
  constructor(public blocked = true, highWaterMark = 128) { super({ highWaterMark }); }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.frames.push(chunk.toString());
    if (this.blocked) this.pending.push(callback); else callback();
  }
  release(error?: Error) { this.blocked = false; for (const callback of this.pending.splice(0)) callback(error); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const instances: Array<{ app: FastifyInstance; raw: Response }> = [];
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(blocked = true, highWaterMark = 128) {
  const raw = new Response(blocked, highWaterMark);
  const app = {} as FastifyInstance;
  const hijack = vi.fn();
  const reply = { raw, server: app, hijack } as unknown as FastifyReply;
  instances.push({ app, raw });
  return { raw, app, reply, hijack };
}
function expectClean(raw: Response) {
  expect(raw.listenerCount('drain')).toBe(0);
  expect(raw.listenerCount('close')).toBe(0);
  expect(raw.listenerCount('finish')).toBe(0);
  expect(raw.listenerCount('error')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(async () => {
  for (const { app, raw } of instances.splice(0)) { closeStateStreams(app); raw.destroy(); }
  await settle(); vi.clearAllTimers(); vi.useRealTimers();
});

describe('state snapshot SSE backpressure (real Writable, virtual time)', () => {
  it('stops reads and serialization while blocked, then reads only the latest of 100 changes', async () => {
    const { raw, reply, app } = setup();
    let revision = 0;
    let changed: () => void = () => undefined;
    const serialize = vi.fn((value: number) => ({ revision: value, text: 'x'.repeat(1024) }));
    const read = vi.fn(() => { const value = revision; return { toJSON: () => serialize(value) }; });
    const unsubscribe = vi.fn();
    const started = streamState(reply, read, callback => { changed = callback; return unsubscribe; }, () => false);
    await settle();
    const buffered = raw.writableLength;
    expect(raw.writableNeedDrain).toBe(true);
    for (revision = 1; revision <= 100; revision++) { changed(); await settle(); }
    revision = 100;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(read).toHaveBeenCalledTimes(1); expect(serialize).toHaveBeenCalledTimes(1);
    expect(raw.writableLength).toBe(buffered); expect(raw.frames).toHaveLength(1);
    expect(raw.listenerCount('drain')).toBe(1);
    raw.release(); await started; await settle();
    expect(read).toHaveBeenCalledTimes(2); expect(serialize).toHaveBeenCalledTimes(2);
    expect(raw.frames.filter(frame => frame.startsWith('event:'))).toHaveLength(2);
    expect(raw.frames[1]).toContain('"revision":100');
    closeStateStreams(app); await settle();
    expect(unsubscribe).toHaveBeenCalledTimes(1); expectClean(raw);
  });

  it('disconnects after 30 seconds without drain and stops all further work', async () => {
    const { raw, reply, app } = setup();
    let changed: () => void = () => undefined;
    const read = vi.fn(() => ({ text: 'x'.repeat(1024) }));
    const unsubscribe = vi.fn();
    const started = streamState(reply, read, callback => { changed = callback; return unsubscribe; }, () => false);
    await settle(); await vi.advanceTimersByTimeAsync(29_999); expect(raw.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await started; await settle();
    expect(raw.destroyed).toBe(true); expect(unsubscribe).toHaveBeenCalledTimes(1);
    changed(); closeStateStreams(app); await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1); expect(unsubscribe).toHaveBeenCalledTimes(1); expectClean(raw);
  });

  it('applies backpressure to heartbeat writes too', async () => {
    const { raw, reply } = setup(false, 1);
    let revision = 0;
    let changed: () => void = () => undefined;
    const read = vi.fn(() => ({ revision }));
    const started = streamState(reply, read, callback => { changed = callback; return () => undefined; }, () => false);
    await settle(); await started; await settle();
    const reads = read.mock.calls.length;
    raw.blocked = true;
    await vi.advanceTimersByTimeAsync(15_000);
    const buffered = raw.writableLength;
    expect(raw.frames.at(-1)).toBe(': keepalive\n\n'); expect(raw.writableNeedDrain).toBe(true);
    revision = 4; changed(); await vi.advanceTimersByTimeAsync(15_000);
    expect(raw.writableLength).toBe(buffered); expect(read).toHaveBeenCalledTimes(reads);
    raw.release(); await settle();
    expect(read).toHaveBeenCalledTimes(reads + 1); expect(raw.frames.at(-1)).toContain('"revision":4');
  });

  it('finishes a buffered terminal event only after the output can continue', async () => {
    const { raw, reply } = setup();
    const unsubscribe = vi.fn();
    const read = vi.fn(() => ({ terminal: true, text: 'x'.repeat(1024) }));
    const started = streamState(reply, read, () => unsubscribe, state => state.terminal);
    await settle();
    expect(raw.writableEnded).toBe(false); expect(raw.frames[0]).toContain('"terminal":true');
    raw.release(); await started; await settle();
    expect(raw.writableFinished).toBe(true); expect(read).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1); expectClean(raw);
  });

  it('handles a late transport failure after a small terminal write returned true and end began', async () => {
    const { raw, reply, app } = setup(true, 1024);
    const write = vi.spyOn(raw, 'write');
    const unsubscribe = vi.fn();
    const read = vi.fn(() => ({ terminal: true }));
    await streamState(reply, read, () => unsubscribe, state => state.terminal); await settle();
    expect(write).toHaveReturnedWith(true);
    expect(raw.writableEnded).toBe(true); expect(raw.writableFinished).toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    // No test-owned error handler: an unhandled error here must fail the test.
    raw.release(new Error('LATE_TRANSPORT_FAILURE')); await settle();
    expect(raw.destroyed).toBe(true); expect(raw.writableFinished).toBe(false);
    closeStateStreams(app);
    expect(read).toHaveBeenCalledTimes(1); expect(unsubscribe).toHaveBeenCalledTimes(1); expectClean(raw);
  });

  it('cleans up when a heartbeat write throws synchronously', async () => {
    const { raw, reply } = setup(false);
    const unsubscribe = vi.fn();
    await streamState(reply, () => ({}), () => unsubscribe, () => false); await settle();
    const write = vi.spyOn(raw, 'write').mockImplementation(() => { throw new Error('HEARTBEAT_WRITE_FAILED'); });
    await vi.advanceTimersByTimeAsync(15_000); await settle();
    expect(write).toHaveBeenCalledExactlyOnceWith(': keepalive\n\n');
    expect(raw.destroyed).toBe(true); expect(unsubscribe).toHaveBeenCalledTimes(1); expectClean(raw);
  });

  it('destroys a blocked stream immediately during explicit shutdown', async () => {
    const { raw, reply, app } = setup();
    const unsubscribe = vi.fn();
    const started = streamState(reply, () => ({ text: 'x'.repeat(1024) }), () => unsubscribe, () => false);
    await settle(); closeStateStreams(app); await started; await settle();
    expect(raw.destroyed).toBe(true); expect(unsubscribe).toHaveBeenCalledTimes(1); expectClean(raw);
  });

  it('rejects an oversized event by UTF-8 bytes before writing it', async () => {
    const { raw, reply } = setup(false);
    const unsubscribe = vi.fn();
    await streamState(reply, () => ({ text: '🔥'.repeat(300_000) }), () => unsubscribe, () => false);
    await settle();
    expect(raw.frames).toHaveLength(0); expect(raw.destroyed).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1); expectClean(raw);
  });

  it('caps queued bytes even if the Writable high-water mark is larger than the cap', async () => {
    const { raw, reply } = setup(true, 2 * 1024 * 1024);
    const unsubscribe = vi.fn();
    await streamState(reply, () => ({ text: 'x'.repeat(600_000) }), () => unsubscribe, () => false);
    await settle();
    expect(raw.destroyed).toBe(true); expect(raw.frames).toHaveLength(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1); expectClean(raw);
  });

  it('cleans up after subscription initialization rejects', async () => {
    const { raw, reply, app } = setup(false);
    await Promise.allSettled([streamState(reply, () => ({}), async () => { throw new Error('SUBSCRIBE_FAILED'); }, () => false)]);
    await settle();
    expect(raw.destroyed || raw.writableEnded).toBe(true); expect(raw.frames).toHaveLength(0); expectClean(raw);
    closeStateStreams(app); expectClean(raw);
  });

  it('unsubscribes a late subscription exactly once when the connection closes during initialization', async () => {
    const { raw, reply, app } = setup(false);
    const subscribed = deferred<() => void>();
    const unsubscribe = vi.fn();
    const started = streamState(reply, () => ({}), () => subscribed.promise, () => false);
    await settle(); raw.destroy(); await settle();
    subscribed.resolve(unsubscribe); await started; await settle(); closeStateStreams(app);
    expect(raw.frames).toHaveLength(0); expect(unsubscribe).toHaveBeenCalledTimes(1); expectClean(raw);
  });

  it('ignores a state read that completes after disconnection', async () => {
    const { raw, reply } = setup(false);
    const pending = deferred<{ revision: number }>();
    const unsubscribe = vi.fn();
    const read = vi.fn().mockReturnValueOnce({ revision: 0 }).mockReturnValue(pending.promise);
    const started = streamState(reply, read, () => unsubscribe, () => false);
    await settle(); expect(read).toHaveBeenCalledTimes(2);
    raw.destroy(); await settle(); pending.resolve({ revision: 1 }); await started; await settle();
    expect(raw.frames).toHaveLength(1); expect(unsubscribe).toHaveBeenCalledTimes(1); expectClean(raw);
  });

  it.each(['read', 'serialize', 'write'] as const)('cleans up after a %s failure', async failure => {
    const { raw, reply } = setup(false);
    const unsubscribe = vi.fn();
    const read = vi.fn((): object => ({}));
    if (failure === 'read') read.mockImplementationOnce(() => ({})).mockImplementation(() => { throw new Error('READ_FAILED'); });
    if (failure === 'serialize') read.mockReturnValue({ toJSON() { throw new Error('SERIALIZE_FAILED'); } });
    if (failure === 'write') vi.spyOn(raw, 'write').mockImplementation(() => { throw new Error('WRITE_FAILED'); });
    await Promise.allSettled([streamState(reply, read, () => unsubscribe, () => false)]); await settle();
    expect(raw.destroyed || raw.writableEnded).toBe(true); expect(unsubscribe).toHaveBeenCalledTimes(1); expectClean(raw);
  });
});
