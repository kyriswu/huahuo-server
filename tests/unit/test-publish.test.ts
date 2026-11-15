import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Dependency-free release CLI.
import { publishTest } from '../../scripts/release/test-publish.mjs';
const repo = 'kyriswu/huahuo-server', control = 'a'.repeat(40), head = 'b'.repeat(40), old = 'c'.repeat(40), merged = 'd'.repeat(40);
function fixture(files = ['src/example.ts']) {
  const candidate = { state: 'open', merged: false, draft: false, changed_files: files.length, head: { sha: head, ref: 'feature', repo: { full_name: repo } }, base: { sha: old, ref: 'test', repo: { full_name: repo } }, merge_commit_sha: merged };
  let testHead = old, mainHead = control, latestCi = 'success', responseLost = false, mergeLost = false, release = 'success';
  let activeRelease = false, wrongRun = false;
  let saved: Record<string, unknown> | null = null;
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    calls.push({ method, path, body });
    if (path === '/pulls/1/merge') {
      expect(body).toEqual({ sha: candidate.head.sha, merge_method: 'merge' });
      candidate.merged = true; candidate.state = 'closed'; testHead = merged;
      if (mergeLost) throw Error('synthetic-private-response');
      return { merged: true, sha: merged };
    }
    if (path === '/pulls/1') return structuredClone(candidate);
    if (path.startsWith('/pulls/1/files?')) return files.map(filename => ({ filename }));
    if (path.startsWith('/git/ref/heads/')) {
      const branch = path.endsWith('main') ? 'main' : 'test';
      return { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: branch === 'main' ? mainHead : testHead } };
    }
    if (path.startsWith('/actions/workflows/release-smoke-check.yml/runs?')) {
      const query = new URL('https://fixture.invalid' + path).searchParams;
      const event = query.get('event');
      return { workflow_runs: [{ id: 2, head_sha: query.get('head_sha'), event, head_branch: event === 'push' ? 'test' : candidate.head.ref, path: '.github/workflows/release-smoke-check.yml', head_repository: { full_name: repo }, status: 'completed', conclusion: latestCi }] };
    }
    if (path.includes('/test-server-release.yml/runs?')) return { workflow_runs: activeRelease ? [{ status: 'in_progress' }] : [] };
    if (path.endsWith('/test-server-release.yml/dispatches')) {
      expect(body).toEqual({ ref: 'main' });
      if (responseLost) throw Error('synthetic-private-response');
      return { workflow_run_id: 42 };
    }
    if (path === '/actions/runs/42') return { id: 42, path: wrongRun ? '.github/workflows/other.yml' : '.github/workflows/test-server-release.yml', event: 'workflow_dispatch', head_sha: control, head_branch: 'main', head_repository: { full_name: repo }, status: 'completed', conclusion: release };
    throw Error('unexpected fixture route');
  };
  const run = () => publishTest({ pr: 1, request, state: saved, save: async (value: Record<string, unknown>) => { saved = structuredClone(value); }, pause: async () => { throw Error('unexpected wait'); } });
  return { run, calls, candidate, state: () => saved, setCi: (value: string) => { latestCi = value; }, setMain: (value: string) => { mainHead = value; }, setTest: (value: string) => { testHead = value; }, loseDispatch: () => { responseLost = true; }, loseMerge: () => { mergeLost = true; }, releaseFails: () => { release = 'failure'; }, activeRelease: () => { activeRelease = true; }, wrongRun: () => { wrongRun = true; } };
}
describe('test publication orchestration (local GitHub API fixtures; no real token/cloud)', () => {
  it('refuses a concurrent CLI invocation before making any network request', () => {
    const root = mkdtempSync(join(tmpdir(), 'huahuo-test-publish-lock-'));
    try {
      mkdirSync(join(root, '.local/test-publish'), { recursive: true });
      writeFileSync(join(root, '.local/test-publish/pr-1.json.lock'), 'fixture-lock');
      const child = spawnSync(process.execPath, [resolve('scripts/release/test-publish.mjs'), '--pr', '1', '--resume'], {
        cwd: root, env: { ...process.env, GH_TOKEN: 'synthetic-fixture-token' }, encoding: 'utf8', timeout: 3000,
      });
      expect(child.status).toBe(1);
      expect(JSON.parse(child.stderr)).toEqual({ status: 'failed', code: 'TEST_PUBLISH_LOCAL_LOCKED' });
      expect(child.stderr).not.toContain('synthetic-fixture-token');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('locks the PR head, merges test, waits its push CI and follows exactly one main dispatch', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toMatchObject({ phase: 'complete', mergedSha: merged, controlSha: control, runId: 42, deployment: 'passed' });
    expect(f.calls.filter(call => call.method !== 'GET').map(call => call.method)).toEqual(['PUT', 'POST']);
  });
  it('syncs documentation without rebuilding/deploying application containers', async () => {
    const f = fixture(['docs/runbooks/example.md']);
    await expect(f.run()).resolves.toMatchObject({ deployment: 'not-needed' });
    expect(f.calls.some(call => call.method === 'POST')).toBe(false);
  });
  it.each(['main', 'release/other'])('refuses a PR targeting %s without mutations', async branch => {
    const f = fixture(); f.candidate.base.ref = branch;
    await expect(f.run()).rejects.toThrow('TEST_PUBLISH_TARGET_REFUSED');
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('refuses release-skill edits unless synchronizing the owner-protected main head', async () => {
    const f = fixture(['.agents/skills/huahuo-release/SKILL.md']);
    await expect(f.run()).rejects.toThrow('TEST_PUBLISH_PROTECTED_CHANGE_REQUIRES_MAIN_SYNC');
    expect(f.calls.some(call => call.method === 'PUT')).toBe(false);
    f.candidate.head.ref = 'main'; f.candidate.head.sha = control;
    await expect(f.run()).resolves.toMatchObject({ deployment: 'not-needed' });
  });
  it('does not require owner review for a different newly added skill', async () => {
    await expect(fixture(['.agents/skills/another-skill/SKILL.md']).run()).resolves.toMatchObject({ deployment: 'not-needed' });
  });
  it('blocks failed CI before merging', async () => {
    const f = fixture(); f.setCi('failure');
    await expect(f.run()).rejects.toThrow('TEST_PUBLISH_CI_FAILED');
    expect(f.calls.some(call => call.method === 'PUT')).toBe(false);
  });
  it('recovers a lost merge response by reading the PR without merging twice', async () => {
    const f = fixture(); f.loseMerge(); await expect(f.run()).rejects.toThrow();
    expect(f.state()?.phase).toBe('merging');
    await expect(f.run()).resolves.toMatchObject({ deployment: 'passed' });
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  });
  it('never redispatches after an ambiguous dispatch response', async () => {
    const f = fixture(); f.loseDispatch(); await expect(f.run()).rejects.toThrow();
    expect(f.state()?.phase).toBe('dispatching');
    await expect(f.run()).rejects.toThrow('TEST_PUBLISH_DISPATCH_UNCONFIRMED');
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });
  it('blocks a moved main before dispatch', async () => {
    const f = fixture(); f.loseMerge(); await expect(f.run()).rejects.toThrow(); f.setMain('e'.repeat(40));
    await expect(f.run()).rejects.toThrow('TEST_PUBLISH_SOURCE_MOVED');
    expect(f.calls.some(call => call.method === 'POST')).toBe(false);
  });
  it('keeps an unsuccessful release as a failure, with its exact run ID preserved', async () => {
    const f = fixture(); f.releaseFails();
    await expect(f.run()).rejects.toThrow('TEST_PUBLISH_RELEASE_FAILED');
    expect(f.state()?.runId).toBe(42); expect(f.state()?.phase).toBe('dispatched');
  });
  it('refuses another active deployment instead of queuing a duplicate', async () => {
    const f = fixture(); f.activeRelease();
    await expect(f.run()).rejects.toThrow('TEST_PUBLISH_RELEASE_ALREADY_RUNNING');
    expect(f.calls.some(call => call.method === 'POST')).toBe(false);
  });
  it('does not accept an unrelated workflow run as the release result', async () => {
    const f = fixture(); f.wrongRun();
    await expect(f.run()).rejects.toThrow('TEST_PUBLISH_RUN_INVALID');
  });
  it('skips application deployment for an owner-reviewed main sync containing only this orchestration tool', async () => {
    const f = fixture(['scripts/release/test-publish.mjs', 'tests/unit/test-publish.test.ts']);
    f.candidate.head.ref = 'main'; f.candidate.head.sha = control;
    await expect(f.run()).resolves.toMatchObject({ deployment: 'not-needed' });
    expect(f.calls.some(call => call.method === 'POST')).toBe(false);
  });
  it('does not extend the no-deployment exception to arbitrary scripts', async () => {
    const f = fixture(['scripts/release/other.mjs']); f.candidate.head.ref = 'main'; f.candidate.head.sha = control;
    await expect(f.run()).resolves.toMatchObject({ deployment: 'passed' });
  });
  it('blocks incomplete changed-file results rather than classifying them as docs-only', async () => {
    const f = fixture(['docs/example.md']); f.candidate.changed_files = 101;
    await expect(f.run()).rejects.toThrow('TEST_PUBLISH_FILES_INCOMPLETE');
  });
});
