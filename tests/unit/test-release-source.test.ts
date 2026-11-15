import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
// @ts-expect-error Release tooling deliberately uses dependency-free JavaScript.
import { resolveTestReleaseRevision, selectTestReleaseRevision, verifyTestReleaseOidcClaims } from '../../scripts/release/test-release-source.mjs';

const controlSha = 'a'.repeat(40), targetSha = controlSha, movedSha = 'c'.repeat(40);
const context = () => ({ repository: 'kyriswu/huahuo-server', eventName: 'workflow_dispatch', ref: 'refs/heads/main', controlSha });
const branch = (name: string, sha: string) => ({ ref: `refs/heads/${name}`, object: { type: 'commit', sha } });
const run = () => ({ head_sha: targetSha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success',
  path: '.github/workflows/release-smoke-check.yml', head_repository: { full_name: 'kyriswu/huahuo-server' } });
const source = () => ({ mainRef: branch('main', controlSha), ciRuns: { workflow_runs: [run()] } });
const claims = () => ({ iss: 'https://token.actions.githubusercontent.com', aud: 'sts.aliyuncs.com',
  sub: 'repo:kyriswu@5120703/huahuo-server@1415659399:environment:test', ref: 'refs/heads/main',
  repository: 'kyriswu/huahuo-server', event_name: 'workflow_dispatch', sha: controlSha });

