import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { RuntimeSettings } from '../../src/modules/runtime-settings/service.js';
import { DEFAULT_DRAIN_TIMEOUT_MS, DRAIN_TIMEOUT_KEY, validateStoredValues, validateValues } from '../../src/modules/runtime-settings/registry.js';
import { config } from '../helpers.js';

const row = (values: Record<string, unknown>) => ({ rows: [{ revision: 1, values, updated_at: new Date('2026-11-15T00:00:00Z') }] });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('database-owned drain settings and bounded fallback', () => {
  it('defaults missing configuration to ten minutes and rejects budgets below ten or above sixty minutes', () => {
    expect(validateStoredValues({}, config())[DRAIN_TIMEOUT_KEY]).toBe(DEFAULT_DRAIN_TIMEOUT_MS);
    expect(validateValues({ [DRAIN_TIMEOUT_KEY]: 3600000 }, config())[DRAIN_TIMEOUT_KEY]).toBe(3600000);
    for (const invalid of [0, 300000, 599999, 3600001, 600000.5, '600000']) {
      expect(() => validateValues({ [DRAIN_TIMEOUT_KEY]: invalid }, config())).toThrow('CONFIGURATION_INVALID');
    }
  });

  it('reads a validated database value and shares that valid snapshot between settings readers for the same process config', async () => {
    const base = config(), query = vi.fn().mockResolvedValue(row({ [DRAIN_TIMEOUT_KEY]: 900000, 'deployment.futureOptional': { enabled: false } }));
    const pool = { query } as unknown as pg.Pool;
    const first = new RuntimeSettings(pool, base), second = new RuntimeSettings(pool, base);
    expect(first.drainTimeoutSnapshotMs()).toBe(600000);
    expect(await first.readDrainTimeoutMs()).toBe(900000); expect(second.drainTimeoutSnapshotMs()).toBe(900000);
    query.mockRejectedValueOnce(new Error('private connection detail'));
    expect(await second.readDrainTimeoutMs()).toBe(900000);
  });

  it('returns the default for a missing row or invalid stored budget without accepting an unsafe new snapshot', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce(row({ [DRAIN_TIMEOUT_KEY]: 300000 }));
    const settings = new RuntimeSettings({ query } as unknown as pg.Pool, config());
    expect(await settings.readDrainTimeoutMs()).toBe(600000);
    expect(await settings.readDrainTimeoutMs()).toBe(600000);
    expect(settings.drainTimeoutSnapshotMs()).toBe(600000);
  });

  it('uses the documented default when a missing row is observed even after an older valid snapshot', async () => {
    const query = vi.fn().mockResolvedValueOnce(row({ [DRAIN_TIMEOUT_KEY]: 1200000 })).mockResolvedValueOnce({ rows: [] });
    const settings = new RuntimeSettings({ query } as unknown as pg.Pool, config());
    await settings.load();
    expect(await settings.readDrainTimeoutMs()).toBe(600000);
  });

  it('bounds a stalled database read to one second and falls back to the last validated snapshot', async () => {
    vi.useFakeTimers();
    const query = vi.fn().mockResolvedValueOnce(row({ [DRAIN_TIMEOUT_KEY]: 1200000 }))
      .mockImplementationOnce(() => new Promise(() => undefined));
    const settings = new RuntimeSettings({ query } as unknown as pg.Pool, config());
    await settings.load();
    const reading = settings.readDrainTimeoutMs(); let finished = false;
    void reading.then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(999); expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await reading).toBe(1200000);
  });

  it('does not replace a newer validated snapshot with an older configuration read completing late', async () => {
    let finishOld!: (value: ReturnType<typeof row>) => void;
    const newest = row({ [DRAIN_TIMEOUT_KEY]: 900000 }); newest.rows[0]!.revision = 2;
    const query = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValueOnce(newest);
    const base = config(), pool = { query } as unknown as pg.Pool;
    const first = new RuntimeSettings(pool, base), second = new RuntimeSettings(pool, base);
    const oldRead = first.readDrainTimeoutMs();
    await second.load(); finishOld(row({ [DRAIN_TIMEOUT_KEY]: 600000 }));
    expect(await oldRead).toBe(900000); expect(first.drainTimeoutSnapshotMs()).toBe(900000);
  });
});
