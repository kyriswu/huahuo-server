import { describe, expect, it } from 'vitest';
// @ts-expect-error Release tooling uses dependency-free JavaScript.
import { testReleaseIntent, readAutomaticReleaseReadiness, resolveTestReleaseTrigger } from '../../scripts/release/test-release-trigger.mjs';
const repo = 'kyriswu/huahuo-server', control = 'a'.repeat(40), target = 'b'.repeat(40);
const context = () => ({ repository: repo, eventName: 'workflow_run', ref: 'refs/heads/main', controlSha: control, expectedTargetSha: target,
  trigger: { id: 17, path: '.github/workflows/release-smoke-check.yml', head_sha: target, head_branch: 'test', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: repo } } });
const readyPlan = () => ({ version: 1, id: 'fixture-release', baseRevision: 'c'.repeat(40),
  compatibility: { database: true, api: true, tasks: true, configuration: true } });
function planContent(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { type: 'file', path: 'scripts/release/plan.json', encoding: 'base64', size: bytes.length, content: bytes.toString('base64') };
}
function fixture(files: { filename: string; previous_filename?: string }[]) {
  const pr = { number: 9, merged: true, merged_at: '2026-11-15T00:00:00Z', merge_commit_sha: target, changed_files: files.length,
    base: { ref: 'test', repo: { full_name: repo } }, head: { repo: { full_name: repo } } };
  const read = async (path: string) => path.includes('/commits/') ? [pr] : path.includes('/files?') ? files : pr;
  return { pr, read };
}
describe('native test deployment intent (read-only API fixtures)', () => {
  it.each([true, false])('reads compatibility only from the exact tested commit (ready=%s)', async ready => {
    const plan = readyPlan(); plan.compatibility.api = ready;
    const paths: string[] = [];
    expect(await readAutomaticReleaseReadiness(target, async (path: string) => {
      paths.push(path); return planContent(plan);
    })).toBe(ready);
    expect(paths).toEqual([`/contents/scripts/release/plan.json?ref=${target}`]);
  });
  it.each([
    { ...planContent(readyPlan()), type: 'symlink' },
    { ...planContent(readyPlan()), path: 'unreviewed.json' },
    { ...planContent(readyPlan()), size: 65537 },
    { ...planContent(readyPlan()), content: 'invalid!' },
    planContent({ ...readyPlan(), compatibility: { api: true } }),
    planContent({ ...readyPlan(), compatibility: { ...readyPlan().compatibility, api: 'false' } }),
  ])('fails closed for malformed candidate readiness (%#)', async content => {
    await expect(readAutomaticReleaseReadiness(target, async () => content)).rejects.toThrow('TEST_RELEASE_PLAN_NOT_VERIFIED');
  });
  it.each(['workflow_run', 'workflow_dispatch'])('never requests cloud work for incompatible %s', async eventName => {
    const c = { ...context(), eventName }, f = fixture([{ filename: 'scripts/release/plan.json' }]);
    const plan = readyPlan(); plan.compatibility.api = false;
    const urls: string[] = [];
    const request = async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => url.endsWith('/main') ? { ref: 'refs/heads/main', object: { type: 'commit', sha: control } }
        : url.endsWith('/test') ? { ref: 'refs/heads/test', object: { type: 'commit', sha: target } }
          : url.includes('/actions/workflows/') ? { workflow_runs: [c.trigger] }
            : url.includes('/contents/') ? planContent(plan)
              : f.read(url.replace('https://api.github.com/repos/' + repo, '')) };
    };
    const result = resolveTestReleaseTrigger(c, 'synthetic-token', request);
    if (eventName === 'workflow_run') await expect(result).resolves.toMatchObject({ deploy: false, reason: 'release-prerequisites-required', automaticReleaseReady: false });
    else await expect(result).rejects.toThrow('TEST_RELEASE_PREREQUISITES_REQUIRED');
    expect(urls.every(url => url.startsWith('https://api.github.com/repos/' + repo + '/'))).toBe(true);
  });
  it('keeps compatible automatic deployment enabled after exact CI and plan checks', async () => {
    const c = context(), f = fixture([{ filename: 'scripts/release/plan.json' }]);
    const request = async (url: string) => ({ ok: true, json: async () => url.endsWith('/main') ? { ref: 'refs/heads/main', object: { type: 'commit', sha: control } }
      : url.endsWith('/test') ? { ref: 'refs/heads/test', object: { type: 'commit', sha: target } }
        : url.includes('/actions/workflows/') ? { workflow_runs: [c.trigger] }
          : url.includes('/contents/') ? planContent(readyPlan())
            : f.read(url.replace('https://api.github.com/repos/' + repo, '')) });
    await expect(resolveTestReleaseTrigger(c, 'synthetic-token', request)).resolves.toMatchObject({ deploy: true, automaticReleaseReady: true });
  });
  it('deploys a merged PR that updates the reviewed release plan', async () => {
    await expect(testReleaseIntent(context(), fixture([{ filename: 'scripts/release/plan.json' }, { filename: 'src/business.ts' }]).read))
      .resolves.toEqual({ deploy: true, reason: 'reviewed-release-plan' });
  });
  it('does not deploy documentation, skill ownership or the known control-flow sync', async () => {
    const f = fixture([{ filename: 'docs/release.md' }, { filename: '.github/CODEOWNERS' }, { filename: '.agents/skills/huahuo-release/SKILL.md' }, { filename: 'scripts/release/test-release-trigger.mjs' }]);
    await expect(testReleaseIntent(context(), f.read)).resolves.toEqual({ deploy: false, reason: 'no-application-change' });
  });
  it('keeps host deployment-policy updates in control review without deploying the application', async () => {
    const files = ['scripts/release/deployment-policy.py', 'tests/unit/deployment-policy.test.ts', 'src/release/plan.ts', 'tests/unit/release-plan.test.ts'].map(filename => ({ filename }));
    await expect(testReleaseIntent(context(), fixture(files).read)).resolves.toEqual({ deploy: false, reason: 'no-application-change' });
  });
  it('treats ACK deployment files as control code and checks both sides of a rename', async () => {
    const filename = 'deploy/k8s/verify-from-ecs.sh';
    await expect(testReleaseIntent(context(), fixture([{ filename }]).read))
      .resolves.toEqual({ deploy: false, reason: 'no-application-change' });
    await expect(testReleaseIntent(context(), fixture([{ filename, previous_filename: 'src/business.ts' }]).read))
      .rejects.toThrow('TEST_RELEASE_PLAN_UPDATE_REQUIRED');
  });
  it('treats impact reporting files as CI-only and still requires a plan for mixed application changes', async () => {
    const files = ['.github/workflows/release-smoke-check.yml', '.github/release-impact/package.json',
      '.github/release-impact/pnpm-lock.yaml', '.github/release-impact/report.mjs'].map(filename => ({ filename }));
    await expect(testReleaseIntent(context(), fixture(files).read)).resolves.toEqual({ deploy: false, reason: 'no-application-change' });
    await expect(testReleaseIntent(context(), fixture([...files, { filename: 'src/modules/rag/jobs.ts' }]).read))
      .rejects.toThrow('TEST_RELEASE_PLAN_UPDATE_REQUIRED');
  });
  it.each(['src/business.ts', 'compose.yaml', '.env.example', 'migrations/0003_new.sql', 'scripts/release/unknown.mjs'])('requires an updated plan for %s', async filename => {
    await expect(testReleaseIntent(context(), fixture([{ filename }]).read)).rejects.toThrow('TEST_RELEASE_PLAN_UPDATE_REQUIRED');
  });
  it('does not hide application deletion behind a rename into docs', async () => {
    await expect(testReleaseIntent(context(), fixture([{ filename: 'docs/moved.ts', previous_filename: 'src/business.ts' }]).read)).rejects.toThrow('TEST_RELEASE_PLAN_UPDATE_REQUIRED');
  });
  it('fails closed for incomplete file lists', async () => {
    const f = fixture([{ filename: 'docs/a.md' }]); f.pr.changed_files = 2;
    await expect(testReleaseIntent(context(), f.read)).rejects.toThrow('TEST_RELEASE_FILE_LIST_INCOMPLETE');
  });
  it('requires the PR to have merged into this repository test at the exact triggering SHA', async () => {
    const f = fixture([{ filename: 'scripts/release/plan.json' }]); f.pr.merge_commit_sha = control;
    await expect(testReleaseIntent(context(), f.read)).rejects.toThrow('TEST_RELEASE_MERGED_PR_REQUIRED');
  });
  it('preserves explicit manual recovery without pretending it is a CI event', async () => {
    await expect(testReleaseIntent({ eventName: 'workflow_dispatch' }, async () => { throw Error(); })).resolves.toEqual({ deploy: true, reason: 'explicit-dispatch' });
  });
  it('verifies source/CI before deciding to skip; never requests cloud credentials', async () => {
    const c = context(), f = fixture([{ filename: 'docs/a.md' }]), urls: string[] = [];
    const request = async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => url.endsWith('/main') ? { ref: 'refs/heads/main', object: { type: 'commit', sha: control } }
        : url.endsWith('/test') ? { ref: 'refs/heads/test', object: { type: 'commit', sha: target } }
          : url.includes('/actions/workflows/') ? { workflow_runs: [c.trigger] }
            : f.read(url.replace('https://api.github.com/repos/' + repo, '')) };
    };
    await expect(resolveTestReleaseTrigger(c, 'synthetic-token', request)).resolves.toMatchObject({ deploy: false, targetSha: target });
    expect(urls.every(url => url.startsWith('https://api.github.com/repos/' + repo + '/'))).toBe(true);
  });
});
