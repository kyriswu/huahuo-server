#!/usr/bin/env node
/** Read-only host preflight; no npm dependencies, no clone, no Docker starts/writes. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
let serverInput = null;
let appInput = null;
let skipDocker = false;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--help') {
    console.log('Usage: node preflight-local.mjs [--server-dir PATH] [--app-dir PATH] [--skip-docker]');
    console.log('Run from Code or huahuo-server. --app-dir is relative to Server root. No files are written.');
    process.exit(0);
  } else if (arg === '--skip-docker') skipDocker = true;
  else if (arg === '--server-dir' || arg === '--app-dir') {
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail(`Missing value for ${arg}`);
    if (arg === '--server-dir') serverInput = argv[++i];
    else appInput = argv[++i];
  } else fail(`Unknown argument: ${arg}`);
}
function fail(message) {
  console.error(JSON.stringify({ status: 'BLOCKED', message, writesPerformed: false }));
  process.exit(2);
}
function exec(command, args, timeout = 12000) {
  const r = spawnSync(command, args, {
    encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  return { ok: r.status === 0 && !r.error, code: r.status, error: r.error?.code || null,
    text: (r.stdout || '').trim() };
}
function safeDir(p) {
  try {
    const real = fs.realpathSync(p);
    if (!fs.statSync(real).isDirectory()) fail(`Not a directory: ${p}`);
    fs.accessSync(real, fs.constants.R_OK);
    return real;
  } catch { fail(`Cannot read directory: ${p}`); }
}
function nested(a, b) {
  const rel = path.relative(a, b);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
function safeRemote(s) {
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.hostname}${u.pathname}`; // no userinfo, query, fragment
  } catch {
    const m = /^[^@\s]+@([^:\s]+):([^\s]+)$/.exec(s);
    return m ? `ssh://${m[1]}/${m[2]}` : (s ? 'NON_URL_REMOTE_REDACTED' : null);
  }
}
function gitInfo(dir) {
  const base = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', dir];
  const top = exec('git', [...base, 'rev-parse', '--show-toplevel']);
  if (!top.ok) return { status: top.error === 'ENOENT' ? 'GIT_CLI_UNAVAILABLE' : 'SOURCE_COPY_NO_GIT', head: null };
  let root;
  try { root = fs.realpathSync(top.text); } catch { return { status: 'GIT_ROOT_UNRESOLVED', head: null }; }
  if (root !== dir) return { status: 'PARENT_GIT_ROOT_NOT_THIS_DIRECTORY', head: null };
  const head = exec('git', [...base, 'rev-parse', '--verify', 'HEAD']);
  const branch = exec('git', [...base, 'symbolic-ref', '--short', '-q', 'HEAD']);
  const state = exec('git', [...base, 'status', '--porcelain=v1', '--untracked-files=normal']);
  const remote = exec('git', [...base, 'remote', 'get-url', 'origin']);
  return {
    status: head.ok ? 'GIT_CHECKOUT' : 'GIT_WITHOUT_COMMIT',
    head: head.ok ? head.text : null,
    branch: branch.ok ? branch.text : null,
    dirty: state.ok ? Boolean(state.text) : null,
    changedEntries: state.ok ? (state.text ? state.text.split('\n').length : 0) : null,
    origin: safeRemote(remote.ok ? remote.text : ''),
  };
}
const cwd = fs.realpathSync(process.cwd());
if (!serverInput) {
  if (path.basename(cwd) === 'huahuo-server') serverInput = cwd;
  else if (fs.existsSync(path.join(cwd, 'huahuo-server')) && fs.existsSync(path.join(cwd, 'huahuo-app'))) {
    serverInput = path.join(cwd, 'huahuo-server');
  } else fail('Run from Code or huahuo-server, or supply --server-dir. Nothing has been created.');
}
const serverLexical = path.resolve(cwd, serverInput);
const server = safeDir(serverLexical);
if (path.basename(server) !== 'huahuo-server') fail('Resolved Server is not huahuo-server; confirm unexpected symlink/path before writing.');
const app = safeDir(path.resolve(server, appInput || '../huahuo-app'));
if (nested(server, app) || nested(app, server)) fail('App and Server must be distinct non-nested directories.');
const entries = fs.readdirSync(server).sort();
const observedFiles = [];
for (const rel of [
  'Flutter/src/pubspec.yaml',
  'Flutter/src/lib/app/navigation/app_route_paths.dart',
  'Flutter/packages/huahuo_api/lib/src/api/endpoint_catalog.dart',
  'Flutter/packages/huahuo_api/lib/src/api/api_envelope.dart',
]) {
  try {
    const absolute = fs.realpathSync(path.join(app, rel));
    if (!nested(app, absolute)) continue;
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) continue;
    observedFiles.push({ path: rel, bytes: stat.size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') });
  } catch { /* Path is only a hint; later code-reading may discover a replacement. */ }
}
const result = {
  schemaVersion: 1,
  kind: 'HOST_READ_ONLY_PREFLIGHT',
  checkedAt: new Date().toISOString(),
  writesPerformed: false,
  networkCloneOrPull: false,
  environment: { platform: os.platform(), architecture: os.arch(), node: process.version },
  server: { absolutePath: server, empty: entries.length === 0, topLevelEntryCount: entries.length,
    topLevelEntries: entries.slice(0, 60), git: gitInfo(server) },
  app: { absolutePath: app, relativeToServer: path.relative(server, app),
    sourceUrl: 'https://github.com/kyriswu/huahuo-app', readOnlyIntent: true,
    git: gitInfo(app), observedFiles },
  docker: { checked: !skipDocker },
  warnings: [],
};
if (!result.server.empty) result.warnings.push('SERVER_NOT_EMPTY: preserve existing files, including hidden files.');
if (result.server.git.status === 'PARENT_GIT_ROOT_NOT_THIS_DIRECTORY') result.warnings.push('Confirm independent Server repository before Git writes; do not initialize Code.');
if (result.app.git.status === 'SOURCE_COPY_NO_GIT') result.warnings.push('NO_GIT does not block reading local App; record hashes instead of inventing a commit.');
if (!observedFiles.length) result.warnings.push('Expected App hint paths absent; discover real source layout, not proof that functionality is missing.');
let exitCode = 0;
if (!skipDocker) {
  const cli = exec('docker', ['--version']);
  const compose = exec('docker', ['compose', 'version', '--short']);
  const ctx = exec('docker', ['context', 'show']);
  const endpoint = ctx.ok ? exec('docker', ['context', 'inspect', ctx.text, '--format', '{{(index .Endpoints "docker").Host}}']) : { ok: false, text: '' };
  const effective = process.env.DOCKER_CONTEXT ? endpoint.text : (process.env.DOCKER_HOST || endpoint.text);
  const local = effective.startsWith('unix://');
  result.docker = { checked: true, cli: cli.ok ? cli.text : null, compose: compose.ok ? compose.text : null,
    context: ctx.ok ? ctx.text : null, endpointKind: local ? 'LOCAL_UNIX_SOCKET' : 'REMOTE_OR_UNRESOLVED',
    daemonChecked: false, ready: false };
  if (cli.ok && compose.ok && local) {
    const info = exec('docker', ['info', '--format', '{{json .}}'], 15000);
    result.docker.daemonChecked = true;
    if (info.ok) {
      try {
        const parsed = JSON.parse(info.text);
        result.docker.ready = true;
        result.docker.serverVersion = parsed.ServerVersion ?? null;
        result.docker.architecture = parsed.Architecture ?? null;
        result.docker.cpus = parsed.NCPU ?? null;
        result.docker.memoryBytes = parsed.MemTotal ?? null;
      } catch { result.warnings.push('Docker daemon output could not be verified.'); }
    }
  } else result.warnings.push('Docker missing, remote, or inaccessible: no daemon or container actions attempted.');
  if (!result.docker.ready) { exitCode = 3; result.warnings.push('Docker is not confirmed ready; this script will NOT start it.'); }
}
console.log(JSON.stringify(result, null, 2));
process.exitCode = exitCode;
