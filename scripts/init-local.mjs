import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { lstatSync, realpathSync, writeFileSync } from 'node:fs';

const envFile = '.env';
const project = 'huahuo-server-local';

// Only initialize a new project. PostgreSQL won't apply fresh credentials to an existing volume.
if (realpathSync(process.cwd()) !== realpathSync(new URL('..', import.meta.url))) throw new Error('SERVER_ROOT_REQUIRED');
if (lstatSync(envFile, { throwIfNoEntry: false })) throw new Error('ENV_ALREADY_EXISTS');

const docker = args => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const endpoint = docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
const hostOverride = process.env.DOCKER_CONTEXT ? undefined : process.env.DOCKER_HOST;
if (!endpoint.startsWith('unix://') || (hostOverride && !hostOverride.startsWith('unix://'))) {
  throw new Error('LOCAL_DOCKER_REQUIRED');
}
const volumes = docker(['volume', 'ls', '--format', '{{.Name}}']);
const containers = docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
if (volumes.split('\n').some(name => name.startsWith(`${project}_`)) || containers) {
  throw new Error('PROJECT_RESOURCES_EXIST_NO_PASSWORD_RESET');
}

const randomSecret = () => randomBytes(32).toString('hex');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const env = {
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_PROFILES: 'local-db',
  APP_ENV: 'development',
  REDIS_IMAGE: 'redis:7.4.8-bookworm',
  BACKEND_IMAGE: 'huahuo-server:isolated-local',
  REDIS_CACHE_URL: 'redis://redis:6379/0',
  REDIS_QUEUE_URL: 'redis://redis:6379/1',
  REDIS_KEY_PREFIX: 'huahuo-local',
  API_BIND_HOST: '127.0.0.1',
  API_HOST_PORT: '3000',
  API_TRUST_PROXY_HOPS: '0',
  ADMIN_BIND_HOST: '127.0.0.1',
  ADMIN_HOST_PORT: '3001',
  ADMIN_TRUST_PROXY_HOPS: '0',
  APP_PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
  ADMIN_PUBLIC_BASE_URL: 'http://127.0.0.1:3001',
  API_SERVICE_BASE_URL: 'http://api-server:3000',
  APP_TOKEN_SECRET: randomSecret(),
  ADMIN_SESSION_SECRET: randomSecret(),
  APP_JWT_KEY_ID: 'server-local',
  APP_JWT_PRIVATE_KEY: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
  APP_JWT_PUBLIC_KEY: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64'),
  USER_AGREEMENT_VERSION: '2026-08-20',
  PRIVACY_POLICY_VERSION: '2026-08-20',
  STORAGE_DRIVER: 'local',
  PROCESSING_NODES_ENABLED: 'false',
  PROCESSING_NODES_CLOUD_CONTROL_ENABLED: 'false',
  RAG_PROVIDER_MODE: 'disabled',
  RAG_RERANK_PROVIDER: 'disabled',
  SMS_FEISHU_WEBHOOK_URL: '',
};
for (const role of ['bootstrap', 'migrator', 'api', 'admin', 'worker', 'scheduler']) {
  const password = randomSecret();
  env[`POSTGRES_${role.toUpperCase()}_PASSWORD`] = password;
  if (role === 'bootstrap') continue;
  const key = role === 'migrator' ? 'MIGRATION' : role.toUpperCase();
  env[`DATABASE_${key}_URL`] = `postgresql://huahuo_${role}:${password}@postgres:5432/huahuo`;
}

writeFileSync(envFile, Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join(''), { flag: 'wx', mode: 0o600 });
console.log('Created .env (0600). Set SMS_FEISHU_WEBHOOK_URL privately before starting the API.');
