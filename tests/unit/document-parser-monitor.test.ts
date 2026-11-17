import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { ParserMachineIdleMonitor } from '../../src/lib/document-parser-machine/monitor.js';
import type { IdleAction, MachineState } from '../../src/lib/document-parser-machine/index.js';

class Subscriber extends EventEmitter {
  async connect() { this.emit('ready'); }
  async subscribe() { return 1; }
  disconnect() { this.emit('close'); }
}
const monitors: ParserMachineIdleMonitor[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(2_000_000_000_000); });
afterEach(async () => { await Promise.all(monitors.splice(0).map(m => m.close())); vi.useRealTimers(); });
function setup(overrides: Partial<MachineState> = {}) {
  const state: MachineState = { phase: 'ready', queued: 0, active: 0, uncertain: 0, economicallyStopped: false, lastActivityMs: Date.now(), redisTimeMs: Date.now(), ...overrides };
  const subscriber = new Subscriber();
  const status = vi.fn(async () => ({ ...state, redisTimeMs: Date.now() }));
  const tick = vi.fn(async (): Promise<IdleAction> => {
    if (state.phase === 'stopping') { state.phase = 'ready'; state.economicallyStopped = true; return 'stop_confirmed'; }
    state.phase = 'stopping'; return 'stop_submitted';
  });
  const onError = vi.fn();
  const monitor = new ParserMachineIdleMonitor({ state: { status }, tick }, subscriber as unknown as Redis, 'test-events', 60000, { onError });
  monitors.push(monitor);
  return { state, subscriber, status, tick, monitor, onError, changed: () => subscriber.emit('message', 'test-events', 'changed') };
}
describe('event-driven document parser idle monitor (virtual time, mock subscriber)', () => {
  it('shares initialization and never restarts a closed monitor', async () => {
    const s = setup(), connect = vi.spyOn(s.subscriber, 'connect'), subscribe = vi.spyOn(s.subscriber, 'subscribe');
    const first = s.monitor.start(), second = s.monitor.start();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(connect).toHaveBeenCalledTimes(1); expect(subscribe).toHaveBeenCalledTimes(1);
    await s.monitor.close();
    await expect(s.monitor.start()).rejects.toThrow('DOCUMENT_PARSER_MONITOR_CLOSED');
    expect(connect).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('uses one idle deadline and one-minute stop verification, then stops all fallback checks', async () => {
    const s = setup(); await s.monitor.start();
    const initialReads = s.status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(59999); expect(s.tick).not.toHaveBeenCalled(); expect(s.status).toHaveBeenCalledTimes(initialReads);
    await vi.advanceTimersByTimeAsync(1); expect(s.tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59999); expect(s.tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(s.tick).toHaveBeenCalledTimes(2); expect(s.state.economicallyStopped).toBe(true);
    const reads = s.status.mock.calls.length; await vi.advanceTimersByTimeAsync(600000);
    expect(s.tick).toHaveBeenCalledTimes(2); expect(s.status).toHaveBeenCalledTimes(reads); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels the deadline on arrival and counts a fresh minute after completion', async () => {
    const s = setup(); await s.monitor.start(); await vi.advanceTimersByTimeAsync(59000);
    s.state.active = 1; s.changed(); await vi.advanceTimersByTimeAsync(61000); expect(s.tick).not.toHaveBeenCalled();
    s.state.active = 0; s.state.lastActivityMs = Date.now(); s.changed(); await vi.advanceTimersByTimeAsync(59999);
    expect(s.tick).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1); expect(s.tick).toHaveBeenCalledTimes(1);
  });
  it('remains asleep across restart when Redis already confirms economical stop, until a request event', async () => {
    const s = setup({ economicallyStopped: true }); await s.monitor.start();
    const reads = s.status.mock.calls.length; await vi.advanceTimersByTimeAsync(3_600_000);
    expect(s.status).toHaveBeenCalledTimes(reads); expect(s.tick).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    s.state.economicallyStopped = false; s.state.active = 1; s.changed(); await vi.advanceTimersByTimeAsync(0);
    s.state.active = 0; s.state.lastActivityMs = Date.now(); s.changed(); await vi.advanceTimersByTimeAsync(60000);
    expect(s.tick).toHaveBeenCalledTimes(1);
  });
  it('recovers a lost completion notification with one temporary one-minute Redis check', async () => {
    const s = setup({ active: 1 }); await s.monitor.start();
    s.state.active = 0; // Intentionally no Pub/Sub event.
    await vi.advanceTimersByTimeAsync(59999); expect(s.tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(s.tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000); expect(s.state.economicallyStopped).toBe(true);
    const reads = s.status.mock.calls.length; await vi.advanceTimersByTimeAsync(600000); expect(s.status).toHaveBeenCalledTimes(reads);
  });
  it('clears timers while disconnected and reconciles on reconnect', async () => {
    const s = setup(); await s.monitor.start(); s.subscriber.emit('close');
    await vi.advanceTimersByTimeAsync(120000); expect(s.tick).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    s.subscriber.emit('ready'); await vi.advanceTimersByTimeAsync(0); expect(s.tick).toHaveBeenCalledTimes(1);
  });
  it('backs off a rejected cloud operation for one minute instead of forming an event loop', async () => {
    const s = setup(); s.tick.mockRejectedValue(new Error('CONTROL_REJECTED')); await s.monitor.start();
    await vi.advanceTimersByTimeAsync(60000); expect(s.tick).toHaveBeenCalledTimes(1); expect(s.onError).toHaveBeenCalledTimes(1);
    s.changed(); await vi.advanceTimersByTimeAsync(59999); expect(s.tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(s.tick).toHaveBeenCalledTimes(2);
  });
  it.each([{ uncertain: 1, active: 1 }, { phase: 'blocked' as const }])('does not spin on stable reconciliation barriers %j', async override => {
    const s = setup(override); await s.monitor.start(); const reads = s.status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600000); expect(s.status).toHaveBeenCalledTimes(reads); expect(s.tick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('closes its subscription and timers without subsequent cloud calls', async () => {
    const s = setup(); await s.monitor.start(); await s.monitor.close(); s.changed();
    await vi.advanceTimersByTimeAsync(120000); expect(s.tick).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not begin a cloud check after closing while a deadline state read is pending', async () => {
    const s = setup(); await s.monitor.start();
    let resolve!: (state: MachineState) => void;
    s.status.mockImplementationOnce(() => new Promise<MachineState>(done => { resolve = done; }));
    await vi.advanceTimersByTimeAsync(60000);
    const closing = s.monitor.close();
    resolve({ ...s.state, redisTimeMs: Date.now() });
    await closing;
    expect(s.tick).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