describe('manual test release source verification (local data fixtures only)', () => {
  it('deploys the exact protected-main control revision after that same SHA passes push CI', () => {
    expect(selectTestReleaseRevision(context(), source())).toEqual({ controlSha, targetSha });
    expect(controlSha).toBe(targetSha);
  });
  it.each([
    ['different repository', { repository: 'other/huahuo-server' }],
    ['test-selected workflow', { ref: 'refs/heads/test' }],
    ['pull request', { eventName: 'pull_request' }],
    ['CI completion', { eventName: 'workflow_run' }],
    ['push trigger', { eventName: 'push' }],
    ['mutable control ref', { controlSha: 'main' }],
    ['invalid target lock', { expectedTargetSha: 'test' }],
  ])('rejects %s before granting a release target', (_label, patch) => {
    expect(() => selectTestReleaseRevision({ ...context(), ...patch }, source())).toThrow(/^TEST_RELEASE_SOURCE_NOT_VERIFIED$/);
  });
  it('rejects main moving after workflow dispatch', () => {
    const snapshot = source(); snapshot.mainRef.object.sha = movedSha;
    expect(() => selectTestReleaseRevision(context(), snapshot)).toThrow('TEST_RELEASE_SOURCE_NOT_VERIFIED');
  });
  it('rejects main moving after selection even if the new SHA has passed CI', () => {
    const snapshot = source(); snapshot.mainRef.object.sha = movedSha; snapshot.ciRuns.workflow_runs[0]!.head_sha = movedSha;
    expect(() => selectTestReleaseRevision({ ...context(), expectedTargetSha: targetSha }, snapshot)).toThrow('TEST_RELEASE_SOURCE_NOT_VERIFIED');
    expect(selectTestReleaseRevision({ ...context(), expectedTargetSha: targetSha }, source()).targetSha).toBe(targetSha);
  });
  it('rejects a target SHA different from the dispatch revision instead of deploying test or another revision', () => {
    expect(() => selectTestReleaseRevision({ ...context(), expectedTargetSha: movedSha }, source())).toThrow('TEST_RELEASE_SOURCE_NOT_VERIFIED');
  });
  it.each([
    ['wrong target revision', { head_sha: movedSha }],
    ['test CI', { head_branch: 'test' }],
    ['PR CI', { event: 'pull_request' }],
    ['manual CI', { event: 'workflow_dispatch' }],
    ['failed CI', { conclusion: 'failure' }],
    ['incomplete CI', { status: 'in_progress' }],
    ['different workflow', { path: '.github/workflows/unrelated.yml' }],
    ['fork CI', { head_repository: { full_name: 'other/huahuo-server' } }],
  ])('rejects %s as test deployment evidence', (_label, patch) => {
    const snapshot = source(); Object.assign(snapshot.ciRuns.workflow_runs[0]!, patch);
    expect(() => selectTestReleaseRevision(context(), snapshot)).toThrow('TEST_RELEASE_SOURCE_NOT_VERIFIED');
  });
  it('requires CI evidence and correct branch ref objects', () => {
    const missing = source(); missing.ciRuns.workflow_runs = [];
    expect(() => selectTestReleaseRevision(context(), missing)).toThrow('TEST_RELEASE_SOURCE_NOT_VERIFIED');
    const wrongBranch = source(); wrongBranch.mainRef.ref = 'refs/heads/test';
    expect(() => selectTestReleaseRevision(context(), wrongBranch)).toThrow('TEST_RELEASE_SOURCE_NOT_VERIFIED');
    const tag = source(); tag.mainRef.object.type = 'tag';
    expect(() => selectTestReleaseRevision(context(), tag)).toThrow('TEST_RELEASE_SOURCE_NOT_VERIFIED');
  });
  it('reads only main and its exact push CI, never depends on the test branch, and refuses redirects', async () => {
    const snapshot = source();
    const request = vi.fn(async (url: string) => ({ ok: true, json: async () =>
      url.endsWith('/main') ? snapshot.mainRef : snapshot.ciRuns }));
    expect(await resolveTestReleaseRevision(context(), 'private-token-fixture', request)).toEqual({ controlSha, targetSha });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/kyriswu/huahuo-server/git/ref/heads/main',
      `https://api.github.com/repos/kyriswu/huahuo-server/actions/workflows/release-smoke-check.yml/runs?branch=main&event=push&status=success&head_sha=${targetSha}&per_page=10`,
    ]);
    for (const call of request.mock.calls) {
      const options = (call as unknown as [string, { redirect: string; signal: AbortSignal; headers: { authorization: string } }])[1];
      expect(options.redirect).toBe('error'); expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.headers.authorization).toBe('Bearer private-token-fixture');
    }
  });
  it('performs no GitHub request from a non-main dispatch context', async () => {
    const request = vi.fn();
    await expect(resolveTestReleaseRevision({ ...context(), ref: 'refs/heads/test' }, 'fixture', request)).rejects.toThrow('TEST_RELEASE_SOURCE_NOT_VERIFIED');
    expect(request).not.toHaveBeenCalled();
  });
  it('does not use an unvalidated ref value in a follow-up request', async () => {
    const request = vi.fn(async () => ({ ok: true, json: async () => branch('main', 'private?redirect=https://other.invalid') }));
    await expect(resolveTestReleaseRevision(context(), 'fixture', request)).rejects.toThrow(/^TEST_RELEASE_SOURCE_NOT_VERIFIED$/);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('stops before looking up CI if a later invocation tries to switch the selected target', async () => {
    const request = vi.fn(async () => ({ ok: true, json: async () => branch('main', controlSha) }));
    await expect(resolveTestReleaseRevision({ ...context(), expectedTargetSha: movedSha }, 'fixture', request)).rejects.toThrow('TEST_RELEASE_SOURCE_NOT_VERIFIED');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('sanitizes API, malformed JSON and HTTP failures', async () => {
    const privateMessage = 'private-token-or-response-must-not-be-logged';
    for (const request of [
      vi.fn(async () => { throw new Error(privateMessage); }),
      vi.fn(async () => ({ ok: false, json: async () => { throw new Error(privateMessage); } })),
      vi.fn(async () => ({ ok: true, json: async () => { throw new Error(privateMessage); } })),
    ]) await expect(resolveTestReleaseRevision(context(), 'fixture', request)).rejects.toThrow(/^TEST_RELEASE_SOURCE_NOT_VERIFIED$/);
  });
  it('requires the test environment OIDC identity from this exact manual main revision', () => {
    expect(() => verifyTestReleaseOidcClaims(claims(), controlSha)).not.toThrow();
  });
  it.each([
    ['old branch-only subject', { sub: 'repo:kyriswu@5120703/huahuo-server@1415659399:ref:refs/heads/main' }],
    ['production environment', { sub: 'repo:kyriswu@5120703/huahuo-server@1415659399:environment:production' }],
    ['test branch code', { ref: 'refs/heads/test' }],
    ['different repository', { repository: 'other/huahuo-server' }],
    ['automatic CI completion', { event_name: 'workflow_run' }],
    ['different main revision', { sha: movedSha }],
    ['wrong issuer', { iss: 'https://other.invalid' }],
    ['wrong audience', { aud: 'other-service' }],
  ])('rejects OIDC claims with %s', (_label, patch) => {
    expect(() => verifyTestReleaseOidcClaims({ ...claims(), ...patch }, controlSha)).toThrow(/^TEST_RELEASE_OIDC_NOT_VERIFIED$/);
  });
  it('CLI fails closed for an unauthorized context without printing private input', () => {
    const result = spawnSync(process.execPath, ['scripts/release/test-release-source.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH, GH_TOKEN: 'private-token-fixture',
        GITHUB_REPOSITORY: 'kyriswu/huahuo-server', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/test', GITHUB_SHA: controlSha },
    });
    expect(result.status).toBe(1); expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('::error::TEST_RELEASE_SOURCE_NOT_VERIFIED');
  });
});
