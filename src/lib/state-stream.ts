import type { FastifyReply, FastifyInstance } from 'fastify';
import { performance } from 'node:perf_hooks';
import { currentTelemetryFields } from '../observability/telemetry.js';

const streams = new WeakMap<FastifyInstance, Set<() => void>>();
const maxBufferedBytes = 1024 * 1024;
const drainTimeoutMs = 30_000;
type StreamOutcome = 'completed'|'client_abort'|'error'|'timeout'|'shutdown'|'backpressure'|'cancelled';
export interface StateStreamObservation<T> {
  kind?: 'node_status'|'document_trial'|'state';
  terminalOutcome?: (value: T) => 'completed'|'error'|'cancelled';
}

export function closeStateStreams(app: FastifyInstance) {
  for (const close of streams.get(app) ?? []) close();
}

/** Latest-state snapshots only: notifications coalesce while the client is busy. */
export async function streamState<T>(
  reply: FastifyReply,
  read: () => Promise<T> | T,
  subscribe: (changed: () => void) => Promise<() => void> | (() => void),
  terminal: (state: T) => boolean,
  observation: StateStreamObservation<T> = {},
) {
  // Preserve ordinary HTTP errors (including authorization) before hijacking.
  const initial = await read();
  const raw = reply.raw;
  if (raw.destroyed || raw.writableEnded) return;
  const started = performance.now(), trace = currentTelemetryFields();
  let firstEventSeconds: number|undefined, eventCount = 0, reported = false;
  let endReason: StreamOutcome|undefined;
  const kind = observation.kind ?? 'state';
  const headers = Object.fromEntries(Object.entries(reply.getHeaders()).map(([name, value]) =>
    [name, Array.isArray(value) ? value.map(String) : value === undefined ? undefined : String(value)]));
  reply.hijack();
  raw.writeHead(200, {
    ...headers,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false, initialized = false, busy = false, dirty = false;
  let unsubscribe: (() => void) | undefined;
  let releaseDrain: ((drained: boolean) => void) | undefined;
  const group = streams.get(reply.server) ?? new Set<() => void>();
  streams.set(reply.server, group);
  const shutdown = () => finish('shutdown');

  function report(outcome: StreamOutcome) {
    if (reported) return;
    reported = true;
    const seconds = Math.max(0, (performance.now() - started) / 1000);
    try { reply.server.metrics.recordStream(kind, outcome, seconds, firstEventSeconds, eventCount); }
    catch { /* Observation must never change the stream or its cleanup. */ }
    try { reply.log.info({ event: 'stream.closed', ...trace, streamKind: kind, outcome,
      durationMs: seconds * 1000, firstEventMs: firstEventSeconds === undefined ? undefined : firstEventSeconds * 1000, eventCount }, 'State stream closed'); }
    catch { /* A logging failure cannot leave a subscription running. */ }
  }

  function stopSubscription() {
    const stop = unsubscribe;
    unsubscribe = undefined;
    try { stop?.(); } catch (error) { reply.log.warn({ err: error }, 'State stream subscription cleanup failed'); }
  }
  function stop() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    releaseDrain?.(false);
    group.delete(shutdown);
    stopSubscription();
  }
  function close() {
    report(endReason ?? (raw.writableFinished ? 'completed' : 'client_abort'));
    stop();
    raw.off('close', close);
    raw.off('finish', close);
    raw.off('error', onError);
  }
  function abort(reason: StreamOutcome = 'error') { endReason = reason; stop(); raw.destroy(); }
  function onError() { abort('error'); }
  function finish(reason: StreamOutcome) {
    // Shutdown must not wait forever for a client that stopped reading.
    const blocked = Boolean(releaseDrain);
    endReason = reason;
    stop();
    if (blocked) raw.destroy(); else if (!raw.destroyed) raw.end();
  }

  async function write(frame: string): Promise<boolean> {
    if (closed) return false;
    // highWaterMark is a signal, not a cap. Bound even a single large snapshot.
    if (raw.writableLength + Buffer.byteLength(frame) > maxBufferedBytes) {
      abort('backpressure');
      return false;
    }
    const writable = raw.write(frame);
    if (frame.startsWith('event: update\n')) {
      eventCount++;
      firstEventSeconds ??= Math.max(0, (performance.now() - started) / 1000);
    }
    if (writable) return true;
    return new Promise(resolve => {
      const timer = setTimeout(() => abort('timeout'), drainTimeoutMs);
      timer.unref();
      const drained = () => releaseDrain?.(true);
      releaseDrain = (success: boolean) => {
        clearTimeout(timer);
        raw.off('drain', drained);
        releaseDrain = undefined;
        resolve(success);
      };
      raw.once('drain', drained);
    });
  }

  async function send(value: T) {
    if (closed) return;
    const last = terminal(value);
    if (await write('event: update\ndata: ' + JSON.stringify(value) + '\n\n') && last) {
      finish(observation.terminalOutcome?.(value) ?? 'completed');
    }
  }
  function resume() {
    busy = false;
    if (dirty && !closed) pump();
  }
  function pump(first?: { value: T }) {
    if (closed || busy || !initialized) return;
    busy = true;
    void (async () => {
      if (first) {
        await send(first.value);
        // Recheck after subscribing so changes during setup are not lost.
        dirty = true;
      }
      while (dirty && !closed) {
        dirty = false;
        await send(await read());
      }
    })().catch(() => abort('error')).finally(resume);
  }
  const changed = () => { if (!closed) { dirty = true; pump(); } };
  const heartbeat = setInterval(() => {
    if (closed || busy || !initialized) return;
    busy = true;
    void write(': keepalive\n\n').catch(() => abort('error')).finally(resume);
  }, 15_000);
  heartbeat.unref();
  group.add(shutdown);
  raw.on('close', close);
  // A write returning true can still fail asynchronously before end completes.
  raw.on('finish', close);
  raw.on('error', onError);

  try {
    unsubscribe = await subscribe(changed);
    if (closed) stopSubscription();
    else { initialized = true; pump({ value: initial }); }
  } catch (error) {
    abort();
    throw error;
  }
}
