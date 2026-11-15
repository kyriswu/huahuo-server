import { afterEach, describe, expect, it } from 'vitest';
import { buildBase } from '../../src/apps/base.js';
import { ApplicationLifecycle } from '../../src/plugins/lifecycle.js';
import { config, dependencies } from '../helpers.js';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
    expect(await fixture.exit).toEqual({ code: 1, signal: null });
    expect(await response).toBe('interrupted');
    expect(fixture.messages.some(message => message.event === 'dependencies-closed')).toBe(false);
  }, 10000);

  it('keeps the deadline effective if a handle leaks after successful cleanup', async () => {
    const fixture = start(10, 1000, true);
    await fixture.wait('ready'); fixture.child.kill('SIGTERM');
    expect(await fixture.exit).toEqual({ code: 1, signal: null });
    expect(fixture.messages.some(message => message.event === 'dependencies-closed')).toBe(true);
  }, 10000);
});
