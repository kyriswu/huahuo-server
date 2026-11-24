import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { getLocalPostgresTarget, isLoopback } from './addresses.mjs';

const roles = new Map([
  ['api', { entry: 'api-server', key: 'API', port: '3000', poolSize: '10' }],
  ['admin', { entry: 'admin', key: 'ADMIN', port: '3001', poolSize: '5' }],
  ['worker', { entry: 'worker', key: 'WORKER', port: '3100', poolSize: '10' }],
  ['scheduler', { entry: 'scheduler', key: 'SCHEDULER', port: '3101', poolSize: '3' }],
]);

const [name = 'api', envFile = '.env.host', ...extra] = process.argv.slice(2);
const role = roles.get(name);
if (!role || extra.length) {
  console.error('Usage: pnpm dev:local [api|admin|worker|scheduler] [env-file]');
  process.exit(2);
}

let settings;
try {
  settings = parseEnv(readFileSync(envFile, 'utf8'));
} catch (error) {
  console.error(`Cannot read local configuration ${envFile} (${error.code ?? error.name}).`);
  process.exit(1);
}

const appEnv = settings.APP_ENV || 'development';
if (!['development', 'test'].includes(appEnv)) {
  console.error('Use a development or isolated test configuration with dev:local.');
  process.exit(1);
}

const databaseKey = `DATABASE_${role.key}_URL`;
let database;
try {
  database = getLocalPostgresTarget(settings[databaseKey]?.trim() || (name === 'api' ? settings.DATABASE_URL : undefined));
} catch {
  const keys = name === 'api' ? `${databaseKey} or DATABASE_URL` : databaseKey;
  console.error(`Set ${keys} to a local PostgreSQL URL in ${envFile}.`);
  process.exit(1);
}

for (const key of ['REDIS_CACHE_URL', 'REDIS_QUEUE_URL']) {
  try {
    const url = new URL(settings[key]);
    if (!['redis:', 'rediss:'].includes(url.protocol) || !isLoopback(url.hostname) || url.search || url.hash) {
      throw new Error('LOCAL_REDIS_URL_REQUIRED');
    }
  } catch {
    console.error(`Set ${key} to a local Redis URL in ${envFile}.`);
    process.exit(1);
  }
}

const port = settings[`${role.key}_HOST_PORT`] || (name === 'api' ? settings.PORT : undefined) || role.port;
// Application settings come from the selected file. Keep only inherited OS settings.
const systemKeys = new Set(['HOME', 'LANG', 'LC_ALL', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'TZ', 'USERPROFILE']);
for (const key of Object.keys(process.env)) {
  if (!systemKeys.has(key)) delete process.env[key];
}
Object.assign(process.env, settings, {
  APP_ENV: appEnv,
  SERVICE_ROLE: role.entry,
  DATABASE_URL: database.url.href,
  DATABASE_POOL_MAX: settings[`DATABASE_POOL_MAX_${role.key}`] || settings.DATABASE_POOL_MAX || role.poolSize,
  HOST: '127.0.0.1',
  PORT: port,
  METRICS_HOST: '127.0.0.1',
  REDIS_KEY_PREFIX: settings.REDIS_KEY_PREFIX || 'huahuo-host-dev',
  PROCESSING_NODES_ENABLED: settings.PROCESSING_NODES_ENABLED || 'false',
  PROCESSING_NODES_CLOUD_CONTROL_ENABLED: settings.PROCESSING_NODES_CLOUD_CONTROL_ENABLED || 'false',
});

await import(new URL(`../../src/entrypoints/${role.entry}.ts`, import.meta.url).href);
