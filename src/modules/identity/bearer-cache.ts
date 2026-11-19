import type { Redis } from 'ioredis';
import type { Scope } from './store.js';

const lifetimeMs = 15_000;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;

type Admission = Pick<Scope, 'userId' | 'sessionId'>;

export class BearerCache {
  private readonly prefix: string;

  constructor(private readonly redis: Redis, namespace: string, keyId: string, private readonly onError: () => void) {
    this.prefix = `${namespace}:auth:bearer:v1:${keyId}:`;
  }

  async read(hash: string): Promise<Admission | undefined> {
    try {
      const value = await this.redis.get(this.prefix + hash);
      if (!value || value === '!') return;
      const record = JSON.parse(value) as Partial<Admission & { expiresAt: number }> | null;
      if (typeof record?.userId === 'string' && uuid.test(record.userId) &&
          typeof record.sessionId === 'string' && uuid.test(record.sessionId) &&
          typeof record.expiresAt === 'number' && Number.isSafeInteger(record.expiresAt) && record.expiresAt > Date.now()) {
        return { userId: record.userId, sessionId: record.sessionId };
      }
    } catch {
      this.onError();
    }
  }

  async remember(hash: string, admission: Admission, checkedAt: number, expiresAt: number): Promise<void> {
    expiresAt = Math.min(checkedAt + lifetimeMs, expiresAt);
    if (expiresAt <= Date.now()) return;
    try {
      // The absolute deadline starts before the SQL read, including if it stalls.
      // NX lets a concurrent invalidation keep a stale read out of Redis.
      await this.redis.set(this.prefix + hash, JSON.stringify({ ...admission, expiresAt }), 'PXAT', expiresAt, 'NX');
    } catch {
      this.onError();
    }
  }

  async invalidate(hashes: readonly string[]): Promise<void> {
    for (let offset = 0; offset < hashes.length; offset += 128) {
      const batch = this.redis.pipeline();
      for (const hash of hashes.slice(offset, offset + 128)) {
        if (digest.test(hash)) batch.set(this.prefix + hash, '!', 'PX', lifetimeMs);
      }
      try {
        const results = await batch.exec();
        if (!results || results.some(([error]) => Boolean(error))) this.onError();
      } catch {
        this.onError();
        return;
      }
    }
  }
}
