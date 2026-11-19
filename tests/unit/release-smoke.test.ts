import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
// @ts-expect-error Release tooling deliberately uses dependency-free plain JavaScript.
import { readSmokeConfig, runSmoke } from '../../scripts/release/smoke.mjs';

const userId = '986137fe-2b7c-4cd1-af0c-6556e93d257f';
const workspaceId = '1d5c28ed-4278-411c-9308-dd955f07e1f4';
const token = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJzbW9rZSJ9.c2VjcmV0LXNpZ25hdHVyZQ';
const privateText = 'private-smoke-sentinel-must-not-be-logged';
const servers: Server[] = [];
const env = (baseUrl: string) => ({ SMOKE_BASE_URL: baseUrl, SMOKE_ACCESS_TOKEN: token, SMOKE_USER_ID: userId, SMOKE_WORKSPACE_ID: workspaceId });
type RecordedRequest = { method: string | undefined; path: string | undefined; authorization: string | undefined };

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const http = createServer(handler); servers.push(http);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('LOOPBACK_ADDRESS_REQUIRED');
  return `http://127.0.0.1:${address.port}`;
}
function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
}
function success(response: ServerResponse, data: unknown) { json(response, { success: true, data, traceId: 'smoke-fixture' }); }
function cli(variables: Record<string, string>) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/release/smoke.mjs'], { cwd: process.cwd(), env: { PATH: process.env.PATH, ...variables }, stdio: ['ignore', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk));
    child.once('error', reject); child.once('close', code => resolve({ code, output: Buffer.concat(output).toString() }));
  });
}
function normal(request: IncomingMessage, response: ServerResponse) {
  switch (request.url) {
    case '/health/live': return success(response, { service: 'api-server', status: 'live', version: 'test-version' });
    case '/health/ready': return success(response, { service: 'api-server', status: 'ready', version: 'test-version' });
    case '/api/v1/me/status':
      if (!request.headers.authorization) return json(response, { success: false, error: { code: 'UNAUTHORIZED', message: 'unauthorized', userMessageKey: 'api.error.UNAUTHORIZED', retryable: false }, traceId: 'smoke-fixture' }, 401);
      return success(response, { user: { userId, displayName: privateText, phoneMasked: '138****0000' },
        workspace: { workspaceId, status: 'ready', lastSyncedAt: '2026-11-15T00:00:00.000Z' },
        timeZone: 'Asia/Shanghai' });
    case '/api/v1/workspaces': return success(response, { items: [{ workspaceId, displayName: privateText, state: 'ready', isDefault: true, etag: 'fixture-etag' }] });
    case '/api/v1/tasks/running': return success(response, { items: [] });
    default: return json(response, { error: 'unexpected route' }, 404);
  }
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(http => new Promise<void>((resolve, reject) => {
    http.close(error => error ? reject(error) : resolve()); http.closeAllConnections();
  })));
});

