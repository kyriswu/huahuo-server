import pg from 'pg';
import { Redis } from 'ioredis';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { schemaMigrations } from '../db/schema.js';
import type { AppConfig } from '../config/config.js';
export interface DependencyHealth { postgres: boolean; schema: boolean; redisCache: boolean; redisQueue: boolean; }
export interface Dependencies { pool?: pg.Pool; check(): Promise<DependencyHealth>; close(): Promise<void>; }
export const isReady = (h: DependencyHealth) => Object.values(h).every(Boolean);
export function poolFor(config: AppConfig) {
  return new pg.Pool({ connectionString: config.databaseUrl, ssl: config.ssl, max: config.poolMax,
    connectionTimeoutMillis: 2000, statement_timeout: config.statementTimeout, query_timeout: config.statementTimeout + 500,
    application_name: `huahuo-${config.role}` });
}
export function createDependencies(config: AppConfig): Dependencies {
  const pool = poolFor(config);
  // Errors are converted to dependency status; never log URL-bearing driver errors.
  pool.on('error', () => undefined);
  const db = drizzle(pool);
  const redis = (url: string) => {
    const client = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false,
      connectTimeout: 1500, commandTimeout: 2000, retryStrategy: times => Math.min(times * 200, 2000) });
    client.on('error', () => undefined);
    return client;
  };
  const cache = redis(config.redisCacheUrl), queue = redis(config.redisQueueUrl);
  let pending: Promise<DependencyHealth> | undefined;
  return {
    pool,
    check() {
      // Coalesce probes to avoid opening many simultaneous pool queries during outages.
      pending ??= (async () => {
        const [pgResult, schemaResult, cacheResult, queueResult] = await Promise.allSettled([
          pool.query('SELECT 1'),
          db.select({ version: sql<number>`coalesce(max(${schemaMigrations.version}), 0)::int` }).from(schemaMigrations),
          cache.ping(), queue.ping(),
        ]);
        return { postgres: pgResult.status === 'fulfilled',
          schema: schemaResult.status === 'fulfilled' && (schemaResult.value[0]?.version ?? 0) >= config.schemaMinVersion,
          redisCache: cacheResult.status === 'fulfilled' && cacheResult.value === 'PONG',
          redisQueue: queueResult.status === 'fulfilled' && queueResult.value === 'PONG' };
      })().finally(() => { pending = undefined; });
      return pending;
    },
    async close() { cache.disconnect(); queue.disconnect(); await pool.end(); },
  };
}
