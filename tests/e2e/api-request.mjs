/** Test-only client adapter for the legacy isolated HTTP suites. Their temporary
 * API containers do not include an ingress. Explicit adapter mode executes the real
 * authentication callback before forwarding its identity to the business handler.
 * Normal clients keep using Bearer tokens against the actual gateway. */
export function createApiRequest(baseUrl, { admissionMode = 'gateway', fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error('TEST_API_URL_REQUIRED');
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('TEST_API_URL_INVALID');
  if (!['gateway', 'isolated-auth-subrequest'].includes(admissionMode)) throw new Error('TEST_API_ADMISSION_MODE_INVALID');
  const publicApi = new Set(['/api/v1/auth/sms-code', '/api/v1/auth/login', '/api/v1/auth/refresh']);
  return async (path, options = {}) => {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error('TEST_API_PATH_INVALID');
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new Error('TEST_API_PATH_INVALID');
    const headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    // Only the isolated adapter stands in for gateway cleanup. Gateway mode
    // sends the original headers so external spoofing checks test the gateway.
    if (admissionMode === 'isolated-auth-subrequest') {
      for (const name of Object.keys(headers)) if (name.startsWith('x-huahuo-')) delete headers[name];
    }
    if (admissionMode === 'isolated-auth-subrequest' && url.pathname.startsWith('/api/v1/') && !publicApi.has(url.pathname)) {
      const authHeaders = { 'x-forwarded-method': options.method ?? 'GET', 'x-forwarded-uri': url.pathname + url.search };
      for (const name of ['authorization', 'cookie', 'origin', 'accept', 'x-trace-id']) if (headers[name] !== undefined) authHeaders[name] = headers[name];
      const admission = await fetchImpl(new URL('/internal/v1/gateway/auth', base), { method: 'GET', headers: authHeaders, redirect: 'manual', signal: options.signal });
      if (admission.status !== 204) return admission;
      for (const name of ['x-huahuo-user-id', 'x-huahuo-session-id', 'x-huahuo-auth-method']) {
        const value = admission.headers.get(name);
        if (!value) throw new Error('TEST_GATEWAY_IDENTITY_MISSING');
        headers[name] = value;
      }
      const trace = admission.headers.get('x-trace-id');
      if (trace) headers['x-trace-id'] = trace;
      delete headers.authorization;
      delete headers.cookie;
    }
    return fetchImpl(url, { ...options, headers, redirect: 'manual' });
  };
}
