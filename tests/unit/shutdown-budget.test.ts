import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShutdownController } from '../../src/entrypoints/runtime.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture(read = async () => 600000) {
  let finish!: () => void;
  const app = {
    lifecycle: { drain: vi.fn(async () => undefined) },
    close: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })),
    log: { info: vi.fn(), error: vi.fn() },
    drainTimeoutSnapshotMs: () => 600000,
    readDrainTimeoutMs: vi.fn(read),
  };
  const exit = vi.fn(), closed = vi.fn();
  const controller = createShutdownController(app, { now: () => Date.now(), exit, onClosed: closed });
  return { app, exit, closed, controller, finish: () => finish() };
}

describe('one database drain deadline across withdrawal and stop signals', () => {
  it('allows the default ten minutes and never extends it when SIGTERM follows SIGUSR2', async () => {
    vi.useFakeTimers(); const f = fixture();
    await f.controller.drain();
    await vi.advanceTimersByTimeAsync(300001);
    expect(f.exit).not.toHaveBeenCalled();
    const stopping = f.controller.stop();
    await vi.advanceTimersByTimeAsync(0);
    await f.controller.drain(); await f.controller.stop();
    await vi.advanceTimersByTimeAsync(299998);
    expect(f.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.exit.mock.calls).toEqual([[124]]);
    expect(f.app.log.error).toHaveBeenCalledWith({ reason: 'DRAIN_DEADLINE_EXCEEDED' }, 'Drain deadline exceeded');
    expect(f.app.lifecycle.drain).toHaveBeenCalledTimes(1); expect(f.app.readDrainTimeoutMs).toHaveBeenCalledTimes(1);
    f.finish(); await stopping; expect(f.exit.mock.calls).toEqual([[124]]);
  });

  it('counts configuration read time in the same budget and honors a longer validated database value', async () => {
    vi.useFakeTimers(); const f = fixture(() => new Promise(resolve => setTimeout(() => resolve(900000), 1000)));
    const draining = f.controller.drain();
    await vi.advanceTimersByTimeAsync(1000); await draining;
    await vi.advanceTimersByTimeAsync(898999); expect(f.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(f.exit.mock.calls).toEqual([[124]]);
  });

  it('finishes immediately when close hooks and active work complete rather than waiting out the budget', async () => {
    vi.useFakeTimers(); const f = fixture();
    const stopping = f.controller.stop(); await vi.advanceTimersByTimeAsync(250);
    f.finish(); await stopping;
    expect(f.exit.mock.calls).toEqual([[0]]); expect(f.closed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3600000); expect(f.exit.mock.calls).toEqual([[0]]);
  });

  it('uses the last valid snapshot when configuration loading fails', async () => {
    vi.useFakeTimers(); const f = fixture(async () => { throw new Error('private database failure'); });
    f.app.drainTimeoutSnapshotMs = () => 1200000;
    await f.controller.drain();
    await vi.advanceTimersByTimeAsync(1199999); expect(f.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(f.exit.mock.calls).toEqual([[124]]);
    expect(JSON.stringify(f.app.log.error.mock.calls)).not.toContain('private database failure');
  });

  it('distinguishes a close failure from a drain deadline so the host cannot mark it successful', async () => {
    vi.useFakeTimers(); const f = fixture();
    f.app.close.mockRejectedValueOnce(new Error('private shutdown failure'));
    await f.controller.stop(); expect(f.exit.mock.calls).toEqual([[1]]);
    expect(f.app.log.error).toHaveBeenCalledWith({ reason: 'SHUTDOWN_FAILED' }, 'Shutdown failed');
    await vi.advanceTimersByTimeAsync(600000); expect(f.exit.mock.calls).toEqual([[1]]);
  });

  it('never accepts a production budget shorter than ten minutes without an explicit test injection', async () => {
    vi.useFakeTimers(); const f = fixture(async () => 300000);
    await f.controller.drain();
    await vi.advanceTimersByTimeAsync(300000); expect(f.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300000); expect(f.exit.mock.calls).toEqual([[124]]);
  });
});
