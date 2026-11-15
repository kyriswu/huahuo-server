import { readReleasePlan } from '../release/plan.js';
import { checkReleaseConfiguration, checkReleaseExternal, checkReleaseHistory, checkReleaseRuntime, verifyReleaseDatabase } from '../release/gates.js';
import type { Role } from '../config/config.js';

const mode = process.argv[2];
try {
  if (process.argv.length !== 3 || !['config', 'db-preflight', 'db-verify', 'runtime', 'external'].includes(mode ?? '')) throw new Error('RELEASE_GATE_INVALID');
  const role = process.env.SERVICE_ROLE as Role;
  if (!['api-server', 'admin', 'worker', 'scheduler', 'migrate'].includes(role)) throw new Error('RELEASE_ROLE_INVALID');
  const plan = await readReleasePlan();
  const config = checkReleaseConfiguration(plan, role);
  let result: unknown = {};
  if (mode === 'db-preflight') {
    if (role !== 'migrate') throw new Error('RELEASE_MIGRATOR_REQUIRED');
    result = await checkReleaseHistory(config, plan);
  } else if (mode === 'db-verify') result = await verifyReleaseDatabase(config, plan);
  else if (mode === 'runtime') result = await checkReleaseRuntime(config);
  else if (mode === 'external') {
    if (role !== 'api-server') throw new Error('RELEASE_API_ROLE_REQUIRED');
    result = await checkReleaseExternal(plan);
  }
  console.log(JSON.stringify({ status: 'passed', stage: mode, role, result }));
} catch (error) {
  const code = error instanceof Error && /^(?:RELEASE_|MIGRATION_|DATABASE_|INVALID_CONFIG:)[A-Z0-9_:]+$/.test(error.message) ? error.message : 'RELEASE_GATE_FAILED';
  console.error(JSON.stringify({ status: 'failed', code })); process.exitCode = 1;
}
