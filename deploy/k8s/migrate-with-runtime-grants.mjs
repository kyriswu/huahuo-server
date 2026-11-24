import { loadConfig } from './dist/config/config.js';
import { migrate, MigrationExecutionError } from './dist/db/migrate.js';
import { poolFor } from './dist/plugins/dependencies.js';

const runtimeGrants = "__HUAHUO_RUNTIME_GRANTS_SQL__";

try {
  const config = loadConfig('migrate');
  const login = decodeURIComponent(new URL(config.databaseUrl).username);
  if (config.appEnv !== 'test' || login !== 'huahuo_migrator') {
    throw new Error('RELEASE_MIGRATION_ACCOUNT_INVALID');
  }

  const result = await migrate(config);
  const pool = poolFor(config);
  try {
    await pool.query(runtimeGrants);
  } catch {
    throw new Error('RELEASE_RUNTIME_GRANTS_FAILED');
  } finally {
    await pool.end();
  }
  console.log(JSON.stringify({ service: 'migrate', ...result, status: 'complete' }));
} catch (error) {
  const code = error instanceof Error && /^[A-Z_:]+$/.test(error.message)
    ? error.message : 'MIGRATION_FAILED';
  console.error(JSON.stringify({
    service: 'migrate',
    code,
    ...(error instanceof MigrationExecutionError
      ? { failedVersion: error.failedVersion, applied: error.applied }
      : {}),
  }));
  process.exitCode = 1;
}
