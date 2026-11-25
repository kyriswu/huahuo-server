import { createPrivateKey } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { RequestListener } from 'node:http';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates, type TLSSocket } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKubernetesTransport, KubernetesApiError } from '../../src/integrations/funasr-compute/kubernetes.js';

const podPath = '/api/v1/namespaces/funasr/pods';
const servers: Server[] = [];
let directory: string;
let caFile: string;
let tokenFile: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'huahuo-kubernetes-test-'));
  caFile = join(directory, 'ca.pem');
  tokenFile = join(directory, 'token');
  await Promise.all([writeFile(caFile, localhostCertificate), writeFile(tokenFile, 'fixture-one\n')]);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
  await rm(directory, { recursive: true, force: true });
});

async function listen(handler: RequestListener, requestCert = false) {
  const server = createServer({
    cert: localhostCertificate,
    key: localhostKey,
    ca: localhostCertificate,
    requestCert,
    rejectUnauthorized: requestCert,
  }, handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('LOOPBACK_REQUIRED');
  return `https://127.0.0.1:${address.port}`;
}

describe('Kubernetes transport with loopback HTTPS', () => {
  it('sends JSON over verified TLS and reads the latest bearer token for each request', async () => {
    const credentials: Array<string | undefined> = [];
    const apiUrl = await listen(async (request, response) => {
      credentials.push(request.headers.authorization);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        method: request.method,
        path: request.url,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
      }));
    });
    const transport = createKubernetesTransport({ apiUrl, caFile, tokenFile });
    const body = { preconditions: { uid: 'existing-pod' } };
    await expect(transport({ method: 'DELETE', path: `${podPath}/requested`, body })).resolves.toEqual({
      method: 'DELETE',
      path: `${podPath}/requested`,
      body,
    });
    await writeFile(tokenFile, 'fixture-two\n');
    const path = `${podPath}?labelSelector=managed%3Dtrue`;
    await expect(transport({ method: 'GET', path })).resolves.toEqual({ method: 'GET', path });
    expect(credentials).toEqual(['Bearer fixture-one', 'Bearer fixture-two']);
  });

  it('supports mutual TLS with no Authorization header and rejects mixed credentials', async () => {
    const clientKeyFile = join(directory, 'key.pem');
    await writeFile(clientKeyFile, localhostKey, { mode: 0o600 });
    const apiUrl = await listen((request, response) => {
      response.end(JSON.stringify({
        clientVerified: (request.socket as TLSSocket).authorized,
        bearerSent: request.headers.authorization !== undefined,
      }));
    }, true);
    const connection = { apiUrl, caFile, clientCertificateFile: caFile, clientKeyFile };
    await expect(createKubernetesTransport(connection)({ method: 'GET', path: podPath }))
      .resolves.toEqual({ clientVerified: true, bearerSent: false });
    expect(() => createKubernetesTransport({ ...connection, tokenFile })).toThrow(KubernetesApiError);
    expect(() => createKubernetesTransport({ apiUrl, caFile, clientKeyFile })).toThrow(KubernetesApiError);
  });

  it('keeps credentials on the configured origin and does not follow redirects', async () => {
    const otherOrigin = vi.fn<RequestListener>((_request, response) => response.end('{}'));
    const target = await listen(otherOrigin);
    const apiUrl = await listen((_request, response) => {
      response.writeHead(307, { location: `${target}${podPath}` });
      response.end();
    });
    const transport = createKubernetesTransport({ apiUrl, caFile, tokenFile });
    await expect(transport({ method: 'GET', path: target + podPath }))
      .rejects.toBeInstanceOf(KubernetesApiError);
    await expect(transport({ method: 'GET', path: `//${new URL(target).host}${podPath}` }))
      .rejects.toBeInstanceOf(KubernetesApiError);
    await expect(transport({ method: 'GET', path: podPath }))
      .rejects.toMatchObject({ status: 307 });
    expect(otherOrigin).not.toHaveBeenCalled();
  });

  it('preserves HTTP status without including the Kubernetes error body or file paths', async () => {
    const apiUrl = await listen((_request, response) => {
      response.writeHead(409).end('upstream private details');
    });
    const transport = createKubernetesTransport({ apiUrl, caFile, tokenFile });
    await expect(transport({ method: 'POST', path: podPath, body: {} })).rejects.toMatchObject({
      status: 409,
      message: 'Kubernetes API returned HTTP 409',
    });
    await rm(tokenFile);
    await expect(transport({ method: 'GET', path: podPath })).rejects.toMatchObject({
      status: undefined,
      message: 'Kubernetes API request failed',
    });
  });

  it('rejects an untrusted server certificate before sending the request', async () => {
    const handler = vi.fn<RequestListener>((_request, response) => response.end('{}'));
    const apiUrl = await listen(handler);
    await writeFile(caFile, rootCertificates[0]!);
    const transport = createKubernetesTransport({ apiUrl, caFile, tokenFile });
    await expect(transport({ method: 'GET', path: podPath })).rejects.toMatchObject({ status: undefined });
    expect(handler).not.toHaveBeenCalled();
  });

  it('bounds a stalled response, honors cancellation, and rejects oversized response bodies', async () => {
    const apiUrl = await listen((request, response) => {
      response.writeHead(200);
      response.flushHeaders();
      if (request.url?.endsWith('/large')) {
        response.end(Buffer.alloc(4 * 1024 * 1024 + 1));
        return;
      }
      response.write('{');
    });
    const transport = createKubernetesTransport({ apiUrl, caFile, tokenFile, requestTimeoutMs: 200 });
    await expect(transport({ method: 'GET', path: podPath })).rejects.toMatchObject({ status: undefined });
    const longTimeout = createKubernetesTransport({ apiUrl, caFile, tokenFile });
    await expect(longTimeout({ method: 'GET', path: podPath, signal: AbortSignal.abort('private reason') }))
      .rejects.toMatchObject({ status: undefined, message: 'Kubernetes API request failed' });
    await expect(longTimeout({ method: 'GET', path: `${podPath}/large` }))
      .rejects.toMatchObject({ status: undefined });
  });
});

