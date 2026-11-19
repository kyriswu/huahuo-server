import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const runner = `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('policy',sys.argv[1])
policy=importlib.util.module_from_spec(spec);spec.loader.exec_module(policy)
request=json.load(sys.stdin)
args=request['args']
if request['function']=='require_unchanged_state': args=[value.encode() for value in args]
try:
 result=getattr(policy,request['function'])(*args)
 print(json.dumps({'ok':True,'result':result}))
except policy.ReleasePolicyError as error:
 print(json.dumps({'ok':False,'code':str(error)}))
`;
function check(name: string, ...args: unknown[]) {
  return JSON.parse(execFileSync('python3', ['-B', '-c', runner, resolve('scripts/release/deployment-policy.py')], {
    input: JSON.stringify({ function: name, args }), encoding: 'utf8', timeout: 5000,
  }));
}
let repository: string, a: string, b: string, c: string, fork: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(text: string) {
  writeFileSync(join(repository, 'fixture'), text); git('add', 'fixture'); git('commit', '-qm', text); return git('rev-parse', 'HEAD');
}
beforeAll(() => {
  repository = mkdtempSync(join(tmpdir(), 'huahuo-release-order-'));
  git('init', '--quiet'); git('config', 'user.name', 'Release fixture'); git('config', 'user.email', 'fixture@example.invalid');
  a = commit('A'); b = commit('B'); c = commit('C');
  git('checkout', '--quiet', '--detach', b); fork = commit('other history');
});
afterAll(() => rmSync(repository, { recursive: true, force: true }));

describe('lightweight deployment order and reuse, real isolated Git and no cloud', () => {
  it('allows retrying a newer candidate while the environment is still at its base', () => {
    expect(check('require_forward', repository, a, b)).toEqual({ ok: true, result: 'deploy' });
    expect(check('require_forward', repository, a, c)).toEqual({ ok: true, result: 'deploy' });
  });
  it('refuses B after C has already succeeded, including repeated requests', () => {
    for (let i = 0; i < 2; i++) expect(check('require_forward', repository, c, b)).toEqual({ ok: false, code: 'RELEASE_NOT_FORWARD' });
  });
  it('requires same-SHA requests to verify the running result', () => {
    expect(check('require_forward', repository, c, c)).toEqual({ ok: true, result: 'verify-current' });
  });
  it('fails closed for changed history or missing objects without adding a rollback bypass', () => {
    expect(check('require_forward', repository, c, fork)).toMatchObject({ ok: false, code: 'RELEASE_NOT_FORWARD' });
    expect(check('require_forward', repository, c, 'f'.repeat(40))).toMatchObject({ ok: false, code: 'RELEASE_HISTORY_UNAVAILABLE' });
    expect(check('require_forward', repository, c, '--help')).toMatchObject({ ok: false, code: 'RELEASE_REVISION_INVALID' });
  });
  it('rejects a base record that changes during build or before switching containers', () => {
    const base = JSON.stringify({ sha: a, status: 'passed' });
    expect(check('require_unchanged_state', base, base)).toMatchObject({ ok: true });
    expect(check('require_unchanged_state', base, JSON.stringify({ sha: c, status: 'passed' }))).toMatchObject({ ok: false, code: 'RELEASE_STATE_CHANGED' });
  });
  const image = 'sha256:' + '1'.repeat(64), values = { SERVICE_ROLE: 'worker', FIXTURE_KEY: 'fixture-private-value' };
  it('accepts reuse only when the actual image and full environment match the successful snapshot', () => {
    expect(check('require_same_runtime', image, image, values, { ...values })).toMatchObject({ ok: true });
  });
  const roles = ['worker', 'scheduler', 'api-server', 'admin'];
  it.each(Array.from({ length: 15 }, (_, i) => ({ selected: roles.filter((_role, bit) => ((i + 1) & (1 << bit)) !== 0) })))('updates only explicitly selected roles ($selected)', ({ selected }) => {
    expect(check('selected_roles', [...selected].reverse(), roles)).toEqual({ ok: true, result: selected });
  });
  it.each([[], ['admin', 'admin'], ['redis'], ['foreign-service']].map(services => ({ services })))('refuses invalid role selections ($services)', ({ services }) => {
    expect(check('selected_roles', services, roles)).toMatchObject({ ok: false, code: 'RELEASE_SERVICES_INVALID' });
  });
  it('requires explicit per-role successful images for full and partial deployments', () => {
    const old = { image: 'huahuo-server:' + 'a'.repeat(40), imageId: image };
    const baseline = Object.fromEntries(roles.map(role => [role, { ...old }]));
    expect(check('successful_images', old, roles)).toMatchObject({ ok: false, code: 'RELEASE_IMAGE_RECORD_INVALID' });
    expect(check('successful_images', { roleImages: baseline }, roles)).toEqual({ ok: true, result: baseline });
    const partial = { ...baseline, admin: { image: 'huahuo-server:' + 'b'.repeat(40), imageId: 'sha256:' + '2'.repeat(64) } };
    expect(check('successful_images', { roleImages: partial }, roles)).toEqual({ ok: true, result: partial });
    expect(check('successful_images', { roleImages: { admin: partial.admin } }, roles)).toMatchObject({ ok: false, code: 'RELEASE_IMAGE_RECORD_INVALID' });
  });
  it.each([
    ['another role image', 'sha256:' + '2'.repeat(64), values, 'RELEASE_RUNNING_IMAGE_MISMATCH'],
    ['changed secret', image, { ...values, FIXTURE_KEY: 'different-private-value' }, 'RELEASE_RUNNING_CONFIGURATION_MISMATCH'],
    ['missing configuration', image, { SERVICE_ROLE: 'worker' }, 'RELEASE_RUNNING_CONFIGURATION_MISMATCH'],
    ['extra configuration', image, { ...values, UNREVIEWED_OVERRIDE: 'true' }, 'RELEASE_RUNNING_CONFIGURATION_MISMATCH'],
  ])('does not call %s an already-completed deployment', (_name, actualImage, actualEnv, code) => {
    const result = check('require_same_runtime', image, actualImage, values, actualEnv);
    expect(result).toEqual({ ok: false, code });
    expect(JSON.stringify(result)).not.toMatch(/fixture-private|different-private/);
  });
});
