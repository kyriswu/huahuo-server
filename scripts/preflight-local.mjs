import { resolveRoots } from './app-reference.mjs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
try {
  resolveRoots(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  console.log('Server/App paths: separate, readable; App reference ../huahuo-app');
  console.log(`Host Node: ${process.version}; runtime requires Node 24`);
  if (!process.argv.includes('--skip-docker')) {
    execFileSync('bash', ['scripts/ensure-docker-local.sh'], { stdio: 'inherit', timeout: 20000 });
    console.log(execFileSync('docker',['compose','version'],{encoding:'utf8'}).trim());
  }
} catch { console.error('PREFLIGHT_FAILED: inspect directory or local Docker permissions'); process.exitCode=1; }