// Self-signed test fixture for 127.0.0.1. This key has no access outside this test.
const localhostCertificate = `-----BEGIN CERTIFICATE-----
MIIBpDCCAUqgAwIBAgICBBIwCgYIKoZIzj0EAwIwKTEnMCUGA1UEAwweQUNTIGFk
YXB0ZXIgbG9vcGJhY2sgdGVzdCBvbmx5MB4XDTIwMDEwMTAwMDAwMFoXDTQwMDEw
MTAwMDAwMFowKTEnMCUGA1UEAwweQUNTIGFkYXB0ZXIgbG9vcGJhY2sgdGVzdCBv
bmx5MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEd5ltVQJthjdVBSDnvto+/58t
0Wl7zX1vQ7nKYoewQSu6a0bcYrRoL/UHmvF4Cf6lWAsyTxKzcB2KFMkbMtKGZKNi
MGAwHQYDVR0OBBYEFOEE6CZu5+1xaKLsplRtIGIJ574BMA8GA1UdEwEB/wQFMAMB
Af8wDwYDVR0RBAgwBocEfwAAATAdBgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUH
AwIwCgYIKoZIzj0EAwIDSAAwRQIgd4jtIOkYV3jjDCNq/Sns3YJxDnygwsLQFR+J
Q6Wz+ToCIQDOI3smpZnMGst2yWqATSgXhuPZ7ecXIHiMm5xslIufFA==
-----END CERTIFICATE-----
`;
const localhostKey = createPrivateKey({
  key: Buffer.from('MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgaZUqyyIChqtNDbRh'
    + 'laSORBt/xqxgTGUK5B+dBlIWgz+hRANCAAR3mW1VAm2GN1UFIOe+2j7/ny3RaXvN'
    + 'fW9Ducpih7BBK7prRtxitGgv9Qea8XgJ/qVYCzJPErNwHYoUyRsy0oZk', 'base64'),
  format: 'der',
  type: 'pkcs8',
}).export({ format: 'pem', type: 'pkcs8' });
