/** Container-local probe; actual role /health/ready handler is implemented in P01/P03. */
const input = process.env.HEALTHCHECK_URL;
try {
  if (!input) throw new Error('Missing HEALTHCHECK_URL');
  const url = new URL(input);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Health probe must target loopback HTTP');
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!response.ok) throw new Error(`Readiness returned ${response.status}`);
  const status = await response.json();
  if (status.status !== 'ok' || status.service !== process.env.SERVICE_ROLE) {
    throw new Error('Readiness role/state mismatch');
  }
  process.exitCode = 0;
} catch {
  // Do not dump response bodies, connection strings or credentials in Docker health logs.
  console.error('Container readiness probe failed');
  process.exitCode = 1;
}
