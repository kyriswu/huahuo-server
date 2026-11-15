import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Separate ephemeral dependencies; never read .env or touch the business stack.
// Pins match the project's existing PostgreSQL/Redis images. No implicit pull.
const PG_IMAGE = 'postgres:17.9-bookworm';
const REDIS_IMAGE = 'redis:7.4.8-bookworm';
const MILVUS_IMAGE = 'milvusdb/milvus:v2.6.26';
const withMilvus = process.argv.includes('--milvus');
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const runId = randomBytes(16).toString('hex');
const database = `huahuo_test_${runId}`;
const resources = [];
let tempDirectory;
let child;
let interrupted = false;

class IntegrationError extends Error {
  constructor(code) { super(code); this.name = 'IntegrationError'; }
}
function docker(args, code = 'TEST_DOCKER_COMMAND_FAILED') {
  try { return execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new IntegrationError(code); }
}
function checkInterrupted() { if (interrupted) throw new IntegrationError('TEST_INTERRUPTED'); }
function inspectOwned(resource) {
  const value = JSON.parse(docker(['inspect', resource.id], 'TEST_RESOURCE_INSPECT_FAILED'))[0];
  if (value?.Id !== resource.id || value?.Config?.Labels?.['huahuo.test.run'] !== runId || value?.Config?.Labels?.['huahuo.test.owner'] !== root || value?.Config?.Labels?.['huahuo.test.purpose'] !== 'integration') throw new IntegrationError('TEST_RESOURCE_OWNERSHIP_MISMATCH');
  if (value.Mounts.some(mount => mount.Type === 'volume')) throw new IntegrationError('TEST_PERSISTENT_VOLUME_FORBIDDEN');
  return value;
}
function create(kind, args) {
  checkInterrupted();
  const id = docker(['create', '--pull=never', '--name', `huahuo-test-${kind}-${runId}`, '--label', `huahuo.test.run=${runId}`, '--label', `huahuo.test.owner=${root}`, '--label', 'huahuo.test.purpose=integration', ...args], 'TEST_CONTAINER_CREATE_FAILED');
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new IntegrationError('TEST_CONTAINER_ID_INVALID');
  const resource = { id, kind };
  // Capture the immutable ID before start so failed starts are also cleaned up.
  resources.push(resource);
  inspectOwned(resource);
  docker(['start', id], 'TEST_CONTAINER_START_FAILED');
  return resource;
}
function boundPort(resource, containerPort) {
  const bindings = inspectOwned(resource).NetworkSettings.Ports?.[`${containerPort}/tcp`];
  const port = Number(bindings?.[0]?.HostPort);
  if (bindings?.length !== 1 || bindings[0].HostIp !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) throw new IntegrationError('TEST_LOOPBACK_PORT_REQUIRED');
  return port;
}
function signalHandler() { interrupted = true; child?.kill('SIGTERM'); }
process.once('SIGINT', signalHandler);
process.once('SIGTERM', signalHandler);

