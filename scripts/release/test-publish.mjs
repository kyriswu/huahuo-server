import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const REPO = 'kyriswu/huahuo-server';
const CI = '.github/workflows/release-smoke-check.yml';
const RELEASE = '.github/workflows/test-server-release.yml';
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const fail = code => { throw new Error(code); };
const documentation = file => file.startsWith('docs/') || file.startsWith('.agents/skills/')
  || ['AGENTS.md', '.gitignore', '.github/CODEOWNERS'].includes(file);
const orchestrationOnly = file => ['scripts/release/test-publish.mjs', 'tests/unit/test-publish.test.ts'].includes(file);
const protectedFile = file => file.startsWith('.agents/skills/huahuo-release/') || file === '.github/CODEOWNERS';

/** Only test merges and the fixed main workflow. GitHub still enforces branch rules. */
export async function publishTest({ pr, state = null, request, save, pause = () => setTimeout(10000), now = Date.now, report = () => {} }) {
  if (!Number.isSafeInteger(pr) || pr < 1) fail('TEST_PUBLISH_PR_INVALID');
  const readPr = () => request('GET', `/pulls/${pr}`);
  const ref = async name => {
    const value = await request('GET', `/git/ref/heads/${name}`);
    if (value.ref !== `refs/heads/${name}` || value.object?.type !== 'commit' || !sha(value.object.sha)) fail('TEST_PUBLISH_REF_INVALID');
    return value.object.sha;
  };
  const validPr = value => value.base?.ref === 'test' && value.base.repo?.full_name === REPO
    && value.head?.repo?.full_name === REPO && sha(value.head.sha) && sha(value.base.sha) && !value.draft;
  const persist = async patch => { Object.assign(state, patch); await save(state); report({ phase: state.phase, pr, testSha: state.mergedSha, runId: state.runId }); };
  const until = async (stage, seconds, check) => {
    const deadline = now() + seconds * 1000;
    while (now() < deadline) { if (await check()) return; await pause(); }
    fail(`TEST_PUBLISH_${stage}_TIMEOUT`);
  };
  const waitCi = async (revision, event, branch) => until('CI', 1200, async () => {
    const result = await request('GET', `/actions/workflows/release-smoke-check.yml/runs?head_sha=${revision}&event=${event}&per_page=100`);
    if (!Array.isArray(result.workflow_runs)) fail('TEST_PUBLISH_CI_INVALID');
    const runs = result.workflow_runs.filter(run => run.head_sha === revision && run.event === event
      && run.head_branch === branch && run.path === CI && run.head_repository?.full_name === REPO).sort((a, b) => b.id - a.id);
    const latest = runs[0];
    if (!latest || latest.status !== 'completed') return false;
    if (latest.conclusion !== 'success') fail('TEST_PUBLISH_CI_FAILED');
    return true;
  });
  if (!state) {
    const candidate = await readPr();
    if (!validPr(candidate) || candidate.state !== 'open') fail('TEST_PUBLISH_TARGET_REFUSED');
    const controlSha = await ref('main');
    const files = [];
    // No truncation-based docs-only classification.
    for (let page = 1; page <= 30; page++) {
      const batch = await request('GET', `/pulls/${pr}/files?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) fail('TEST_PUBLISH_FILES_INVALID');
      files.push(...batch);
      if (batch.length < 100) break;
    }
    if (!files.length || files.length !== candidate.changed_files || files.some(file => typeof file.filename !== 'string')) fail('TEST_PUBLISH_FILES_INCOMPLETE');
    const paths = files.flatMap(file => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]);
    const mainSync = candidate.head.ref === 'main' && candidate.head.sha === controlSha;
    if (paths.some(protectedFile) && !mainSync) fail('TEST_PUBLISH_PROTECTED_CHANGE_REQUIRES_MAIN_SYNC');
    state = { version: 1, repository: REPO, pr, phase: 'prepared', headSha: candidate.head.sha,
      headBranch: candidate.head.ref, baseSha: candidate.base.sha, controlSha, skipDeployment: paths.every(documentation) || (mainSync && paths.every(path => documentation(path) || orchestrationOnly(path))) };
    await persist({});
  }
  if (state.version !== 1 || state.repository !== REPO || state.pr !== pr || !sha(state.headSha)
    || !sha(state.baseSha) || !sha(state.controlSha) || typeof state.skipDeployment !== 'boolean'
    || !['prepared', 'merging', 'merged', 'dispatching', 'dispatched', 'complete'].includes(state.phase)) fail('TEST_PUBLISH_STATE_INVALID');
  if (state.phase === 'complete') return state;
  if (!state.mergedSha) {
    let candidate = await readPr();
    if (!validPr(candidate) || candidate.head.sha !== state.headSha) fail('TEST_PUBLISH_PR_CHANGED');
    if (!candidate.merged) {
      await waitCi(state.headSha, 'pull_request', state.headBranch);
      candidate = await readPr();
      if (!validPr(candidate) || candidate.head.sha !== state.headSha || candidate.base.sha !== state.baseSha) fail('TEST_PUBLISH_PR_CHANGED');
      await persist({ phase: 'merging' });
      const result = await request('PUT', `/pulls/${pr}/merge`, { sha: state.headSha, merge_method: 'merge' });
      if (!result.merged || !sha(result.sha)) fail('TEST_PUBLISH_MERGE_FAILED');
      await persist({ phase: 'merged', mergedSha: result.sha });
    } else {
      if (state.phase !== 'merging' || !sha(candidate.merge_commit_sha)) fail('TEST_PUBLISH_MERGE_UNCONFIRMED');
      await persist({ phase: 'merged', mergedSha: candidate.merge_commit_sha });
    }
  }
  if (!sha(state.mergedSha) || await ref('test') !== state.mergedSha) fail('TEST_PUBLISH_TEST_MOVED');
  await waitCi(state.mergedSha, 'push', 'test');
  if (state.skipDeployment) { await persist({ phase: 'complete', deployment: 'not-needed' }); return state; }
  if (await ref('main') !== state.controlSha || await ref('test') !== state.mergedSha) fail('TEST_PUBLISH_SOURCE_MOVED');
  if (state.phase === 'dispatching' && !state.runId) fail('TEST_PUBLISH_DISPATCH_UNCONFIRMED');
  if (!state.runId) {
    const runs = await request('GET', '/actions/workflows/test-server-release.yml/runs?event=workflow_dispatch&per_page=100');
    if (!Array.isArray(runs.workflow_runs) || runs.workflow_runs.some(run => run.status !== 'completed')) fail('TEST_PUBLISH_RELEASE_ALREADY_RUNNING');
    await persist({ phase: 'dispatching' });
    // 2026-03-10 returns the exact run ID. An ambiguous response never redispatches.
    const result = await request('POST', '/actions/workflows/test-server-release.yml/dispatches', { ref: 'main' });
    if (!Number.isSafeInteger(result?.workflow_run_id) || result.workflow_run_id < 1) fail('TEST_PUBLISH_DISPATCH_UNCONFIRMED');
    await persist({ phase: 'dispatched', runId: result.workflow_run_id });
  }
  if (!Number.isSafeInteger(state.runId) || state.runId < 1) fail('TEST_PUBLISH_RUN_INVALID');
  await until('RELEASE', 6100, async () => {
    const run = await request('GET', `/actions/runs/${state.runId}`);
    if (run.id !== state.runId || run.path !== RELEASE || run.event !== 'workflow_dispatch'
      || run.head_branch !== 'main' || run.head_sha !== state.controlSha || run.head_repository?.full_name !== REPO) fail('TEST_PUBLISH_RUN_INVALID');
    if (run.status !== 'completed') return false;
    if (run.conclusion !== 'success') fail('TEST_PUBLISH_RELEASE_FAILED');
    return true;
  });
  await persist({ phase: 'complete', deployment: 'passed' });
  return state;
}

async function main() {
  const args = process.argv.slice(2), pr = Number(args[1]);
  if (args[0] !== '--pr' || !Number.isSafeInteger(pr) || pr < 1 || args.length > 3 || (args[2] && args[2] !== '--resume')) fail('TEST_PUBLISH_ARGUMENTS_INVALID');
  const token = process.env.GH_TOKEN;
  if (!token || /[\r\n]/.test(token)) fail('TEST_PUBLISH_GITHUB_TOKEN_REQUIRED');
  const path = resolve('.local/test-publish', `pr-${pr}.json`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = path + '.lock';
  try { await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch { fail('TEST_PUBLISH_LOCAL_LOCKED'); }
  try {
  let state = null;
  if (args[2] === '--resume') state = JSON.parse(await readFile(path, 'utf8'));
  else {
    try { await writeFile(path, JSON.stringify({ repository: REPO, pr, phase: 'initializing' }), { flag: 'wx', mode: 0o600 }); }
    catch { fail('TEST_PUBLISH_STATE_EXISTS'); }
  }
  const request = async (method, resource, body) => {
    const response = await fetch(`https://api.github.com/repos/${REPO}${resource}`, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) fail('TEST_PUBLISH_GITHUB_REQUEST_FAILED');
    return response.status === 204 ? null : response.json();
  };
  const save = async value => {
    const temporary = path + '.' + process.pid + '.tmp';
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  };
  await publishTest({ pr, state, request, save, report: value => console.log(JSON.stringify(value)) });
  } finally { await unlink(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(JSON.stringify({ status: 'failed', code: /^TEST_PUBLISH_[A-Z_]+$/.test(error?.message) ? error.message : 'TEST_PUBLISH_FAILED' })); process.exitCode = 1; });
}
