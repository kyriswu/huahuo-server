import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { loadConfig } from '../../src/config/config.ts';
import { migrate, MigrationExecutionError, preflightMigrations } from '../../src/db/migrate.ts';
import { getLocalPostgresTarget } from './addresses.mjs';

function readDevelopmentEnv(file, missingCode) {
  let settings;
  try {
    settings = parseEnv(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(missingCode);
  }
  if ((settings.APP_ENV ?? 'development') !== 'development') {
    throw new Error('LOCAL_DATABASE_REQUIRES_DEVELOPMENT');
  }
  return settings;
}

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('LOCAL_DATABASE_USAGE');
  }
  const runtime = readDevelopmentEnv('.env.host', 'LOCAL_DATABASE_ENV_UNREADABLE');
  const migration = readDevelopmentEnv('.env.host.migrate', 'LOCAL_MIGRATION_ENV_UNREADABLE');
  const api = getLocalPostgresTarget(runtime.DATABASE_API_URL?.trim() || runtime.DATABASE_URL);
  const target = getLocalPostgresTarget(migration.DATABASE_URL);
  const { hostname, port, username } = target.url;
  if (hostname !== api.url.hostname || port !== api.url.port || target.database !== api.database) {
    throw new Error('LOCAL_DATABASE_TARGET_MISMATCH');
  }
  if (username !== 'huahuo_migrator') {
    throw new Error('LOCAL_DATABASE_REQUIRES_MIGRATOR');
  }

  // Only the explicit local configuration is passed to the application config loader.
  const config = loadConfig('migrate', { ...migration, DATABASE_URL: target.url.href });
  const endpoint = { host: hostname, port: Number(port), database: target.database };
  const checkOnly = args[0] === '--check';
  const result = checkOnly ? await preflightMigrations(config) : await migrate(config);
  console.log(JSON.stringify({ status: 'complete', mode: checkOnly ? 'check' : 'apply', endpoint, ...result }));
} catch (error) {
  const code = error instanceof Error && /^(?:LOCAL_|INVALID_CONFIG:|MIGRATION_|DATABASE_)[A-Z0-9_:]+$/u.test(error.message)
    ? error.message : 'LOCAL_DATABASE_SYNC_FAILED';
  console.error(JSON.stringify({ status: 'failed', code,
    ...(error instanceof MigrationExecutionError ? { failedVersion: error.failedVersion, applied: error.applied } : {}) }));
  process.exitCode = 1;
}
