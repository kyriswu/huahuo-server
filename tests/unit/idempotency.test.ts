import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { idempotent } from '../../src/lib/idempotency.js';
import { DomainError } from '../../src/modules/identity/store.js';

const secret = 'idempotency-test-secret'.repeat(3);
interface Entry { request_hash: string; response_cipher: string; valid: boolean; }
function fixture() {
  const entries = new Map<string, Entry>();
  const writes: unknown[][] = [];
  const locks: unknown[][] = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    const key = JSON.stringify(values.slice(0, 3));
    if (sql.startsWith('SELECT pg_advisory')) { locks.push(values); return { rows: [], rowCount: 1 }; }
    if (sql.startsWith('SELECT request_hash')) {
      const entry = entries.get(key);
      return { rows: entry ? [entry] : [], rowCount: entry ? 1 : 0 };
    }
    if (sql.startsWith('INSERT INTO api_idempotency')) {
      entries.set(key, { request_hash: String(values[3]), response_cipher: String(values[4]), valid: true });
      writes.push(values);
      return { rows: [], rowCount: 1 };
    }
    throw new Error('UNEXPECTED_QUERY');
  });
  return { tx: { query } as unknown as pg.PoolClient, query, entries, writes, locks };
}

describe('shared transactional API idempotency', () => {
  it('replays encrypted results with equivalent canonical input and one bounded TTL', async () => {
    const f = fixture(), effect = vi.fn(async () => ({ privateResult: 'confidential-body' }));
    const initial = await idempotent(f.tx, secret, 'user:workspace', 'task.create', 'key', { b: 2, a: 1 }, effect);
    const replay = await idempotent(f.tx, secret, 'user:workspace', 'task.create', 'key', { a: 1, b: 2 }, effect);
    expect(replay).toEqual(initial);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]![4]).not.toContain('confidential-body');
    expect(f.writes[0]![5]).toBe(86400);
    expect(f.locks).toHaveLength(2);
  });

  it('rejects conflicting or expired keys before executing another mutation', async () => {
    const f = fixture(), effect = vi.fn(async () => ({ id: 'task' }));
    await idempotent(f.tx, secret, 'user', 'task.create', 'key', { text: 'first' }, effect);
    const conflict = idempotent(f.tx, secret, 'user', 'task.create', 'key', { text: 'changed' }, effect);
    await expect(conflict).rejects.toBeInstanceOf(DomainError);
    await expect(conflict).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' });
    f.entries.values().next().value!.valid = false;
    await expect(idempotent(f.tx, secret, 'user', 'task.create', 'key', { text: 'first' }, effect)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_EXPIRED' });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('isolates callers and operations, and uses unambiguous lock identities', async () => {
    const f = fixture();
    const input = { id: 'same-id' };
    for (const [scope, operation] of [['user', 'task.create'], ['admin', 'task.create'], ['user', 'task.cancel']] as const) {
      await idempotent(f.tx, secret, scope, operation, 'same-key', input, async () => ({ scope, operation }));
    }
    expect(f.entries.size).toBe(3);
    expect(new Set(f.locks.map(values => values[0])).size).toBe(3);
    await idempotent(f.tx, secret, 'a:b', 'c', 'd', input, async () => ({}));
    await idempotent(f.tx, secret, 'a', 'b:c', 'd', input, async () => ({}));
    expect(f.locks.at(-1)).not.toEqual(f.locks.at(-2));
  });

  it('does not persist failures; a later retry can execute successfully', async () => {
    const f = fixture();
    await expect(idempotent(f.tx, secret, 'user', 'task.create', 'key', {}, async () => { throw new Error('FAILED_EFFECT'); })).rejects.toThrow('FAILED_EFFECT');
    expect(f.writes).toHaveLength(0);
    await expect(idempotent(f.tx, secret, 'user', 'task.create', 'key', {}, async () => ({ ok: true }))).resolves.toEqual({ ok: true });
  });

  it('fails closed for missing encryption configuration, invalid TTL and wrong decryption key', async () => {
    const f = fixture(), effect = vi.fn(async () => ({}));
    await expect(idempotent(f.tx, '', 'user', 'op', 'key', {}, effect)).rejects.toThrow('IDEMPOTENCY_SECRET_REQUIRED');
    for (const ttl of [0, -1, 1.5]) await expect(idempotent(f.tx, secret, 'user', 'op', 'key', {}, effect, ttl)).rejects.toThrow('IDEMPOTENCY_TTL_INVALID');
    expect(effect).not.toHaveBeenCalled();
    await idempotent(f.tx, secret, 'user', 'op', 'key', {}, effect);
    await expect(idempotent(f.tx, 'different-encryption-key'.repeat(3), 'user', 'op', 'key', {}, effect)).rejects.toThrow();
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('leaves optional-key calls outside the replay store', async () => {
    const f = fixture(), effect = vi.fn(async () => ({ ok: true }));
    expect(await idempotent(f.tx, secret, 'user', 'op', undefined, {}, effect)).toEqual({ ok: true });
    expect(f.query).not.toHaveBeenCalled();
  });
});