try {
  if (realpathSync(process.cwd()) !== root) throw new IntegrationError('SERVER_ROOT_REQUIRED');
  const endpoint = docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], 'LOCAL_DOCKER_REQUIRED');
  if (!endpoint.startsWith('unix://') || (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://'))) throw new IntegrationError('LOCAL_DOCKER_REQUIRED');
  docker(['image', 'inspect', PG_IMAGE, REDIS_IMAGE, ...(withMilvus ? [MILVUS_IMAGE] : [])], 'TEST_LOCAL_IMAGES_REQUIRED');
  tempDirectory = mkdtempSync(join(tmpdir(), 'huahuo-integration-'));
  const credentialsPath = join(tempDirectory, 'postgres.env');
  const variables = { POSTGRES_USER: 'huahuo_bootstrap', POSTGRES_DB: database, POSTGRES_INITDB_ARGS: '--auth-host=scram-sha-256' };
  for (const role of ['BOOTSTRAP', 'MIGRATOR', 'API', 'ADMIN', 'WORKER', 'SCHEDULER']) variables[`POSTGRES_${role === 'BOOTSTRAP' ? '' : `${role}_`}PASSWORD`] = randomBytes(32).toString('hex');
  writeFileSync(credentialsPath, Object.entries(variables).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600, flag: 'wx' });

  const postgres = create('postgres', ['--tmpfs', '/var/lib/postgresql/data:rw', '--env-file', credentialsPath, '--mount', `type=bind,src=${join(root, 'infra/postgres/init')},dst=/docker-entrypoint-initdb.d,readonly`, '-p', '127.0.0.1::5432', PG_IMAGE]);
  const redis = create('redis', ['--tmpfs', '/data:rw', '-p', '127.0.0.1::6379', REDIS_IMAGE, 'redis-server', '--save', '', '--appendonly', 'no']);
  const milvus = withMilvus ? create('milvus', ['--tmpfs', '/var/lib/milvus:rw', '-e', 'ETCD_USE_EMBED=true',
    '-e', 'ETCD_DATA_DIR=/var/lib/milvus/etcd', '-e', 'COMMON_STORAGETYPE=local', '-e', 'DEPLOY_MODE=STANDALONE',
    '-p', '127.0.0.1::19530', '-p', '127.0.0.1::9091', MILVUS_IMAGE, 'milvus', 'run', 'standalone']) : undefined;
  const pgPort = boundPort(postgres, 5432), redisPort = boundPort(redis, 6379);
  // Allow only process-launch essentials. Inherited DB/model/service credentials,
  // NODE_OPTIONS preloads and dotenv settings cannot reach the test subprocess.
  const testEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'CI', 'VOLTA_HOME', 'VOLTA_FEATURE_PNPM']) if (process.env[key] !== undefined) testEnv[key] = process.env[key];
  Object.assign(testEnv, { APP_ENV: 'test', DATABASE_SSL_MODE: 'disable', PROVIDER_MODE: 'disabled', RAG_PROVIDER_MODE: 'disabled', RAG_RERANK_PROVIDER: 'disabled', SMS_PROVIDER: 'disabled', ALLOW_MOCK_PROVIDERS: 'false', LOG_LEVEL: 'silent', REDIS_CACHE_URL: `redis://127.0.0.1:${redisPort}/14`, REDIS_QUEUE_URL: `redis://127.0.0.1:${redisPort}/15` });
  for (const role of ['MIGRATOR', 'API', 'ADMIN', 'WORKER', 'SCHEDULER']) testEnv[`TEST_DATABASE_${role === 'MIGRATOR' ? 'MIGRATION' : role}_URL`] = `postgresql://huahuo_${role.toLowerCase()}:${variables[`POSTGRES_${role}_PASSWORD`]}@127.0.0.1:${pgPort}/${database}`;
  if (milvus) testEnv.TEST_MILVUS_ADDRESS = `127.0.0.1:${boundPort(milvus, 19530)}`;
  const milvusHealthUrl = milvus ? `http://127.0.0.1:${boundPort(milvus, 9091)}/healthz` : undefined;

  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    checkInterrupted();
    const client = new pg.Client({ connectionString: testEnv.TEST_DATABASE_MIGRATION_URL, connectionTimeoutMillis: 500, query_timeout: 1000 });
    try {
      await client.connect(); await client.query('SELECT 1');
      const milvusReady = !milvusHealthUrl || (await fetch(milvusHealthUrl, { signal: AbortSignal.timeout(1500) })).ok;
      if (milvusReady && docker(['exec', redis.id, 'redis-cli', 'PING'], 'TEST_REDIS_NOT_READY') === 'PONG') { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    finally { await client.end().catch(() => undefined); }
  }
  if (!ready) throw new IntegrationError('TEST_DEPENDENCIES_NOT_READY');
  checkInterrupted();
  console.log(`Ephemeral PostgreSQL/Redis${milvus ? '/Milvus' : ''} ready on loopback; no business database, volume or live provider configuration used.`);
  const exit = await new Promise((resolve, reject) => {
    child = spawn('pnpm', ['test:integration:inner', '--maxWorkers=1', '--no-file-parallelism'], { cwd: root, env: testEnv, stdio: 'inherit' });
    child.once('error', () => reject(new IntegrationError('TEST_PROCESS_START_FAILED')));
    child.once('exit', code => resolve(code));
  });
  checkInterrupted();
  if (exit !== 0) throw new IntegrationError('INTEGRATION_TESTS_FAILED');
  console.log(`Real isolated PostgreSQL/Redis${milvus ? '/Milvus' : ''} integration suite passed.`);
} catch (error) {
  console.error(JSON.stringify({ code: error instanceof IntegrationError ? error.message : 'INTEGRATION_RUNNER_FAILED' }));
  process.exitCode = interrupted ? 130 : 1;
} finally {
  let cleanupFailed = false;
  for (const resource of resources.reverse()) {
    try {
      inspectOwned(resource);
      docker(['rm', '--force', resource.id], 'TEST_CONTAINER_CLEANUP_FAILED');
    } catch { cleanupFailed = true; }
  }
  if (tempDirectory) {
    try { unlinkSync(join(tempDirectory, 'postgres.env')); rmdirSync(tempDirectory); }
    catch { cleanupFailed = true; }
  }
  process.removeListener('SIGINT', signalHandler);
  process.removeListener('SIGTERM', signalHandler);
  if (cleanupFailed) { console.error(JSON.stringify({ code: 'TEST_CLEANUP_INCOMPLETE' })); process.exitCode ||= 1; }
  else if (resources.length) console.log('Removed only this run\'s owned temporary containers and credentials; no volumes were deleted.');
}
