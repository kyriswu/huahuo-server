import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentParserConfig } from '../../src/config/document-parser-machine.js';
import { createDocumentParserMachine } from '../../src/lib/document-parser-machine/index.js';

class Subscriber extends EventEmitter {
  connect = vi.fn(async () => { this.emit('ready'); });
  subscribe = vi.fn(async () => 1);
  disconnect = vi.fn(() => { this.emit('close'); });
}
const runtimes: ReturnType<typeof createDocumentParserMachine>[] = [];
const releaseGates: (() => void)[] = [];
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  releaseGates.push(resolve);
  return { promise, resolve };
}
function setup(...subscribers: Subscriber[]) {
  const duplicate = vi.spyOn(Redis.prototype, 'duplicate').mockImplementation(() => {
    const subscriber = subscribers.shift();
    if (!subscriber) throw new Error('UNEXPECTED_SUBSCRIBER');
    return subscriber as unknown as Redis;
  });
  const config = createDocumentParserConfig({
    mode: 'ecs', regionId: 'cn-beijing', instanceId: 'i-unittest123456', privateIp: '172.18.102.101',
    credentials: async () => ({ accessKeyId: 'unit-ak', accessKeySecret: 'unit-secret' }),
  });
  // The primary Redis client stays lazy; only the controlled subscribers above can connect.
  const runtime = createDocumentParserMachine(config, 'redis://127.0.0.1:1', 'unit-monitor');
  const status = vi.spyOn(runtime.machine.state, 'status').mockResolvedValue(undefined);
  const tick = vi.spyOn(runtime.machine, 'tick').mockRejectedValue(new Error('UNEXPECTED_CLOUD_CHECK'));
  runtimes.push(runtime);
  return { runtime, duplicate, status, tick };
}
function expectDetached(subscriber: Subscriber) {
  expect(subscriber.disconnect).toHaveBeenCalledTimes(1);
  for (const event of ['message', 'ready', 'close']) expect(subscriber.listenerCount(event)).toBe(0);
  // The runtime's no-op error listener remains; the monitor's error listener is removed.
  expect(subscriber.listenerCount('error')).toBe(1);
}
afterEach(async () => {
  for (const release of releaseGates.splice(0)) release();
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  vi.restoreAllMocks();
});

describe('parser runtime monitor lifecycle (actual runtime/monitor, mock Redis transport and cloud check)', () => {
  it.each(['connect', 'subscribe'] as const)('releases a failed initial %s and rebuilds on the next scan', async operation => {
    const failed = new Subscriber(), recovered = new Subscriber();
    failed[operation].mockRejectedValueOnce(new Error('REDIS_UNAVAILABLE'));
    const s = setup(failed, recovered);
    await expect(s.runtime.startIdleMonitor()).rejects.toThrow('DOCUMENT_PARSER_SUBSCRIPTION_FAILED');
    expectDetached(failed);
    failed.emit('ready'); failed.emit('message', 'changed');
    expect(s.status).not.toHaveBeenCalled();

    await s.runtime.startIdleMonitor();
    expect(s.duplicate).toHaveBeenCalledTimes(2);
    expect(recovered.connect).toHaveBeenCalledTimes(1);
    expect(recovered.subscribe).toHaveBeenCalledExactlyOnceWith(s.runtime.machine.state.eventsChannel);
    expect(s.status).toHaveBeenCalledTimes(1);
    expect(s.tick).not.toHaveBeenCalled();
  });

  it('shares pending initialization across concurrent scans and keeps the successful subscription', async () => {
    const subscriber = new Subscriber(), subscribed = gate(), releaseSubscription = gate();
    subscriber.subscribe.mockImplementation(async () => { subscribed.resolve(); await releaseSubscription.promise; return 1; });
    const s = setup(subscriber);
    const first = s.runtime.startIdleMonitor(), second = s.runtime.startIdleMonitor();
    expect(second).toBe(first);
    await subscribed.promise;
    expect(s.duplicate).toHaveBeenCalledTimes(1);
    expect(subscriber.connect).toHaveBeenCalledTimes(1);
    expect(s.status).not.toHaveBeenCalled();
    releaseSubscription.resolve();
    await Promise.all([first, second]);
    await s.runtime.startIdleMonitor();
    expect(s.duplicate).toHaveBeenCalledTimes(1);
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
    expect(s.status).toHaveBeenCalledTimes(1);
  });

  it('reports initialization failure to all concurrent callers before allowing a new attempt', async () => {
    const failed = new Subscriber(), recovered = new Subscriber(), releaseConnect = gate();
    failed.connect.mockImplementation(async () => { await releaseConnect.promise; throw new Error('REDIS_UNAVAILABLE'); });
    const s = setup(failed, recovered);
    const first = s.runtime.startIdleMonitor(), second = s.runtime.startIdleMonitor();
    const results = Promise.allSettled([first, second]);
    expect(second).toBe(first);
    releaseConnect.resolve();
    expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
    expectDetached(failed);
    await s.runtime.startIdleMonitor();
    expect(s.duplicate).toHaveBeenCalledTimes(2);
    expect(s.status).toHaveBeenCalledTimes(1);
  });

  it.each(['connect', 'subscribe'] as const)('closes during pending %s without late activation or reconstruction', async operation => {
    const subscriber = new Subscriber(), entered = gate(), releaseOperation = gate();
    if (operation === 'connect') {
      subscriber.connect.mockImplementation(async () => { entered.resolve(); await releaseOperation.promise; });
    } else {
      subscriber.subscribe.mockImplementation(async () => { entered.resolve(); await releaseOperation.promise; return 1; });
    }
    const s = setup(subscriber), starting = s.runtime.startIdleMonitor();
    await entered.promise;
    const closing = s.runtime.close();
    expect(s.runtime.close()).toBe(closing);
    expectDetached(subscriber);
    await s.runtime.startIdleMonitor();
    releaseOperation.resolve();
    await Promise.all([starting, closing]);
    subscriber.emit('ready'); subscriber.emit('message', s.runtime.machine.state.eventsChannel);
    await s.runtime.startIdleMonitor();
    expect(s.duplicate).toHaveBeenCalledTimes(1);
    expect(subscriber.subscribe).toHaveBeenCalledTimes(operation === 'connect' ? 0 : 1);
    expect(s.status).not.toHaveBeenCalled();
    expect(s.tick).not.toHaveBeenCalled();
    expectDetached(subscriber);
  });
});
