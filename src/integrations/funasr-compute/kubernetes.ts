import { readFile } from 'node:fs/promises';
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import { request as requestHttps, type RequestOptions } from 'node:https';

export interface KubernetesRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

export type KubernetesTransport = (request: KubernetesRequest) => Promise<unknown>;

export class KubernetesApiError extends Error {
  constructor(readonly status?: number) {
    super(status === undefined ? 'Kubernetes API request failed' : `Kubernetes API returned HTTP ${status}`);
    this.name = 'KubernetesApiError';
  }
}

export interface KubernetesConnection {
  apiUrl: string;
  caFile: string;
  tokenFile?: string;
  clientCertificateFile?: string;
  clientKeyFile?: string;
  requestTimeoutMs?: number;
}

const defaultTimeoutMs = 10_000;
const maxBodyBytes = 4 * 1024 * 1024;
const allowedMethods = new Set(['GET', 'POST', 'PUT', 'DELETE']);

function validFilePath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

function send(url: URL, options: RequestOptions, body?: string) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = requestHttps(url, options, resolve);
    request.once('error', reject);
    request.end(body);
  });
}

async function readJson(response: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const bytes: Buffer = chunk;
    size += bytes.length;
    if (size > maxBodyBytes) throw new KubernetesApiError();
    chunks.push(bytes);
  }
  return size === 0 ? undefined : JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

export function createKubernetesTransport(connection: KubernetesConnection): KubernetesTransport {
  if (!connection || typeof connection !== 'object') throw new KubernetesApiError();
  const { apiUrl, caFile, tokenFile, clientCertificateFile, clientKeyFile } = connection;
  const timeoutMs = connection.requestTimeoutMs ?? defaultTimeoutMs;
  const origin = typeof apiUrl === 'string' ? URL.parse(apiUrl) : null;
  if (!origin || origin.protocol !== 'https:' || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash || !validFilePath(caFile)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new KubernetesApiError();
  }

  let credential: { kind: 'bearer'; tokenFile: string }
    | { kind: 'mtls'; clientCertificateFile: string; clientKeyFile: string };
  if (validFilePath(tokenFile) && clientCertificateFile === undefined && clientKeyFile === undefined) {
    credential = { kind: 'bearer', tokenFile };
  } else if (tokenFile === undefined && validFilePath(clientCertificateFile) && validFilePath(clientKeyFile)) {
    credential = { kind: 'mtls', clientCertificateFile, clientKeyFile };
  } else {
    throw new KubernetesApiError();
  }

  return async input => {
    try {
      const { method, path, body, signal: callerSignal } = input;
      if (!allowedMethods.has(method) || typeof path !== 'string' || !path.startsWith('/')
        || path.startsWith('//') || /[\\#\p{Cc}]/u.test(path)) {
        throw new KubernetesApiError();
      }
      const url = new URL(path, origin);
      if (url.origin !== origin.origin) throw new KubernetesApiError();

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
      signal.throwIfAborted();

      const headers: OutgoingHttpHeaders = { accept: 'application/json' };
      let json: string | undefined;
      if (body !== undefined) {
        json = JSON.stringify(body);
        if (json === undefined) throw new KubernetesApiError();
        const bytes = Buffer.byteLength(json);
        if (bytes > maxBodyBytes) throw new KubernetesApiError();
        headers['content-type'] = 'application/json';
        headers['content-length'] = bytes;
      }

      const options: RequestOptions = {
        method,
        headers,
        agent: false,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        signal,
        ca: await readFile(caFile, { signal }),
      };
      if (credential.kind === 'bearer') {
        const token = (await readFile(credential.tokenFile, { encoding: 'utf8', signal })).trim();
        if (!/^[a-zA-Z0-9._~+/-]+=*$/u.test(token)) throw new KubernetesApiError();
        headers.authorization = `Bearer ${token}`;
      } else {
        [options.cert, options.key] = await Promise.all([
          readFile(credential.clientCertificateFile, { signal }),
          readFile(credential.clientKeyFile, { signal }),
        ]);
      }

      const response = await send(url, options, json);
      const status = response.statusCode;
      if (status === undefined || status < 200 || status >= 300) {
        response.destroy();
        throw new KubernetesApiError(status);
      }
      return await readJson(response);
    } catch (error) {
      if (error instanceof KubernetesApiError) throw error;
      throw new KubernetesApiError();
    }
  };
}
