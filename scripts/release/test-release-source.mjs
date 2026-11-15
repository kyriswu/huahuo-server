import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'kyriswu/huahuo-server';
const WORKFLOW_PATH = '.github/workflows/release-smoke-check.yml';
const SHA = /^[a-f0-9]{40}$/;
const failed = () => { throw new Error('TEST_RELEASE_SOURCE_NOT_VERIFIED'); };

function validateContext(context) {
  if (context.repository !== REPOSITORY || context.eventName !== 'workflow_dispatch'
    || context.ref !== 'refs/heads/main' || !SHA.test(context.controlSha ?? '')
    || (context.expectedTargetSha !== undefined && !SHA.test(context.expectedTargetSha))) failed();
}

/** The test server temporarily deploys the same reviewed main SHA as its control code. */
export function selectTestReleaseRevision(context, { mainRef, ciRuns }) {
  validateContext(context);
  if (mainRef?.ref !== 'refs/heads/main' || mainRef.object?.type !== 'commit' || mainRef.object.sha !== context.controlSha
    || (context.expectedTargetSha !== undefined && mainRef.object.sha !== context.expectedTargetSha)) failed();
  if (!Array.isArray(ciRuns?.workflow_runs) || !ciRuns.workflow_runs.some(run =>
    run?.head_sha === context.controlSha && run.head_branch === 'main' && run.event === 'push'
    && run.status === 'completed' && run.conclusion === 'success' && run.path === WORKFLOW_PATH
    && run.head_repository?.full_name === REPOSITORY)) failed();
  return { controlSha: context.controlSha, targetSha: context.controlSha };
}

/** Signature verification remains the responsibility of Alibaba STS. */
export function verifyTestReleaseOidcClaims(claims, controlSha) {
  if (!SHA.test(controlSha ?? '') || claims?.iss !== 'https://token.actions.githubusercontent.com'
    || claims.aud !== 'sts.aliyuncs.com'
    || claims.sub !== 'repo:kyriswu@5120703/huahuo-server@1415659399:environment:test'
    || claims.ref !== 'refs/heads/main' || claims.repository !== REPOSITORY
    || claims.event_name !== 'workflow_dispatch' || claims.sha !== controlSha) {
    throw new Error('TEST_RELEASE_OIDC_NOT_VERIFIED');
  }
}

export async function resolveTestReleaseRevision(context, token, fetchImpl = fetch) {
  try {
    validateContext(context);
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) failed();
    const read = async path => {
      const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}${path}`, {
        headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(10000), redirect: 'error',
      });
      if (!response.ok) failed();
      return response.json();
    };
    const mainRef = await read('/git/ref/heads/main');
    // Validate main before constructing the CI query, so a ref value can
    // never become an arbitrary URL or request parameter.
    if (mainRef?.ref !== 'refs/heads/main' || mainRef.object?.type !== 'commit' || mainRef.object.sha !== context.controlSha
      || (context.expectedTargetSha !== undefined && context.expectedTargetSha !== context.controlSha)) failed();
    const ciRuns = await read(`/actions/workflows/release-smoke-check.yml/runs?branch=main&event=push&status=success&head_sha=${context.controlSha}&per_page=10`);
    return selectTestReleaseRevision(context, { mainRef, ciRuns });
  } catch { failed(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await resolveTestReleaseRevision({ repository: process.env.GITHUB_REPOSITORY,
      eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF, controlSha: process.env.GITHUB_SHA,
      expectedTargetSha: process.env.TEST_RELEASE_SHA }, process.env.GH_TOKEN);
    if (!process.env.GITHUB_ENV) failed();
    await appendFile(process.env.GITHUB_ENV, `TEST_RELEASE_SHA=${result.targetSha}\n`);
    console.log('Exact main revision and its successful push CI verified for the test server.');
  } catch {
    console.error('::error::TEST_RELEASE_SOURCE_NOT_VERIFIED');
    process.exitCode = 1;
  }
}
