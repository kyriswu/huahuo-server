import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

// Reviewed, fixed GET allowlist. Adding a business check requires a code review;
// neither workflow inputs nor a release manifest can supply arbitrary endpoints.
export class SmokeError extends Error {
  constructor(code) { super(code); this.name = 'SmokeError'; this.code = code; }
}
const fail = code => { throw new SmokeError(code); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function readSmokeConfig(env = process.env) {
  let base;
  try { base = new URL(env.SMOKE_BASE_URL); } catch { fail('SMOKE_BASE_URL_INVALID'); }
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') fail('SMOKE_BASE_URL_INVALID');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) fail('SMOKE_HTTPS_REQUIRED');
  const accessToken = env.SMOKE_ACCESS_TOKEN;
  if (typeof accessToken !== 'string' || accessToken.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken)) fail('SMOKE_ACCESS_TOKEN_REQUIRED');
  if (!uuid(env.SMOKE_USER_ID)) fail('SMOKE_USER_ID_REQUIRED');
  if (!uuid(env.SMOKE_WORKSPACE_ID)) fail('SMOKE_WORKSPACE_ID_REQUIRED');
  const budget = (name, maximum) => {
    const value = Number(env[name] ?? maximum);
    if (!Number.isInteger(value) || value < 100 || value > maximum) fail('SMOKE_TIMEOUT_INVALID');
    return value;
  };
  return Object.freeze({ baseUrl: base.origin, accessToken, userId: env.SMOKE_USER_ID.toLowerCase(), workspaceId: env.SMOKE_WORKSPACE_ID.toLowerCase(),
    requestTimeoutMs: budget('SMOKE_REQUEST_TIMEOUT_MS', 5000), totalTimeoutMs: budget('SMOKE_TOTAL_TIMEOUT_MS', 30000), maxResponseBytes: 65536 });
}

function envelope(body) {
  if (!object(body) || body.success !== true || !object(body.data) || typeof body.traceId !== 'string' || !body.traceId) fail('SMOKE_RESPONSE_INVALID');
  return body.data;
}
function checksFor(config) {
  const health = status => body => {
    const data = envelope(body);
    if (data.service !== 'api-server' || data.status !== status) fail('SMOKE_HEALTH_INVALID');
  };
  return [
    { name: 'live', path: '/health/live', status: 200, check: health('live') },
    { name: 'ready', path: '/health/ready', status: 200, check: health('ready') },
    { name: 'anonymous-denied', path: '/api/v1/me/status', status: 401, check: body => {
      if (!object(body) || body.success !== false || !object(body.error) || body.error.code !== 'UNAUTHORIZED' || typeof body.traceId !== 'string') fail('SMOKE_AUTH_GUARD_INVALID');
    } },
    { name: 'identity', path: '/api/v1/me/status', status: 200, authenticated: true, check: body => {
      const data = envelope(body);
      if (data.user?.userId !== config.userId || data.workspace?.workspaceId !== config.workspaceId || data.workspace?.status !== 'ready') fail('SMOKE_IDENTITY_MISMATCH');
    } },
    { name: 'workspaces', path: '/api/v1/workspaces', status: 200, authenticated: true, check: body => {
      const { items } = envelope(body);
      if (!Array.isArray(items) || !items.every(item => object(item) && uuid(item.workspaceId) && typeof item.displayName === 'string' && ['ready', 'disabled'].includes(item.state) && typeof item.isDefault === 'boolean' && typeof item.etag === 'string')) fail('SMOKE_WORKSPACES_INVALID');
      if (!items.some(item => item.workspaceId === config.workspaceId && item.state === 'ready' && item.isDefault)) fail('SMOKE_WORKSPACE_MISSING');
    } },
    { name: 'tasks', path: '/api/v1/tasks/running', status: 200, authenticated: true, check: body => {
      const { items } = envelope(body);
      if (!Array.isArray(items) || items.length > 100 || !items.every(item => object(item) && uuid(item.taskId) && typeof item.taskType === 'string' && ['queued', 'running'].includes(item.status) && ['queued', 'running', 'retry_scheduled', 'waiting_external', 'reconciling', 'cancel_requested'].includes(item.state) && (item.workspaceId === null || uuid(item.workspaceId)))) fail('SMOKE_TASKS_INVALID');
    } },
  ];
}

