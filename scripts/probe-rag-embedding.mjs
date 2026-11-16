import { lookup } from 'node:dns';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { BailianEmbeddingClient } = await import(pathToFileURL(resolve('dist/modules/rag/adapters/embedding.js')).href);

// Run inside the API container as well as on the host. Credentials stay in the
// environment; reports contain only synthetic request hashes and timing data.
const env = process.env;
if (env.APP_ENV === 'production' || env.EMBEDDING_PROBE_ALLOW !== 'true') throw new Error('NON_PRODUCTION_PROBE_AUTHORIZATION_REQUIRED');
const {loadConfig}=await import(pathToFileURL(resolve('dist/config/config.js')).href);
const {poolFor}=await import(pathToFileURL(resolve('dist/plugins/dependencies.js')).href);
const {RuntimeSettings}=await import(pathToFileURL(resolve('dist/modules/runtime-settings/service.js')).href);
const {applyValues}=await import(pathToFileURL(resolve('dist/modules/runtime-settings/registry.js')).href);
const base=loadConfig('api-server',env),pool=poolFor(base);
let runtime;
try{const state=await new RuntimeSettings(pool,base).load();runtime=applyValues(base,state.values,state.revision);}finally{await pool.end();}
const endpoint = new URL(`${env.RAG_EMBEDDING_BASE_URL?.replace(/\/$/u, '')}/services/embeddings/text-embedding/text-embedding`);
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || !env.RAG_EMBEDDING_API_KEY) throw new Error('EMBEDDING_PROBE_CONFIG_REQUIRED');
const input = 'PostgreSQL MVCC 花火 Note latency probe';
const body = JSON.stringify({ model: env.RAG_EMBEDDING_MODEL, input: { texts: [input] }, parameters: { text_type: 'document' } });
const count = Number(env.EMBEDDING_PROBE_COUNT ?? 3);
if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('PROBE_COUNT_INVALID');
const proxy = key => { try { const u = new URL(env[key]); return `${u.protocol}//${u.hostname}:${u.port}`; } catch { return env[key] ? 'configured' : null; } };
console.log(JSON.stringify({ event: 'config', environment: env.APP_ENV, endpoint: endpoint.origin + endpoint.pathname, model: env.RAG_EMBEDDING_MODEL, dimensions: Number(env.RAG_EMBEDDING_DIMENSIONS), requestHash: createHash('sha256').update(body).digest('hex'), bodyBytes: Buffer.byteLength(body), node: process.version, nodeUseEnvProxy: env.NODE_USE_ENV_PROXY ?? null, proxies: Object.fromEntries(['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'grpc_proxy'].map(key => [key, proxy(key)])) }));
if (env.NODE_USE_ENV_PROXY === '1' && (env.HTTPS_PROXY || env.https_proxy)) throw new Error('NATIVE_PROBE_DIRECT_ONLY_USE_ADAPTER_TIMINGS_FOR_PROXY');
const agent = new https.Agent({ keepAlive: true });
try {
  for (let attempt = 0; attempt < count; attempt++) {
    const start = performance.now();
    const timing = { event: 'transport', attempt, reusedSocket: false, dnsMs: 0, connectMs: 0, tlsMs: 0, firstByteMs: 0, totalMs: 0, status: 0 };
    await new Promise(resolve => {
      let dnsAt = start, tcpAt = start;
      const request = https.request(endpoint, { agent, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${env.RAG_EMBEDDING_API_KEY}` }, lookup(host, options, callback) { const began = performance.now(); lookup(host, options, (...args) => { dnsAt = performance.now(); timing.dnsMs = dnsAt - began; callback(...args); }); } }, response => {
        timing.status = response.statusCode;
        timing.reusedSocket = request.reusedSocket;
        timing.firstByteMs = performance.now() - start;
        let bytes = 0;
        response.on('data', part => { bytes += part.length; });
        response.on('end', () => { timing.totalMs = performance.now() - start; timing.responseBytes = bytes; console.log(JSON.stringify(timing)); resolve(); });
        response.on('error', () => { timing.totalMs = performance.now() - start; timing.error = 'RESPONSE_FAILED'; console.log(JSON.stringify(timing)); resolve(); });
      });
      request.on('socket', socket => {
        if (!socket.connecting) return;
        socket.once('connect', () => { tcpAt = performance.now(); timing.connectMs = tcpAt - dnsAt; });
        socket.once('secureConnect', () => { timing.tlsMs = performance.now() - tcpAt; });
      });
      request.setTimeout(runtime.rag.embeddingTimeoutMs, () => request.destroy(new Error('PROBE_TIMEOUT')));
      request.on('error', error => { timing.totalMs = performance.now() - start; timing.error = error.code ?? 'TRANSPORT_FAILED'; console.log(JSON.stringify(timing)); resolve(); });
      request.end(body);
    });
  }
} finally { agent.destroy(); }
for (let call = 0; call < count; call++) {
  const start = performance.now();
  let attempt = 0;
  const client = new BailianEmbeddingClient({ baseUrl: env.RAG_EMBEDDING_BASE_URL, apiKey: env.RAG_EMBEDDING_API_KEY, model: env.RAG_EMBEDDING_MODEL, dimensions: Number(env.RAG_EMBEDDING_DIMENSIONS), timeoutMs: runtime.rag.embeddingTimeoutMs, maxRetries: runtime.rag.embeddingMaxRetries, fetchImpl: async (...args) => {
    const at = performance.now();
    try {
      const response = await fetch(...args);
      const headerMs = performance.now() - at;
      const bytes = await response.arrayBuffer();
      console.log(JSON.stringify({ event: 'adapter_attempt', call, attempt: attempt++, status: response.status, firstByteMs: headerMs, totalMs: performance.now() - at, responseBytes: bytes.byteLength }));
      return new globalThis.Response(bytes, { status: response.status, headers: response.headers });
    } catch (error) { console.log(JSON.stringify({ event: 'adapter_attempt', call, attempt: attempt++, error: error.cause?.code ?? error.name, totalMs: performance.now() - at })); throw error; }
  } });
  try { const vectors = await client.embed([input]); console.log(JSON.stringify({ event: 'adapter_call', call, totalMs: performance.now() - start, attempts: attempt, dimensions: vectors[0]?.length })); }
  catch (error) { console.log(JSON.stringify({ event: 'adapter_call', call, totalMs: performance.now() - start, attempts: attempt, error: error.code ?? 'EMBEDDING_FAILED' })); }
}
