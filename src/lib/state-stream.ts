import type { FastifyReply, FastifyInstance } from 'fastify';

const streams = new WeakMap<FastifyInstance, Set<() => void>>();
const maxBufferedBytes = 1024 * 1024;
const drainTimeoutMs = 30_000;

export function closeStateStreams(app: FastifyInstance) {
  for (const close of streams.get(app) ?? []) close();
}

/** Latest-state snapshots only: notifications coalesce while the client is busy. */
export async function streamState<T>(
  reply: FastifyReply,
  read: () => Promise<T> | T,
  subscribe: (changed: () => void) => Promise<() => void> | (() => void),
  terminal: (state: T) => boolean,
) {
  // Preserve ordinary HTTP errors (including authorization) before hijacking.
  const initial = await read();
  const raw = reply.raw;
  if (raw.destroyed || raw.writableEnded) return;
  reply.hijack();
  raw.writeHead(200, {
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
    group.delete(finish);
    stopSubscription();
  }
  function close() {
    stop();
    raw.off('close', close);
    raw.off('finish', close);
    raw.off('error', abort);
  }
  function abort() { stop(); raw.destroy(); }
  function finish() {
    // Shutdown must not wait forever for a client that stopped reading.
    const blocked = Boolean(releaseDrain);
    stop();
    if (blocked) raw.destroy(); else if (!raw.destroyed) raw.end();
  }

  async function write(frame: string): Promise<boolean> {
    if (closed) return false;
    // highWaterMark is a signal, not a cap. Bound even a single large snapshot.
    if (raw.writableLength + Buffer.byteLength(frame) > maxBufferedBytes) {
      abort();
      return false;
    }
    if (raw.write(frame)) return true;
    return new Promise(resolve => {
      const timer = setTimeout(abort, drainTimeoutMs);
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
    if (await write('event: update\ndata: ' + JSON.stringify(value) + '\n\n') && last) finish();
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
    })().catch(abort).finally(resume);
  }
  const changed = () => { if (!closed) { dirty = true; pump(); } };
  const heartbeat = setInterval(() => {
    if (closed || busy || !initialized) return;
    busy = true;
    void write(': keepalive\n\n').catch(abort).finally(resume);
  }, 15_000);
  heartbeat.unref();
  group.add(finish);
  raw.on('close', close);
  // A write returning true can still fail asynchronously before end completes.
  raw.on('finish', close);
  raw.on('error', abort);

  try {
    unsubscribe = await subscribe(changed);
    if (closed) stopSubscription();
    else { initialized = true; pump({ value: initial }); }
  } catch (error) {
    abort();
    throw error;
  }
}
