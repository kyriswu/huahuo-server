import { loadConfig } from '../config/config.js';
import { migrate } from '../db/migrate.js';
try {
  const result = await migrate(loadConfig('migrate'));
  console.log(JSON.stringify({ service: 'migrate', ...result, status: 'complete' }));
} catch (error) {
  const code = error instanceof Error && /^[A-Z_:]+$/.test(error.message) ? error.message : 'MIGRATION_FAILED';
  console.error(JSON.stringify({ service: 'migrate', code })); process.exitCode = 1;
}
