import type pg from 'pg';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { config } from '../helpers.js';
import { BillingService } from '../../src/modules/billing/service.js';
import { WorkspaceService } from '../../src/modules/workspaces/service.js';
import { StorageService } from '../../src/modules/storage/service.js';
import { mockOssUploadConfig } from '../support/oss-upload.js';

const scope = { userId: '11111111-1111-4111-8111-111111111111', sessionId: 'session', traceId: 'trace' };
const workspaceId = '22222222-2222-4222-8222-222222222222';
function database(activeUser: boolean) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    // A session can have been checked before an account changes status. The
    // direct business admission lock must still reject a missing active user.
    if (sql.includes('FROM user_sessions')) return { rows: [{ id: scope.sessionId }], rowCount: 1 };
    if (sql.includes('FROM users')) { const found=activeUser&&params[0]===scope.userId;return { rows: found ? [sql.includes('storage_used_bytes') ? { storage_used_bytes: '0', storage_reserved_bytes: '0' } : { displayName: 'User', updatedAt: new Date('2026-11-05T00:00:00Z'), avatarResourceId: null }] : [], rowCount: found ? 1 : 0 }; }
    if (sql.includes('FROM workspaces')) return { rows: [{ id: workspaceId }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const client = Object.assign(new EventEmitter(), { query, release: vi.fn() });
  return { query, client: client as unknown as pg.PoolClient, pool: { connect: async () => client } as unknown as pg.Pool };
}

describe('business admission uses the active canonical user', () => {
  it('rejects billing admission before creating balances for an unavailable active user', async () => {
    const db = database(false), service = new BillingService(db.pool, config());
    await expect(service.ensureAccountTx(db.client, scope.userId)).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
    expect(db.query).toHaveBeenCalledTimes(1);
  });
  it('allows an active user past admission while keeping policy validation independent', async () => {
    const db = database(true), service = new BillingService(db.pool, config());
    await expect(service.ensureAccountTx(db.client, scope.userId)).rejects.toMatchObject({ code: 'BILLING_POLICY_UNAVAILABLE' });
    expect(db.query.mock.calls[0]?.[1]).toEqual([scope.userId]);
  });
  it('rejects workspace mutations when the account is no longer active', async () => {
    const db = database(false), service = new WorkspaceService(db.pool, 'test-secret');
    await expect(service.create(scope, { displayName: 'blocked', setAsDefault: false }, 'key')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO workspaces'))).toBe(false);
  });
  it('reads display and avatar data from the canonical user, and handles an unavailable user explicitly', async () => {
    const db = database(true), service = new WorkspaceService(db.pool, 'test-secret');
    await expect(service.getProfile(scope)).resolves.toEqual({ profile: { displayName: 'User', updatedAt: '2026-11-05T00:00:00.000Z', avatarResourceId: null } });
    const unavailable = database(false);
    await expect(new WorkspaceService(unavailable.pool, 'test-secret').getProfile(scope)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('rejects upload admission before initializing OSS when the active account is unavailable', async () => {
    const db = database(false), storage = { put: vi.fn(), stat: vi.fn(), read: vi.fn(), remove: vi.fn(), head: vi.fn(),
      beginUpload: vi.fn(), signUploadPart: vi.fn(), inspectUploadPart: vi.fn(), completeUpload: vi.fn(), abortUpload: vi.fn() };
    const service = new StorageService(db.pool, mockOssUploadConfig(config()), storage);
    await expect(service.createUpload(scope, { workspaceId, fileName: 'source.txt', mimeType: 'text/plain', sizeBytes: 13n },'fixture-upload')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO storage_reservations') || sql.startsWith('INSERT INTO resources'))).toBe(false);
    expect(storage.beginUpload).not.toHaveBeenCalled();
    expect(storage.signUploadPart).not.toHaveBeenCalled();
  });
});
