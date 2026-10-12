import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { AppConfig } from '../config/config.js';
import { poolFor } from '../plugins/dependencies.js';
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function migrate(config: AppConfig, directory = resolve('migrations')) {
  const pool = poolFor(config); pool.on('error', () => undefined);
  const deadline = Date.now() + config.connectDeadlineMs;
  try {
    while (true) {
      try { await pool.query('SELECT 1'); break; }
      catch { if (Date.now() >= deadline) throw new Error('DATABASE_CONNECT_DEADLINE'); await pause(500); }
    }
    const client = await pool.connect();
    let locked = false;
    try {
      const lockDeadline = Date.now() + config.migrationLockTimeoutMs;
      while (!locked) {
        const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(72701, 1) AS locked');
        locked = result.rows[0]?.locked === true;
        if (!locked) { if (Date.now() >= lockDeadline) throw new Error('MIGRATION_LOCK_TIMEOUT'); await pause(100); }
      }
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = (await readdir(directory)).filter(f => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
      const applied: number[] = [];
      for (const name of files) {
        const version = Number(name.slice(0, 4));
        const content = await readFile(resolve(directory, name), 'utf8');
        const checksum = createHash('sha256').update(content).digest('hex');
        const existing = await client.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE version=$1', [version]);
        if (existing.rows[0]) {
          if (existing.rows[0].checksum !== checksum) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(content);
          await client.query('INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)', [version, checksum]);
          await client.query('COMMIT'); applied.push(version);
        } catch { await client.query('ROLLBACK'); throw new Error('MIGRATION_SQL_FAILED'); }
      }
      return { applied, current: files.length ? Number(files.at(-1)?.slice(0, 4)) : 0 };
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock(72701, 1)');
      client.release();
    }
  } finally { await pool.end(); }
}
