import type pg from 'pg';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { afterCommit, DomainError, transaction } from '../../src/modules/identity/store.js';

function fixture() {
  const query = vi.fn(async (sql: string) => { void sql; return { rows: [], rowCount: 0 }; }), release = vi.fn();
  const client = Object.assign(new EventEmitter(), { query, release }) as unknown as pg.PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
  return { query, release, client, pool };
}

describe('post-commit temporary upload cleanup', () => {
  it('runs cleanup only after a successful database commit', async () => {
    const f = fixture(), cleanup = vi.fn(async () => {
      expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT']);
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(() => afterCommit(f.client, async () => {})).toThrow('TRANSACTION_REQUIRED');
    });
    await expect(transaction(f.pool, async tx => { afterCommit(tx, cleanup); expect(cleanup).not.toHaveBeenCalled(); return 'saved'; }))
      .resolves.toBe('saved');
    expect(cleanup).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
    expect(() => afterCommit(f.client, cleanup)).toThrow('TRANSACTION_REQUIRED');
  });
  it('does not consume the Redis receipt when the business transaction rolls back', async () => {
    const f = fixture(), cleanup = vi.fn(async () => {});
    await expect(transaction(f.pool, async tx => { afterCommit(tx, cleanup); throw new Error('BUSINESS_FAILED'); }))
      .rejects.toThrow('BUSINESS_FAILED');
    expect(cleanup).not.toHaveBeenCalled();
    expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    await transaction(f.pool, async () => undefined);
    expect(cleanup).not.toHaveBeenCalled();
  });
  it('keeps a committed business result successful if Redis cleanup fails', async () => {
    const f = fixture();
    await expect(transaction(f.pool, async tx => { afterCommit(tx, async () => { throw new Error('REDIS_OFFLINE'); }); return { saved: true }; }))
      .resolves.toEqual({ saved: true });
    expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT']);
  });
  it('does not forget the receipt when commit itself fails', async () => {
    const f = fixture(), cleanup = vi.fn(async () => {});
    f.query.mockImplementation(async sql => { if (sql === 'COMMIT') throw new Error('COMMIT_FAILED'); return { rows: [], rowCount: 0 }; });
    await expect(transaction(f.pool, async tx => { afterCommit(tx, cleanup); })).rejects.toThrow('COMMIT_FAILED');
    expect(cleanup).not.toHaveBeenCalled();
    expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
  });
  it('discards a connection lost while awaiting Redis without attempting rollback on a broken socket', async () => {
    const f = fixture(), cleanup = vi.fn(async () => {}), lost = new Error('CONNECTION_LOST');
    await expect(transaction(f.pool, async tx => {
      afterCommit(tx, cleanup);
      await Promise.resolve();
      tx.emit('error', lost);
      return 'must not commit';
    })).rejects.toBe(lost);
    expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN']);
    expect(f.release).toHaveBeenCalledWith(true);
    expect(f.client.listenerCount('error')).toBe(0); expect(cleanup).not.toHaveBeenCalled();
  });
  it('preserves the business error when its connection is also lost', async () => {
    const f = fixture(), business = new Error('BUSINESS_FAILED');
    await expect(transaction(f.pool, async tx => { tx.emit('error', new Error('CONNECTION_LOST')); throw business; })).rejects.toBe(business);
    expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN']);
    expect(f.release).toHaveBeenCalledWith(true);
  });
  it('releases the connection before cleanup for explicitly committed domain errors too', async () => {
    const f = fixture(), error = new DomainError(429, 'RATE_LIMITED', true), cleanup = vi.fn(async () => { expect(f.release).toHaveBeenCalledTimes(1); });
    await expect(transaction(f.pool, async tx => { afterCommit(tx,cleanup); throw error; })).rejects.toBe(error);
    expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN','COMMIT']); expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
