import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readReleasePlan } from '../release/plan.js';
import { loadConfig } from '../config/config.js';
import { createDependencies, poolFor } from '../plugins/dependencies.js';
import { migrate, preflightMigrations } from '../db/migrate.js';
import { verifyReleaseDatabase } from '../release/gates.js';

// Called only by the owned ephemeral PG/Redis runner, before the business suite.
// This exercises the deployed SQL -> candidate SQL path; it does not claim to
// exercise an old application binary or reproduce production data distributions.
const execute = promisify(execFile);
let directory: string | undefined;
try {
  const url = new URL(process.env.TEST_DATABASE_MIGRATION_URL ?? '');
  if (url.hostname !== '127.0.0.1' || !/^\/huahuo_test_[a-f0-9]{32}$/.test(url.pathname)
    || process.env.APP_ENV !== 'test') throw new Error('RELEASE_REHEARSAL_ISOLATED_DATABASE_REQUIRED');
  const plan = await readReleasePlan();
  const config = loadConfig('migrate', { DATABASE_URL: url.href, APP_ENV: 'test' });
  const pool = poolFor(config);
  try {
    const tables = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'");
    if (tables.rows[0]?.count !== 0) throw new Error('RELEASE_REHEARSAL_EMPTY_DATABASE_REQUIRED');
  } finally { await pool.end(); }
  directory = await mkdtemp(join(tmpdir(), 'huahuo-release-baseline-'));
  const listing = await execute('git', ['ls-tree', '-r', '--name-only', plan.baseRevision, '--', 'migrations'], { timeout: 10000 });
  for (const path of listing.stdout.trim().split('\n')) {
    if (!/^migrations\/[0-9]{4}_[a-z0-9_]+\.sql$/.test(path)) throw new Error('RELEASE_REHEARSAL_BASE_INVALID');
    const blob = await execute('git', ['show', `${plan.baseRevision}:${path}`], { timeout: 10000, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' });
    await writeFile(join(directory, path.slice('migrations/'.length)), blob.stdout, { flag: 'wx' });
  }
  const base = await migrate(config, directory);
  const before = await preflightMigrations(config);
  const expected = plan.database.migrations.map(file => Number(file.slice(0, 4))).sort((a, b) => a - b);
  if (JSON.stringify(before.pending) !== JSON.stringify(expected)) throw new Error('RELEASE_REHEARSAL_PLAN_MISMATCH');
  const upgraded = await migrate(config);
  await verifyReleaseDatabase(config, plan);
  const repeated = await migrate(config);
  if (repeated.applied.length) throw new Error('RELEASE_REHEARSAL_NOT_IDEMPOTENT');
  for (const role of ['API', 'ADMIN', 'WORKER', 'SCHEDULER'] as const) {
    const roleUrl = new URL(process.env[`TEST_DATABASE_${role}_URL`] ?? '');
    if (roleUrl.hostname !== url.hostname || roleUrl.port !== url.port || roleUrl.pathname !== url.pathname) throw new Error('RELEASE_REHEARSAL_TARGET_MISMATCH');
    await verifyReleaseDatabase({ ...config, databaseUrl: roleUrl.href }, plan);
  }
  const dependencies = createDependencies({ ...config, role: 'worker',
    databaseUrl: process.env.TEST_DATABASE_WORKER_URL!, redisCacheUrl: process.env.REDIS_CACHE_URL!, redisQueueUrl: process.env.REDIS_QUEUE_URL! }, directory);
  try {
    if (!(await dependencies.check()).schema) throw new Error('RELEASE_REHEARSAL_OLD_SCHEMA_NOT_READY');
  } finally { await dependencies.close(); }
  console.log(JSON.stringify({ status: 'passed', stage: 'isolated-upgrade', baseVersion: base.current,
    candidateVersion: upgraded.current, applied: upgraded.applied, replayApplied: repeated.applied }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error instanceof Error && /^(?:RELEASE_|MIGRATION_|DATABASE_)[A-Z_]+$/.test(error.message)
    ? error.message : 'RELEASE_REHEARSAL_FAILED' }));
  process.exitCode = 1;
} finally { if (directory) await rm(directory, { recursive: true, force: true }); }
