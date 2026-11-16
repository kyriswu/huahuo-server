import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
// @ts-expect-error Legacy HTTP suites intentionally use dependency-free JavaScript.
import { createApiRequest } from '../e2e/api-request.mjs';

const userId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const servers: Server[] = [];
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  })));
});

describe('legacy isolated HTTP gateway adapter', () => {
  it('authenticates first and forwards only the returned identity, never caller claims or credentials', async () => {
    const requests: IncomingMessage[] = [];
    const base = await listen((req, res) => {
      requests.push(req);
      if (req.url === '/internal/v1/gateway/auth') {
        res.writeHead(204, { 'x-huahuo-user-id': userId, 'x-huahuo-session-id': sessionId, 'x-huahuo-auth-method': 'bearer', 'x-trace-id': 'real-trace' }); res.end();
      } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(req.headers)); }
    });
    const request = createApiRequest(base, { admissionMode: 'isolated-auth-subrequest' });
    const result = await request('/api/v1/tasks/demo?fixture=1', { method: 'POST', headers: { Authorization: 'Bearer fixture', Cookie: 'private-cookie', 'X-Huahuo-User-Id': 'forged', 'X-Huahuo-Session-Id': 'forged', 'X-Huahuo-Service-Key': 'retired', 'X-Idempotency-Key': 'task-key' }, body: '{}' });
    expect(result.status).toBe(200);
    expect(requests.map(req => req.url)).toEqual(['/internal/v1/gateway/auth', '/api/v1/tasks/demo?fixture=1']);
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.headers).toMatchObject({ authorization: 'Bearer fixture', 'x-forwarded-method': 'POST', 'x-forwarded-uri': '/api/v1/tasks/demo?fixture=1' });
    expect(requests[0]!.headers['x-huahuo-user-id']).toBeUndefined();
    const forwarded = await result.json();
    expect(forwarded).toMatchObject({ 'x-huahuo-user-id': userId, 'x-huahuo-session-id': sessionId, 'x-huahuo-auth-method': 'bearer', 'x-trace-id': 'real-trace', 'x-idempotency-key': 'task-key' });
    for (const header of ['authorization', 'cookie', 'x-huahuo-service-key']) expect(forwarded[header]).toBeUndefined();
  });
  it('cannot admit a request with only forged identity headers', async () => {
    const paths: string[] = [];
    const base = await listen((req, res) => {
      paths.push(req.url!); expect(req.headers.authorization).toBeUndefined(); expect(req.headers['x-huahuo-user-id']).toBeUndefined();
      res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"UNAUTHORIZED"}');
    });
    const result = await createApiRequest(base, { admissionMode: 'isolated-auth-subrequest' })('/api/v1/me/status', { headers: { 'X-Huahuo-User-Id': userId, 'X-Huahuo-Session-Id': sessionId, 'X-Huahuo-Auth-Method': 'bearer' } });
    expect(result.status).toBe(401); expect(paths).toEqual(['/internal/v1/gateway/auth']);
  });
  it.each([401, 403, 503, 302])('returns admission status %s without reaching business routes or following a redirect', async status => {
    let count = 0;
    const base = await listen((_req, res) => { count++; res.writeHead(status, { location: '/unexpected' }); res.end(); });
    const result = await createApiRequest(base, { admissionMode: 'isolated-auth-subrequest' })('/api/v1/me/status', { headers: { authorization: 'Bearer fixture' } });
    expect(result.status).toBe(status); expect(count).toBe(1);
  });
  it('rejects incomplete successful admission', async () => {
    let count = 0;
    const base = await listen((_req, res) => { count++; res.writeHead(204, { 'x-huahuo-user-id': userId }); res.end(); });
    await expect(createApiRequest(base, { admissionMode: 'isolated-auth-subrequest' })('/api/v1/me/status')).rejects.toThrow('TEST_GATEWAY_IDENTITY_MISSING');
    expect(count).toBe(1);
  });
  it('leaves login/refresh and health under their own protocol while stripping forged identity in adapter mode', async () => {
    const paths: string[] = [];
    const base = await listen((req, res) => { paths.push(req.url!); expect(req.headers['x-huahuo-user-id']).toBeUndefined(); res.writeHead(200); res.end(); });
    const request = createApiRequest(base, { admissionMode: 'isolated-auth-subrequest' });
    for (const path of ['/health/ready', '/api/v1/auth/login', '/api/v1/auth/refresh', '/api/v1/auth/sms-code']) {
      expect((await request(path, { headers: { 'X-Huahuo-User-Id': 'forged' } })).status).toBe(200);
    }
    expect(paths).toHaveLength(4); expect(paths).not.toContain('/internal/v1/gateway/auth');
  });
  it('defaults to the actual gateway and preserves external spoofing attempts for gateway validation', async () => {
    const paths: string[] = [];
    const base = await listen((req, res) => {
      paths.push(req.url!); expect(req.headers.authorization).toBe('Bearer fixture'); expect(req.headers['x-huahuo-user-id']).toBe('forged');
      // An actual gateway, rather than this transport, is responsible for stripping it.
      res.writeHead(200); res.end();
    });
    expect((await createApiRequest(base)('/api/v1/me/status', { headers: { authorization: 'Bearer fixture', 'x-huahuo-user-id': 'forged' } })).status).toBe(200);
    expect(paths).toEqual(['/api/v1/me/status']);
  });
  it('requires explicit adapter mode and does not allow absolute request targets', async () => {
    expect(() => createApiRequest('http://localhost', { admissionMode: 'unknown' })).toThrow('TEST_API_ADMISSION_MODE_INVALID');
    const request = createApiRequest('http://localhost');
    for (const path of ['https://other.test/api/v1/me/status', '//other.test/api/v1/me/status']) await expect(request(path)).rejects.toThrow('TEST_API_PATH_INVALID');
  });
});
