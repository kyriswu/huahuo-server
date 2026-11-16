import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Local assertions only. Model-list authorization was checked separately;
// inference and PrivateLink access are not proven by these assertions.
export function verifyQwenConfiguration(env, network = 'private') {
  if (!['api-server', 'admin', 'worker', 'scheduler', 'migrate'].includes(env.SERVICE_ROLE)) throw new Error('QWEN_ROLE_REQUIRED');
  const expected = {
    RAG_EMBEDDING_MODEL: 'qwen3.7-text-embedding-flash',
    RAG_EMBEDDING_DIMENSIONS: '1024',
    RAG_EMBEDDING_PROFILE: 'qwen3.7-text-embedding-flash-1024-fp16',
    RAG_RERANK_MODEL: 'qwen3.7-text-rerank',
    RAG_PROVIDER_MODE: 'live',
    RAG_RERANK_PROVIDER: 'http',
  };
  if (env.SERVICE_ROLE === 'migrate') return;
  for (const [key, value] of Object.entries(expected)) if (env[key] !== value) throw new Error('QWEN_CONFIGURATION_TARGET_MISMATCH');
  if (!['private', 'public'].includes(network)) throw new Error('QWEN_NETWORK_INVALID');
  const urls = ['RAG_EMBEDDING_BASE_URL', 'RAG_RERANK_BASE_URL'].map(key => new URL(env[key]));
  for (const url of urls) {
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port
      || url.pathname !== '/api/v1' || !/^ws-[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(url.hostname)
      || url.hostname.includes('-vpc-') !== (network === 'private')) throw new Error('QWEN_ENDPOINT_TARGET_MISMATCH');
  }
  if (urls[0].href !== urls[1].href) throw new Error('QWEN_ENDPOINT_MISMATCH');
  if (['api-server', 'worker'].includes(env.SERVICE_ROLE)) {
    for (const key of ['RAG_EMBEDDING_API_KEY', 'RAG_RERANK_API_KEY']) if (!/^sk-[\x21-\x7e]+$/.test(env[key] ?? '')) throw new Error('QWEN_CREDENTIAL_REQUIRED');
    if (env.RAG_EMBEDDING_API_KEY !== env.RAG_RERANK_API_KEY) throw new Error('QWEN_CREDENTIAL_MISMATCH');
  }
}

// Release-specific ingress contract; general application URL configuration stays flexible.
export function verifyIngressConfiguration(env) {
  if (env.SERVICE_ROLE !== 'api-server') return;
  if (!['test', 'production'].includes(env.APP_ENV)) throw new Error('INGRESS_ENV_INVALID');
  if (env.HTTP_TRUST_PROXY_HOPS !== '1') throw new Error('INGRESS_PROXY_HOPS_INVALID');
  if (env.HUAHUO_AGENT_PUBLIC_PATH !== '/agent') throw new Error('INGRESS_AGENT_PATH_INVALID');
  const enabled = env.HUAHUO_STUDIO_AUTH_ENABLED;
  if (!['true', 'false'].includes(enabled)) throw new Error('INGRESS_STUDIO_FLAG_INVALID');
  if (env.APP_ENV === 'test') {
    if (enabled !== 'true') throw new Error('INGRESS_TEST_STUDIO_REQUIRED');
    if (env.APP_PUBLIC_BASE_URL !== 'https://test-api.chuda.cc'
      || env.HUAHUO_STUDIO_ORIGIN !== 'https://test-api.chuda.cc') throw new Error('INGRESS_TEST_ORIGIN_INVALID');
  } else if (enabled !== 'false') throw new Error('INGRESS_PRODUCTION_STUDIO_FORBIDDEN');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { verifyQwenConfiguration(process.env); verifyIngressConfiguration(process.env); }
  catch { process.stderr.write('RELEASE_CONFIGURATION_INVALID\n'); process.exitCode = 1; }
}
