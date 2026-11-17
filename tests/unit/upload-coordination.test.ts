import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { expect, it, vi } from 'vitest';
import { withUploadLock } from '../../src/modules/storage/upload-session.js';

function fixture(acquired = true) {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn().mockResolvedValue({ rows: [{ acquired }] }),
    release: vi.fn(),
  });
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { client, pool };
}

it('handles a checked-out PG connection failure during OSS I/O without an unhandled error or successful result', async () => {
  const { client, pool } = fixture();
  await expect(withUploadLock(pool, 'file', async () => {
    client.emit('error', new Error('connection lost'));
    await Promise.resolve();
    return 'OSS may have finished';
  })).rejects.toMatchObject({ code: 'UPLOAD_COORDINATION_UNAVAILABLE' });
  expect(client.release).toHaveBeenCalledWith(true);
  expect(client.query).toHaveBeenCalledTimes(1);
  expect(client.listenerCount('error')).toBe(0);
});

it('discards a connection if the session lock could not be released', async () => {
  const { client, pool } = fixture();
  client.query.mockResolvedValueOnce({ rows: [{ acquired: true }] }).mockRejectedValueOnce(new Error('unlock failed'));
  await expect(withUploadLock(pool, 'file', async () => 'done')).resolves.toBe('done');
  expect(client.release).toHaveBeenCalledWith(true);
});

it('fails fast when another process owns the file lock and never invokes storage work', async () => {
  const { client, pool } = fixture(false), work = vi.fn();
  await expect(withUploadLock(pool, 'file', work)).rejects.toMatchObject({ code: 'UPLOAD_BUSY' });
  expect(work).not.toHaveBeenCalled();
  expect(client.release).toHaveBeenCalledWith(false);
});
