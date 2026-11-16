import { afterEach, describe, expect, it } from 'vitest';
import { buildBase } from '../../src/apps/base.js';
import { ApplicationLifecycle } from '../../src/plugins/lifecycle.js';
import { config, dependencies } from '../helpers.js';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { streamState } from '../../src/lib/state-stream.js';

const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => child.exitCode !== null || child.signalCode !== null ? undefined :
    new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGKILL'); })));
});

function start(workMs = 11000, shutdownMs = 15000, leak = false) {
  const child = fork(fileURLToPath(new URL('../support/shutdown-process.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'],
    env: { PATH: process.env.PATH, FIXTURE_WORK_MS: String(workMs), FIXTURE_SHUTDOWN_MS: String(shutdownMs), FIXTURE_LEAK: String(leak) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.push(child);
  const messages: Array<{ event: string; address?: string }> = [];
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  child.on('message', message => { messages.push(message as typeof messages[number]); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const wait = async (event: string) => {
    for (let n = 0; n < 500; n++) {
      const message = messages.find(message => message.event === event);
      if (message) return message;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Child exited before ${event}: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Child did not report ${event}: ${stderr}`);
  };
  return { child, wait, exit, messages };
}

describe('application drain and shutdown', () => {
  it.each(['api-server', 'admin', 'worker', 'scheduler'] as const)('%s handles an existing socket during preClose with the intended closing policy', async role => {
    let dependenciesClosed = false, handled = 0;
    const app = await buildBase({ config: config(role), dependencies: { ...dependencies(), close: async () => { dependenciesClosed = true; } } });
    let entered!: () => void, release!: () => void;
    const preClose = new Promise<void>(resolve => { entered = resolve; });
    const finishPreClose = new Promise<void>(resolve => { release = resolve; });
    app.addHook('preClose', async () => { entered(); await finishPreClose; });
    app.post('/late-business', async () => { handled++; expect(dependenciesClosed).toBe(false); return { completed: true }; });
    const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
    // Establish the upstream connection before shutdown. Its HTTP request arrives
    // only after Fastify has entered closing, while preClose still holds it open.
    const socket = createConnection({ host: '127.0.0.1', port: Number(address.port) });
    socket.setTimeout(2000, () => socket.destroy(new Error('LATE_REQUEST_TIMEOUT')));
    const response = new Promise<string>((resolve, reject) => {
      let body = '';
      socket.setEncoding('utf8'); socket.on('data', chunk => { body += chunk; });
      socket.once('end', () => resolve(body)); socket.once('error', reject);
    });
    let closing: Promise<void> | undefined;
    try {
      await once(socket, 'connect');
      closing = app.close(); await preClose;
      expect(app.lifecycle.phase).toBe('closing');
      socket.write('POST /late-business HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n');
      const body = await response;
      expect(body).toMatch(role === 'api-server' ? /^HTTP\/1\.1 200 / : /^HTTP\/1\.1 503 /);
      expect(body).toMatch(/\r\nconnection: close\r\n/i);
      expect(handled).toBe(role === 'api-server' ? 1 : 0);
      if (role === 'api-server') expect(body).toContain('{"completed":true}');
      expect(dependenciesClosed).toBe(false);
    } finally { release(); socket.destroy(); await (closing ?? app.close()); }
    expect(dependenciesClosed).toBe(true);
  });

  it('withdraws readiness while keeping liveness and routed business requests available', async () => {
    const app = await buildBase({ config: config(), dependencies: dependencies() });
    let release!: () => void;
    app.get('/slow', async () => { await new Promise<void>(resolve => { release = resolve; }); return 'finished'; });
    app.get('/business', async () => 'ok');
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const pending = fetch(address + '/slow');
    try {
      while (!release) await new Promise(resolve => setTimeout(resolve, 5));
      expect(app.lifecycle.activeRequests).toBe(1);
      await app.lifecycle.drain();
      expect((await app.inject('/health/ready')).statusCode).toBe(503);
      expect((await app.inject('/health/live')).statusCode).toBe(200);
      expect((await app.inject('/business')).statusCode).toBe(200);
      expect(app.lifecycle.activeRequests).toBe(1);
      const metrics = await app.metrics.registry.metrics();
      expect(metrics).toMatch(/application_draining\{[^\n]+\} 1/);
      expect(metrics).toMatch(/http_requests_in_flight\{[^\n]+\} 1/);
      release();
      expect(await (await pending).text()).toBe('finished');
      expect(app.lifecycle.activeRequests).toBe(0);
    } finally { release?.(); await pending; await app.close(); }
  });

  it('runs stop-admission hooks once without delaying one behind another', async () => {
    const lifecycle = new ApplicationLifecycle();
    let release!: () => void; let calls = 0;
    lifecycle.onDrain(() => new Promise<void>(resolve => { release = resolve; }));
    lifecycle.onDrain(() => { calls++; });
    const first = lifecycle.drain();
    expect(lifecycle.drain()).toBe(first);
    expect(calls).toBe(1);
    expect(lifecycle.phase).toBe('draining');
    release(); await first; await lifecycle.close();
    expect(calls).toBe(1); expect(lifecycle.phase).toBe('closing');
  });

  it('finishes a stream whose headers were sent before shutdown and releases its idle socket', async () => {
    const app = await buildBase({ config: config(), dependencies: dependencies() });
    let finish!: () => void;
    app.get('/stream', (_request, reply) => {
      reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/plain' }); reply.raw.write('first');
      finish = () => { reply.raw.end('last'); };
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await fetch(address + '/stream');
      const result = response.text();
      expect(app.lifecycle.activeRequests).toBe(1);
      const closing = app.close();
      while (app.lifecycle.phase === 'serving') await new Promise(resolve => setTimeout(resolve, 5));
      finish();
      expect(await result).toBe('firstlast');
      await closing;
      expect(app.lifecycle.activeRequests).toBe(0);
      expect(app.lifecycle.phase).toBe('closed');
    } finally { finish?.(); await app.close(); }
  });

  it.each(['api-server', 'admin'] as const)('%s applies its shutdown policy to a real state SSE subscription', async role => {
    let dependenciesClosed = false, unsubscribed = false, terminal = false;
    let changed: () => void = () => undefined;
    const app = await buildBase({ config: config(role), dependencies: {
      ...dependencies(), close: async () => { dependenciesClosed = true; },
    } });
    let entered!: () => void;
    const preClosed = new Promise<void>(resolve => { entered = resolve; });
    app.addHook('preClose', async () => { entered(); });
    app.get('/state-stream', async (_request, reply) => streamState(reply,
      () => ({ terminal }), update => { changed = update; return () => { unsubscribed = true; }; },
      state => state.terminal));
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const abort = new AbortController();
    let closing: Promise<void> | undefined;
    let body: Promise<string> | undefined;
    try {
      const response = await fetch(address + '/state-stream', { signal: abort.signal });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      body = response.text();
      await app.lifecycle.drain();
      expect((await app.inject('/health/ready')).statusCode).toBe(503);
      expect((await app.inject('/health/live')).statusCode).toBe(200);
      expect(app.lifecycle.activeRequests).toBe(1);
      expect(unsubscribed).toBe(false);
      closing = app.close();
      await preClosed;
      if (role === 'api-server') {
        expect(app.lifecycle.phase).toBe('closing');
        expect(dependenciesClosed).toBe(false);
        expect(unsubscribed).toBe(false);
        expect(app.lifecycle.activeRequests).toBe(1);
        terminal = true;
        changed();
        expect(await body).toContain('data: {"terminal":true}');
      } else {
        expect(await body).not.toContain('data: {"terminal":true}');
      }
      await closing;
      expect(app.lifecycle.activeRequests).toBe(0);
      expect(unsubscribed).toBe(true);
      expect(dependenciesClosed).toBe(true);
    } finally {
      terminal = true; changed(); abort.abort();
      await body?.catch(() => undefined);
      await (closing ?? app.close());
    }
  });

  it('honors SIGUSR2 then SIGTERM and finishes work lasting beyond the old ten-second deadline', async () => {
    const fixture = start();
    const address = (await fixture.wait('ready')).address!;
    fixture.child.kill('SIGUSR2');
    let unready = false;
    for (let n = 0; n < 100; n++) {
      if ((await fetch(address + '/health/ready')).status === 503) { unready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(unready).toBe(true);
    expect((await fetch(address + '/health/live')).status).toBe(200);
    expect((await fetch(address + '/business')).status).toBe(200);
    const response = fetch(address + '/slow');
    await fixture.wait('request-started');
    fixture.child.kill('SIGTERM');
    expect(await (await response).json()).toEqual({ done: true });
    expect(await fixture.exit).toEqual({ code: 0, signal: null });
    expect(fixture.messages.some(message => message.event === 'dependencies-closed')).toBe(true);
  }, 25000);

  it('still exits unsuccessfully when in-flight work exceeds its configured deadline', async () => {
    const fixture = start(10000, 1000);
    const address = (await fixture.wait('ready')).address!;
    const response = fetch(address + '/slow').then(() => 'completed', () => 'interrupted');
    await fixture.wait('request-started'); fixture.child.kill('SIGTERM');
    expect(await fixture.exit).toEqual({ code: 124, signal: null });
    expect(await response).toBe('interrupted');
    expect(fixture.messages.some(message => message.event === 'dependencies-closed')).toBe(false);
  }, 10000);

  it('bounds an unfinished API state SSE by the same process drain deadline', async () => {
    const fixture = start(10000, 1000);
    const address = (await fixture.wait('ready')).address!;
    const response = await fetch(address + '/state-stream');
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = response.text().then(() => 'completed', () => 'interrupted');
    await fixture.wait('stream-started');
    fixture.child.kill('SIGTERM');
    expect(await fixture.exit).toEqual({ code: 124, signal: null });
    expect(await body).toBe('interrupted');
    expect(fixture.messages.some(message => message.event === 'dependencies-closed')).toBe(false);
  }, 10000);

  it('exits immediately after completed cleanup even when an unrelated handle remains', async () => {
    const fixture = start(10, 1000, true);
    await fixture.wait('ready'); fixture.child.kill('SIGTERM');
    expect(await fixture.exit).toEqual({ code: 0, signal: null });
    expect(fixture.messages.some(message => message.event === 'dependencies-closed')).toBe(true);
  }, 10000);

  it('does not abort active work when SIGTERM is sent more than once', async () => {
    const fixture = start(300, 1500);
    const address = (await fixture.wait('ready')).address!;
    const response = fetch(address + '/slow');
    await fixture.wait('request-started'); fixture.child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 30)); fixture.child.kill('SIGTERM');
    expect(await (await response).json()).toEqual({ done: true });
    expect(await fixture.exit).toEqual({ code: 0, signal: null });
  }, 10000);
});
