import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolveTestReleaseRevision } from './test-release-source.mjs';
import { githubReader, isSha, readReleaseEventContext, REPOSITORY, verifyCiTrigger } from './release-events.mjs';
const fail = code => { throw Error(code); };
const controlFiles = new Set([
  '.github/workflows/test-server-release.yml', '.github/workflows/main-release-readiness.yml',
  '.github/workflows/release-smoke-check.yml', '.github/release-impact/package.json',
  '.github/release-impact/pnpm-lock.yaml', '.github/release-impact/report.mjs',
  'scripts/release/release-events.mjs', 'scripts/release/test-release-source.mjs',
  'scripts/release/test-release-trigger.mjs', 'scripts/release/main-release-readiness.mjs',
  'scripts/release/deployment-policy.py', 'tests/unit/deployment-policy.test.ts',
  'src/release/plan.ts', 'tests/unit/release-plan.test.ts',
  'scripts/release/test-publish.mjs', 'tests/unit/test-publish.test.ts',
  'tests/unit/test-release-source.test.ts', 'tests/unit/release-events.test.ts',
  'tests/unit/test-release-trigger.test.ts', 'tests/unit/main-release-readiness.test.ts',
  '.codex/config.toml', 'scripts/codegraph-worktree.sh',
]);
const noApplicationChange = path => controlFiles.has(path) || path.startsWith('docs/') || path.startsWith('.agents/skills/')
  || path.startsWith('deploy/k8s/')
  || ['.github/CODEOWNERS', '.gitignore', 'AGENTS.md'].includes(path);

/** Read merged-PR changes, including rename sources; never run test code/artifacts. */
export async function testReleaseIntent(context, read) {
  if (context.eventName === 'workflow_dispatch') return { deploy: true, reason: 'explicit-dispatch' };
  const trigger = verifyCiTrigger(context, 'test');
  const target = context.expectedTargetSha;
  if (target !== trigger.head_sha) fail('TEST_RELEASE_SOURCE_NOT_VERIFIED');
  const pulls = await read(`/commits/${target}/pulls?per_page=100`);
  if (!Array.isArray(pulls)) fail('TEST_RELEASE_MERGED_PR_REQUIRED');
  const matches = pulls.filter(pr => Number.isSafeInteger(pr.number) && pr.number > 0
    && pr.base?.ref === 'test' && pr.merge_commit_sha === target && pr.merged_at);
  if (matches.length !== 1) fail('TEST_RELEASE_MERGED_PR_REQUIRED');
  const pr = await read(`/pulls/${matches[0].number}`);
  if (!pr.merged || pr.merge_commit_sha !== target || pr.base?.ref !== 'test' || pr.base.repo?.full_name !== REPOSITORY
    || pr.head?.repo?.full_name !== REPOSITORY || !Number.isSafeInteger(pr.changed_files) || pr.changed_files < 1) fail('TEST_RELEASE_MERGED_PR_REQUIRED');
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await read(`/pulls/${pr.number}/files?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) fail('TEST_RELEASE_FILE_LIST_INCOMPLETE');
    files.push(...batch);
    if (batch.length < 100) break;
  }
  if (files.length !== pr.changed_files || files.some(file => typeof file.filename !== 'string'
    || (file.previous_filename !== undefined && typeof file.previous_filename !== 'string'))) fail('TEST_RELEASE_FILE_LIST_INCOMPLETE');
  const paths = files.flatMap(file => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]);
  if (paths.includes('scripts/release/plan.json')) return { deploy: true, reason: 'reviewed-release-plan' };
  if (paths.every(noApplicationChange)) return { deploy: false, reason: 'no-application-change' };
  fail('TEST_RELEASE_PLAN_UPDATE_REQUIRED');
}
export async function resolveTestReleaseTrigger(context, token, fetchImpl = fetch) {
  const revision = await resolveTestReleaseRevision(context, token, fetchImpl);
  const read = githubReader(token, fetchImpl);
  const intent = await testReleaseIntent(context, read);
  if (!intent.deploy) return { ...revision, ...intent };
  const automaticReleaseReady = await readAutomaticReleaseReadiness(revision.targetSha, read);
  if (!automaticReleaseReady && context.eventName === 'workflow_dispatch') fail('TEST_RELEASE_PREREQUISITES_REQUIRED');
  return { ...revision, ...intent, automaticReleaseReady,
    ...(!automaticReleaseReady ? { deploy: false, reason: 'release-prerequisites-required' } : {}) };
}

/** Read JSON at the exact tested commit; never execute candidate files on the trusted runner. */
export async function readAutomaticReleaseReadiness(target, read) {
  if (!isSha(target)) fail('TEST_RELEASE_PLAN_NOT_VERIFIED');
  const path = 'scripts/release/plan.json';
  const response = await read(`/contents/${path}?ref=${target}`);
  if (response?.type !== 'file' || response.path !== path || response.encoding !== 'base64'
    || !Number.isSafeInteger(response.size) || response.size < 1 || response.size > 65536
    || typeof response.content !== 'string' || response.content.length > 90000) fail('TEST_RELEASE_PLAN_NOT_VERIFIED');
  const encoded = response.content.replace(/\n/g, '');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== response.size || bytes.toString('base64') !== encoded) fail('TEST_RELEASE_PLAN_NOT_VERIFIED');
  let plan;
  try { plan = JSON.parse(bytes.toString('utf8')); } catch { fail('TEST_RELEASE_PLAN_NOT_VERIFIED'); }
  const keys = ['database', 'api', 'tasks', 'configuration'];
  if (plan?.version !== 1 || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(plan.id ?? '') || !isSha(plan.baseRevision)
    || !plan.compatibility || typeof plan.compatibility !== 'object' || Array.isArray(plan.compatibility)
    || Object.keys(plan.compatibility).length !== keys.length
    || keys.some(key => typeof plan.compatibility[key] !== 'boolean')) fail('TEST_RELEASE_PLAN_NOT_VERIFIED');
  return keys.every(key => plan.compatibility[key] === true);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await resolveTestReleaseTrigger(await readReleaseEventContext(), process.env.GH_TOKEN);
    if (!process.env.GITHUB_ENV || !process.env.GITHUB_OUTPUT) fail('TEST_RELEASE_OUTPUT_REQUIRED');
    await appendFile(process.env.GITHUB_ENV, `TEST_RELEASE_SHA=${result.targetSha}\n`);
    await appendFile(process.env.GITHUB_OUTPUT, `deploy=${result.deploy}\n`);
    console.log(JSON.stringify({ status: result.deploy ? 'candidate-verified' : 'skipped', ...result }));
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `Test candidate: ${result.targetSha}\n\n${result.deploy ? 'CI/source verified; entering the existing five-stage release.'
        : result.reason === 'release-prerequisites-required'
          ? 'Candidate review passed; this project has unmet release prerequisites. No cloud credentials or deployment command requested.'
          : 'No application change; no cloud command or deployment executed.'}\n`);
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: /^TEST_RELEASE_[A-Z_]+$/.test(error?.message) ? error.message : 'TEST_RELEASE_TRIGGER_FAILED' }));
    process.exitCode = 1;
  }
}
