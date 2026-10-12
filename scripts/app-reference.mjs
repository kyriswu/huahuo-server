import { realpathSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export function resolveRoots(start, appPath = '../huahuo-app', realpath = realpathSync) {
  let server = realpath(start);
  if (!server.endsWith('/huahuo-server')) server = realpath(resolve(server, 'huahuo-server'));
  const app = realpath(resolve(server, appPath));
  const nested = (a, b) => { const r = relative(a, b); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
  if (nested(server, app) || nested(app, server)) throw new Error('UNSAFE_APP_SERVER_PATHS');
  return { server, app };
}
function git(app, args) {
  return execFileSync('git', ['--no-optional-locks', '-C', app, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
export function snapshot(start, config, files) {
  if (config.readOnly === false || config.checkRemoteAtStageStart === true) throw new Error('READ_ONLY_LOCAL_REFERENCE_REQUIRED');
  const { server, app } = resolveRoots(start, config.localPath);
  let source = { mode: 'SOURCE_COPY_NO_GIT', head: null, branch: null, status: '' };
  try {
    if (realpathSync(git(app, ['rev-parse', '--show-toplevel'])) === app) {
      source = { mode: 'GIT', head: git(app, ['rev-parse', 'HEAD']), branch: git(app, ['branch', '--show-current']), status: git(app, ['status', '--porcelain=v1']) };
    }
  } catch { /* Source copies do not require Git. */ }
  const hashes = {};
  for (const file of files) {
    const path = realpathSync(resolve(app, file));
    if (!path.startsWith(app + '/')) throw new Error('REFERENCE_FILE_ESCAPES_APP');
    hashes[file] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  return { recordedAt: new Date().toISOString(), repoUrl: config.repoUrl, localPath: relative(server, app), ...source, hashes };
}
export function compare(previous, current) {
  return { headChanged: previous.head !== current.head, statusChanged: previous.status !== current.status,
    changedFiles: Object.keys({ ...previous.hashes, ...current.hashes }).filter(f => previous.hashes[f] !== current.hashes[f]) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const configPath = resolve(root, 'config/app-reference.local.json');
    const config = JSON.parse(readFileSync(existsSync(configPath) ? configPath : resolve(root, 'config/app-reference.example.json'), 'utf8'));
    const files = JSON.parse(readFileSync(resolve(root, 'config/app-reference-files.json'), 'utf8'));
    const current = snapshot(root, config, files);
    const baseline = resolve(root, 'docs/app-reference.local.json');
    if (process.argv.includes('--diff')) {
      const diff = compare(JSON.parse(readFileSync(baseline, 'utf8')), current);
      console.log(JSON.stringify(diff, null, 2));
      if (diff.headChanged || diff.statusChanged || diff.changedFiles.length) process.exitCode = 1;
    } else {
      mkdirSync(resolve(root, 'docs'), { recursive: true });
      writeFileSync(baseline, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
      console.log(JSON.stringify(current, null, 2));
    }
  } catch (error) { console.error('APP_REFERENCE_FAILED:', error.code ?? error.message); process.exitCode = 1; }
}
