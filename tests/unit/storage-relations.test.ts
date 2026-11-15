import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { Attempt } from '../../src/modules/tasks/engine.js';
import type { StoragePort } from '../../src/modules/storage/port.js';
import { attachResource } from '../../src/modules/storage/references.js';
import { storageJob, StorageJobs } from '../../src/modules/storage/jobs.js';

function attempt(): Attempt {
  const now = new Date();
  return { owner: 'worker', version: 1, attempt: 1, task: {
    id: 'task', user_id: 'user', workspace_id: 'workspace', kind: 'storage.delete', queue: 'maintenance', input_id: null,
    state: 'running', version: 1, attempt_no: 1, resume_count: 0, max_attempts: 3, lease_owner: 'worker', reservation_id: null,
    lease_until: new Date(now.getTime() + 15_000), external_state: 'none', result_id: null, error_code: null,
    retryable: false, event_sequence: 0, created_at: now, updated_at: now,
  } };
}

describe('storage relationship guards without database foreign keys', () => {
  it('does not create a relationship when the resource is absent', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(attachResource({ query } as unknown as pg.PoolClient, 'user', 'resource', 'note', 'note', 'workspace'))
      .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('rejects resources outside the requested workspace before inserting a reference', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ workspace_id: 'foreign', mime_type: 'text/plain' }], rowCount: 1 });
    await expect(attachResource({ query } as unknown as pg.PoolClient, 'user', 'resource', 'note', 'note', 'workspace'))
      .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('does not create a durable task when its scoped storage target is missing', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(storageJob({ query } as unknown as pg.PoolClient, 'user', 'workspace', 'delete', 'missing'))
      .rejects.toThrow('STORAGE_TARGET_NOT_FOUND');
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each([
    { user_id: 'foreign', workspace_id: 'workspace' },
    { user_id: 'user', workspace_id: 'foreign' },
  ])('does not access object storage when the task and target have different ownership: %j', async ownership => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ operation: 'delete', resource_id: 'resource' }] })
      .mockResolvedValueOnce({ rows: [{ ...ownership, status: 'deleting', object_key: 'resource' }] });
    const storage: StoragePort = {
      put: vi.fn().mockRejectedValue(new Error('UNEXPECTED_STORAGE_ACCESS')),
      stat: vi.fn().mockRejectedValue(new Error('UNEXPECTED_STORAGE_ACCESS')),
      read: vi.fn().mockRejectedValue(new Error('UNEXPECTED_STORAGE_ACCESS')),
      remove: vi.fn().mockRejectedValue(new Error('UNEXPECTED_STORAGE_ACCESS')),
    };
    await expect(new StorageJobs({ query } as unknown as pg.Pool, storage).execute(attempt())).rejects.toThrow('STORAGE_TARGET_NOT_FOUND');
    expect(storage.stat).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });
});