describe('bounded production smoke tooling with loopback HTTP fixtures', () => {
  it('makes exactly six sequential GET requests, checks real response contracts and limits credential use', async () => {
    const requests: RecordedRequest[] = [];
    let inFlight = 0, peak = 0;
    const baseUrl = await server((request, response) => {
      requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
      inFlight++; peak = Math.max(peak, inFlight);
      setTimeout(() => { inFlight--; normal(request, response); }, 5);
    });
    const result = await runSmoke(readSmokeConfig(env(baseUrl)));
    expect(result.status).toBe('passed'); expect(result.requestCount).toBe(6);
    expect(result.checks).toHaveLength(6); expect(peak).toBe(1);
    expect(requests.map(request => request.method)).toEqual(Array(6).fill('GET'));
    expect(requests.map(request => request.path)).toEqual(['/health/live', '/health/ready', '/api/v1/me/status', '/api/v1/me/status', '/api/v1/workspaces', '/api/v1/tasks/running']);
    expect(requests.map(request => request.authorization)).toEqual([undefined, undefined, undefined, `Bearer ${token}`, `Bearer ${token}`, `Bearer ${token}`]);
    const report = JSON.stringify(result);
    for (const sensitive of [token, userId, workspaceId, privateText, baseUrl, '138****0000']) expect(report).not.toContain(sensitive);
  });

  it.each([
    ['wrong service health', '/health/ready', { success: true, data: { service: 'admin', status: 'ready' }, traceId: 'fixture' }],
    ['wrong health state', '/health/ready', { success: true, data: { service: 'api-server', status: 'live' }, traceId: 'fixture' }],
    ['wrong account', '/api/v1/me/status', { success: true, data: { user: { userId: workspaceId }, workspace: { workspaceId, status: 'ready' } }, traceId: 'fixture' }],
    ['wrong workspace', '/api/v1/workspaces', { success: true, data: { items: [{ workspaceId: userId, state: 'ready' }] }, traceId: 'fixture' }],
    ['disabled workspace', '/api/v1/workspaces', { success: true, data: { items: [{ workspaceId, state: 'disabled' }] }, traceId: 'fixture' }],
    ['malformed business list', '/api/v1/tasks/running', { success: true, data: { items: {} }, traceId: 'fixture' }],
  ])('fails on HTTP 200 with %s', async (_name, path, body) => {
    const baseUrl = await server((request, response) => {
      if (request.url === path && (path !== '/api/v1/me/status' || request.headers.authorization)) return json(response, body);
      normal(request, response);
    });
    const result = await runSmoke(readSmokeConfig(env(baseUrl)));
    expect(result.status).toBe('failed'); expect(result.checks.at(-1).status).toBe('failed');
    expect(result.requestCount).toBeLessThanOrEqual(6);
  });

  it('rejects an unprotected business endpoint even when it returns plausible account data', async () => {
    const baseUrl = await server((request, response) => {
      if (request.url === '/api/v1/me/status') return success(response, { user: { userId }, workspace: { workspaceId, status: 'ready' } });
      normal(request, response);
    });
    const result = await runSmoke(readSmokeConfig(env(baseUrl)));
    expect(result.status).toBe('failed'); expect(result.requestCount).toBe(3);
  });

  it('does not follow redirects or forward the bearer to another origin', async () => {
    const received: string[] = [];
    const destination = await server((request, response) => { received.push(request.headers.authorization ?? 'anonymous'); normal(request, response); });
    const baseUrl = await server((request, response) => {
      if (request.url === '/api/v1/me/status' && request.headers.authorization) {
        response.writeHead(302, { location: destination + '/api/v1/me/status' }); response.end(); return;
      }
      normal(request, response);
    });
    const result = await runSmoke(readSmokeConfig(env(baseUrl)));
    expect(result.status).toBe('failed'); expect(received).toEqual([]); expect(result.requestCount).toBe(4);
  });

  it('bounds chunked response bytes without trusting content-length', async () => {
    let requests = 0;
    const baseUrl = await server((_request, response) => {
      requests++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"success":true,"data":"');
      response.end('x'.repeat(70_000) + '"}');
    });
    const result = await runSmoke(readSmokeConfig(env(baseUrl)));
    expect(result.status).toBe('failed'); expect(requests).toBe(1);
    expect(JSON.stringify(result).length).toBeLessThan(4096);
  });

  it('times out while receiving the body, not only while waiting for headers', async () => {
    const baseUrl = await server((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"success":true,');
    });
    const start = Date.now();
    const result = await runSmoke(readSmokeConfig({ ...env(baseUrl), SMOKE_REQUEST_TIMEOUT_MS: '100' }));
    expect(result.status).toBe('failed'); expect(result.requestCount).toBe(1);
    expect(Date.now() - start).toBeLessThan(2500);
  });

  it('enforces the total deadline across individually fast responses', async () => {
    let requests = 0;
    const baseUrl = await server((request, response) => { requests++; setTimeout(() => normal(request, response), 70); });
    const result = await runSmoke(readSmokeConfig({ ...env(baseUrl), SMOKE_REQUEST_TIMEOUT_MS: '1000', SMOKE_TOTAL_TIMEOUT_MS: '150' }));
    expect(result.status).toBe('failed'); expect(requests).toBeLessThan(6);
  });

  it.each([
    ['SMOKE_BASE_URL', 'http://production.example'], ['SMOKE_BASE_URL', 'https://user:password@example.com'],
    ['SMOKE_BASE_URL', 'https://example.com/private'], ['SMOKE_BASE_URL', 'https://example.com/?token=secret'],
    ['SMOKE_BASE_URL', 'https://example.com/#secret'], ['SMOKE_ACCESS_TOKEN', ''], ['SMOKE_ACCESS_TOKEN', 'invalid\r\nsecret'],
    ['SMOKE_USER_ID', ''], ['SMOKE_WORKSPACE_ID', 'not-a-uuid'],
    ['SMOKE_REQUEST_TIMEOUT_MS', '5001'], ['SMOKE_REQUEST_TIMEOUT_MS', '0'], ['SMOKE_TOTAL_TIMEOUT_MS', '30001'],
  ])('rejects unsafe or incomplete configuration: %s=%s', (key, value) => {
    expect(() => readSmokeConfig({ ...env('https://example.com'), [key]: value })).toThrow();
  });

  it('CLI returns a nonzero exit and never prints response bodies or credentials', async () => {
    const baseUrl = await server((_request, response) => json(response, { error: privateText, token, userId }, 500));
    const result = await cli(env(baseUrl));
    expect(result.code).not.toBe(0); expect(result.output).toContain('failed');
    for (const sensitive of [privateText, token, userId, baseUrl]) expect(result.output).not.toContain(sensitive);
    expect(result.output.length).toBeLessThan(4096);
  });

  it('CLI succeeds only after all checks pass', async () => {
    const requests: string[] = [];
    const baseUrl = await server((request, response) => { requests.push(request.url!); normal(request, response); });
    const result = await cli(env(baseUrl));
    expect(result.code).toBe(0); expect(result.output).toContain('passed'); expect(requests).toHaveLength(6);
    expect(result.output).not.toContain(token); expect(result.output).not.toContain(privateText);
  });

  it('CLI fails before making requests if required credentials are absent', async () => {
    let requests = 0;
    const baseUrl = await server((request, response) => { requests++; normal(request, response); });
    const result = await cli({ ...env(baseUrl), SMOKE_ACCESS_TOKEN: '' });
    expect(result.code).not.toBe(0); expect(requests).toBe(0); expect(result.output.length).toBeLessThan(4096);
  });
});
