import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const steps = [];

function run(name, check) {
  const started = Date.now();
  check();
  steps.push({ name, exitCode: 0, durationMs: Date.now() - started });
}

function composeTemplate(file) {
  // Check the tracked template without inheriting shell overrides or reading .env.
  const env = Object.fromEntries(['HOME', 'PATH', 'DOCKER_CONFIG', 'SYSTEMROOT', 'USERPROFILE']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const rendered = execFileSync('docker', [
    'compose', '-f', 'compose.yaml', '--env-file', file, 'config', '--format', 'json',
  ], { cwd: root, env, encoding: 'utf8' });
  return JSON.parse(rendered).services;
}

for (const command of ['typecheck', 'lint', 'build', 'test', 'test:integration']) {
  run(`pnpm ${command}`, () => execFileSync('pnpm', [command], { cwd: root, stdio: 'inherit' }));
}
run('local compose config', () => {
  if (!composeTemplate('.env.compose.local.example').postgres) throw new Error('LOCAL_MODE_POSTGRES_MISSING');
});
run('cloud compose config', () => {
  const services = composeTemplate('.env.compose.cloud.example');
  if (services.postgres) throw new Error('CLOUD_MODE_HAS_LOCAL_POSTGRES');
  if (Object.values(services).some(service => service.depends_on?.postgres)) throw new Error('CLOUD_MODE_DEPENDS_ON_POSTGRES');
});
writeFileSync(new URL('../docs/verification.local.json', import.meta.url),
  JSON.stringify({ recordedAt: new Date().toISOString(), steps }, null, 2) + '\n');
console.log('Verification passed with isolated PostgreSQL and Redis integration tests.');