async function readJson(response, limit) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel(); fail('SMOKE_RESPONSE_TOO_LARGE');
  }
  if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel(); fail('SMOKE_JSON_REQUIRED');
  }
  const reader = response.body?.getReader();
  if (!reader) fail('SMOKE_RESPONSE_INVALID');
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); fail('SMOKE_RESPONSE_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('SMOKE_JSON_INVALID'); }
}

export async function runSmoke(config) {
  // Validate again so programmatic callers cannot bypass the production bounds.
  config = readSmokeConfig({ SMOKE_BASE_URL: config.baseUrl, SMOKE_ACCESS_TOKEN: config.accessToken,
    SMOKE_USER_ID: config.userId, SMOKE_WORKSPACE_ID: config.workspaceId,
    SMOKE_REQUEST_TIMEOUT_MS: config.requestTimeoutMs, SMOKE_TOTAL_TIMEOUT_MS: config.totalTimeoutMs });
  const started = performance.now();
  const totalSignal = AbortSignal.timeout(config.totalTimeoutMs);
  const checks = [];
  let requestCount = 0;
  for (const check of checksFor(config)) {
    const began = performance.now();
    let httpStatus;
    const signal = AbortSignal.any([totalSignal, AbortSignal.timeout(config.requestTimeoutMs)]);
    try {
      if (totalSignal.aborted) fail('SMOKE_TOTAL_TIMEOUT');
      requestCount++;
      const response = await fetch(config.baseUrl + check.path, { method: 'GET', redirect: 'manual', signal,
        headers: { accept: 'application/json', 'cache-control': 'no-cache', ...(check.authenticated ? { authorization: `Bearer ${config.accessToken}` } : {}) } });
      httpStatus = response.status;
      if (httpStatus >= 300 && httpStatus < 400) { await response.body?.cancel(); fail('SMOKE_REDIRECT_REFUSED'); }
      if (httpStatus !== check.status) { await response.body?.cancel(); fail('SMOKE_HTTP_STATUS'); }
      check.check(await readJson(response, config.maxResponseBytes));
      if (signal.aborted) fail(totalSignal.aborted ? 'SMOKE_TOTAL_TIMEOUT' : 'SMOKE_REQUEST_TIMEOUT');
      checks.push({ name: check.name, status: 'passed', httpStatus, durationMs: Math.round(performance.now() - began) });
    } catch (error) {
      const code = totalSignal.aborted ? 'SMOKE_TOTAL_TIMEOUT' : signal.aborted ? 'SMOKE_REQUEST_TIMEOUT' : error instanceof SmokeError ? error.code : 'SMOKE_REQUEST_FAILED';
      checks.push({ name: check.name, status: 'failed', code, ...(httpStatus === undefined ? {} : { httpStatus }), durationMs: Math.round(performance.now() - began) });
      return { status: 'failed', checks, requestCount, durationMs: Math.round(performance.now() - started) };
    }
  }
  return { status: 'passed', checks, requestCount, durationMs: Math.round(performance.now() - started) };
}

async function main() {
  let report;
  try { report = await runSmoke(readSmokeConfig()); }
  catch (error) { report = { status: 'failed', code: error instanceof SmokeError ? error.code : 'SMOKE_FAILED', checks: [], requestCount: 0 }; }
  // Only our fixed names/codes/status/numbers are serialized. Never error.message,
  // request config, URLs, response bodies, trace IDs, account IDs or credentials.
  console.log(JSON.stringify(report));
  process.exitCode = report.status === 'passed' ? 0 : 1;
  try {
    if (process.env.SMOKE_REPORT_PATH) writeFileSync(process.env.SMOKE_REPORT_PATH, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Release smoke: **${report.status}** (${report.requestCount} requests)\n\n` +
      report.checks.map(check => `- ${check.name}: ${check.status}${check.code ? ` (${check.code})` : ''}`).join('\n') + '\n');
  } catch { console.error(JSON.stringify({ status: 'failed', code: 'SMOKE_REPORT_WRITE_FAILED' })); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
