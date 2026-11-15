import type { QueueName } from '../modules/tasks/model.js';
import { loadMetricsConfig, type MetricsConfig } from './metrics.js';
import { loadApiServiceBaseUrl } from './service-addresses.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadAliyunOtpConfig, type AliyunOtpConfig } from './sms.js';
import { loadProcessingNodesConfig, type ProcessingNodesConfig } from './processing-nodes.js';
import { scopedConfig } from '../modules/runtime-settings/service.js';
export type Role = 'api-server' | 'admin' | 'worker' | 'scheduler' | 'migrate';
export type Env = Record<string, string | undefined>;
export interface AppConfig {
  metrics: MetricsConfig;
  processingNodes: ProcessingNodesConfig;
  runtimeRevision: number;
  uploadHardMaxBytes: number;
  taskPolicy: { maxAttempts:number;retryBaseMs:number;retryMaxMs:number;concurrency:Record<QueueName,number> };
  queuePrefix:string; workerQueues:QueueName[]; taskLeaseMs:number; taskRedeliveryMs:number; schedulerIntervalMs:number; demoTasks:boolean; testTaskDelayMs:number;
  role: Role; host: string; port: number; databaseUrl: string; poolMax: number;
  httpRequestTimeoutMs: number; httpConnectionTimeoutMs: number;
  shutdownTimeoutMs: number;
  ssl: false | { rejectUnauthorized: true; ca?: string };
  statementTimeout: number; redisCacheUrl: string; redisQueueUrl: string;
  schemaMinVersion: number; instanceId: string; logLevel: string;
  connectDeadlineMs: number; migrationLockTimeoutMs: number;
  appTokenSecret?: string; adminSessionSecret?: string;
  jwt: { issuer:string; audience:string[]; serverAudience:string; keyId:string; accessTtlSeconds:number; refreshTtlSeconds:number; privateKeyPem?:string; publicKeyPem?:string; previousPublicKeyPem?:string; previousKeyId?:string };
  agentToServerServiceKey?: string; serverToAgentServiceKey?: string;
  smsProvider: 'mock' | 'disabled' | 'live'; showTestOtp: boolean;
  smsAliyun?: AliyunOtpConfig;
  appEnv: string; agreementVersion: string; privacyVersion: string; adminOrigin: string;
  billingMode: 'disabled' | 'development' | 'live'; billingPolicyVersion: string;
  storageDriver: 'local' | 's3' | 'aliyun-oss'; storageLocalRoot: string; maxUploadBytes: number;
  appPublicBaseUrl: string;
  apiServiceBaseUrl?: string;
  storageQuotaBytes:number;
  tagExtractorProvider: 'deterministic' | 'disabled' | 'llm' | 'dify';
  storageS3?: { endpoint:string; region:string; bucket:string; accessKeyId:string; secretAccessKey:string; maxBytes:number };
  storageAliyunOss?: { endpoint:string; region:string; bucket:string; accessKeyId:string; accessKeySecret:string; secure:boolean; timeoutMs:number; keyPrefix?:string; maxBytes:number };
  milvus: MilvusConfig;
  rag: RagConfig;
  kb: { noteEnabled: boolean; noteCollection: string; documentCollection: string };
}
export interface MilvusConfig {
  address?: string;
  username?: string;
  password?: string;
  database: string;
  tls: boolean;
  createIfMissing: boolean;
  searchConcurrency: number;
  denseCandidates: number;
  bm25Candidates: number;
  hybridCandidates: number;
  rrfK: number;
}
export interface RagConfig {
  tokenizerPath: string;
  tokenizerConfigPath: string;
  tokenizerMaxInputTokens: number;
  enabled: boolean;
  sourceAllowedHosts: string[];
  maxSourceBytes: number;
  plainTextMaxChars: number;
  downloadTimeoutMs: number;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingProfile: string;
  embeddingBatchSize: number;
  indexingConcurrency:number;
  embeddingTimeoutMs: number;
  embeddingMaxRetries: number;
  providerMode: 'live' | 'mock' | 'disabled';
  rerankProvider: 'disabled' | 'mock' | 'http';
  rerankBaseUrl?: string;
  rerankApiKey?: string;
  rerankModel: string;
  rerankTimeoutMs: number;
  noteRerankBudgetMs: number;
}
export function loadConfig(role: Role, env: Env = process.env): AppConfig {
  const fail = (key: string): never => { throw new Error(`INVALID_CONFIG:${key}`); };
  const required = (key: string) => env[key]?.trim() || fail(key);
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(env[key] ?? fallback);
    return Number.isInteger(value) && value >= min && value <= max ? value : fail(key);
  };
  const url = (key: string, protocols: string[]) => {
    const value = required(key);
    try { const parsed = new URL(value); if (!protocols.includes(parsed.protocol) || !parsed.hostname) fail(key); }
    catch { fail(key); }
    return value;
  };
  if (env.SERVICE_ROLE && env.SERVICE_ROLE !== role) fail('SERVICE_ROLE');
  const appEnv = env.APP_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(appEnv)) fail('APP_ENV');
  const mode = env.PROVIDER_MODE ?? 'disabled';
  if (!['disabled', 'mock', 'live'].includes(mode)) fail('PROVIDER_MODE');
  if (mode === 'mock' && (appEnv === 'production' || env.ALLOW_MOCK_PROVIDERS !== 'true')) fail('PROVIDER_MODE');
  if (env.DEV_AUTH_BYPASS === 'true' && (appEnv !== 'development' || env.ALLOW_DEV_AUTH !== 'true')) fail('DEV_AUTH_BYPASS');
  for (const key of ['PAYMENT_PROVIDER','ASR_PROVIDER','WORKFLOW_PROVIDER','SMS_PROVIDER','PUSH_PROVIDER']) {
    if (appEnv === 'production' && env[key] === 'mock') fail(key);
  }
  const databaseUrl = url('DATABASE_URL', ['postgres:', 'postgresql:']);
  const parsed = new URL(databaseUrl);
  if ([...parsed.searchParams.keys()].some(key => key.toLowerCase().startsWith('ssl'))) fail('DATABASE_URL_SSL_CONFLICT');
  const sslMode = env.DATABASE_SSL_MODE ?? 'disable';
  if (!['disable', 'verify-full'].includes(sslMode)) fail('DATABASE_SSL_MODE');
  if (appEnv === 'production' && sslMode !== 'verify-full') fail('DATABASE_SSL_MODE');
  if (sslMode === 'disable' && env.DATABASE_SSL_CA_FILE) fail('DATABASE_SSL_CA_FILE');
  let ca: string | undefined;
  if (env.DATABASE_SSL_CA_FILE) { try { ca = readFileSync(env.DATABASE_SSL_CA_FILE, 'utf8'); } catch { fail('DATABASE_SSL_CA_FILE'); } }
  if (role === 'api-server' || role === 'admin') {
    const key = role === 'api-server' ? 'APP_TOKEN_SECRET' : 'ADMIN_SESSION_SECRET';
    if (required(key).length < 32) fail(key);
    const base = role === 'api-server' ? 'APP_PUBLIC_BASE_URL' : 'ADMIN_PUBLIC_BASE_URL';
    const value = url(base, appEnv === 'production' ? ['https:'] : ['http:', 'https:']);
    if (new URL(value).username || new URL(value).password) fail(base);
  }
  const jwtPrivateKey = env.APP_JWT_PRIVATE_KEY?.trim() ? Buffer.from(env.APP_JWT_PRIVATE_KEY.trim(), 'base64').toString('utf8') : undefined;
  const jwtPublicKey = env.APP_JWT_PUBLIC_KEY?.trim() ? Buffer.from(env.APP_JWT_PUBLIC_KEY.trim(), 'base64').toString('utf8') : undefined;
  const jwtPreviousPublicKey = env.APP_JWT_PREVIOUS_PUBLIC_KEY?.trim() ? Buffer.from(env.APP_JWT_PREVIOUS_PUBLIC_KEY.trim(), 'base64').toString('utf8') : undefined;
  const jwtAudience = (env.APP_JWT_AUDIENCE?.trim() || 'huahuo-server,huahuo-agent').split(',').map(value => value.trim()).filter(Boolean);
  const jwtServerAudience = env.APP_JWT_SERVER_AUDIENCE?.trim() || 'huahuo-server';
  const jwtKeyId = env.APP_JWT_KEY_ID?.trim() || 'server-current';
  const jwtPreviousKeyId = env.APP_JWT_PREVIOUS_KEY_ID?.trim() || undefined;
  if (!jwtAudience.length || new Set(jwtAudience).size !== jwtAudience.length || jwtAudience.some(value => !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) || !jwtAudience.includes(jwtServerAudience)) fail('APP_JWT_AUDIENCE');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(jwtServerAudience)) fail('APP_JWT_SERVER_AUDIENCE');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(jwtKeyId)) fail('APP_JWT_KEY_ID');
  if ((jwtPreviousPublicKey && !jwtPreviousKeyId) || (!jwtPreviousPublicKey && jwtPreviousKeyId)) fail('APP_JWT_PREVIOUS_KEY');
  if (jwtPreviousKeyId && (!/^[A-Za-z0-9._:-]{1,128}$/.test(jwtPreviousKeyId) || jwtPreviousKeyId === jwtKeyId)) fail('APP_JWT_PREVIOUS_KEY_ID');
  if (role === 'api-server' && appEnv === 'production' && (!jwtPrivateKey || !jwtPublicKey)) fail('APP_JWT_KEYS');
  if ((jwtPrivateKey && !jwtPublicKey) || (!jwtPrivateKey && jwtPublicKey)) fail('APP_JWT_KEYS');
  const agentToServerServiceKey = env.HUAHUO_AGENT_TO_SERVER_API_KEY?.trim() || undefined;
  const serverToAgentServiceKey = env.HUAHUO_SERVER_TO_AGENT_API_KEY?.trim() || undefined;
  if (role === 'api-server' && appEnv === 'production' && (!agentToServerServiceKey || !serverToAgentServiceKey)) fail('HUAHUO_SERVICE_API_KEY');
  if ((agentToServerServiceKey && agentToServerServiceKey.length < 43) || (serverToAgentServiceKey && serverToAgentServiceKey.length < 43)) fail('HUAHUO_SERVICE_API_KEY');
  if (appEnv === 'production' && agentToServerServiceKey && serverToAgentServiceKey && agentToServerServiceKey === serverToAgentServiceKey) fail('HUAHUO_SERVICE_API_KEY_DIRECTIONAL_COLLISION');
  const smsProvider = (env.SMS_PROVIDER ?? 'disabled') as AppConfig['smsProvider'];
  if (!['mock', 'disabled', 'live'].includes(smsProvider)) fail('SMS_PROVIDER');
  if (smsProvider === 'mock' && (appEnv === 'production' || env.ALLOW_MOCK_PROVIDERS !== 'true')) fail('SMS_PROVIDER');
  if (env.SHOW_TEST_OTP === 'true' && (appEnv === 'production' || smsProvider !== 'mock')) fail('SHOW_TEST_OTP');
  const smsAliyun = role === 'api-server' && smsProvider === 'live' ? loadAliyunOtpConfig(env) : undefined;
  const billingMode = (env.BILLING_MODE ?? (appEnv === 'development' ? 'development' : 'disabled')) as AppConfig['billingMode'];
  if (!['disabled', 'development', 'live'].includes(billingMode)) fail('BILLING_MODE');
  if (appEnv === 'production' && billingMode === 'development') fail('BILLING_MODE');
  const billingPolicyVersion = 'credit-policy-v1';
  const storageDriver=(env.STORAGE_DRIVER??'local') as AppConfig['storageDriver'];
  if(!['local','s3','aliyun-oss'].includes(storageDriver))fail('STORAGE_DRIVER');
  const tagExtractorProvider:AppConfig['tagExtractorProvider']='disabled';
  const bool = (key:string, fallback:boolean): boolean => {
    const value=env[key]; if(value===undefined||value==='')return fallback;
    if(value==='true')return true; if(value==='false')return false; return fail(key);
  };
  const csv = (key:string) => (env[key]??'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
  const ragProvider=(env.RAG_PROVIDER_MODE??'disabled') as RagConfig['providerMode'];
  if(!['live','mock','disabled'].includes(ragProvider))fail('RAG_PROVIDER_MODE');
  if(ragProvider==='mock' && (appEnv==='production'||env.ALLOW_MOCK_PROVIDERS!=='true'))fail('RAG_PROVIDER_MODE');
  const rag: RagConfig = {
    tokenizerPath: env.RAG_TOKENIZER_PATH?.trim() || 'resources/tokenizers/bge-m3/tokenizer.json',
    tokenizerConfigPath: env.RAG_TOKENIZER_CONFIG_PATH?.trim() || 'resources/tokenizers/bge-m3/tokenizer_config.json',
    tokenizerMaxInputTokens: integer('RAG_TOKENIZER_MAX_INPUT_TOKENS', 8192, 8192, 8192),
    enabled: true,
    sourceAllowedHosts: csv('RAG_SOURCE_ALLOWED_HOSTS'),
    maxSourceBytes: 200*1024*1024,
    plainTextMaxChars: 50_000,
    downloadTimeoutMs: 120_000,
    ...(env.RAG_EMBEDDING_BASE_URL?.trim() ? { embeddingBaseUrl: env.RAG_EMBEDDING_BASE_URL.trim() } : {}),
    ...(env.RAG_EMBEDDING_API_KEY?.trim() ? { embeddingApiKey: env.RAG_EMBEDDING_API_KEY.trim() } : {}),
    embeddingModel: env.RAG_EMBEDDING_MODEL?.trim() || 'BAAI/bge-m3',
    embeddingDimensions: integer('RAG_EMBEDDING_DIMENSIONS', 1024, 1024, 1024),
    embeddingProfile: env.RAG_EMBEDDING_PROFILE?.trim() || 'bge-m3-1024',
    embeddingBatchSize: 32,
    indexingConcurrency: 2,
    embeddingTimeoutMs: 30_000,
    embeddingMaxRetries: 2,
    providerMode: ragProvider,
    rerankProvider: ((env.RAG_RERANK_PROVIDER?.trim() || 'disabled') as RagConfig['rerankProvider']),
    ...(env.RAG_RERANK_BASE_URL?.trim() ? { rerankBaseUrl: env.RAG_RERANK_BASE_URL.trim() } : {}),
    ...(env.RAG_RERANK_API_KEY?.trim() ? { rerankApiKey: env.RAG_RERANK_API_KEY.trim() } : {}),
    rerankModel: env.RAG_RERANK_MODEL?.trim() || 'qwen3-rerank',
    rerankTimeoutMs: 30_000,
    noteRerankBudgetMs: 200,
  };
  for(const [key,value] of [['RAG_EMBEDDING_BASE_URL',rag.embeddingBaseUrl],['RAG_RERANK_BASE_URL',rag.rerankBaseUrl]] as const){
    if(!value)continue;try{const endpoint=new URL(value);if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||(appEnv==='production'&&endpoint.protocol!=='https:'))fail(key);}catch{fail(key);}
  }
  if (!['disabled', 'mock', 'http'].includes(rag.rerankProvider)) fail('RAG_RERANK_PROVIDER');
  if (rag.rerankProvider === 'mock' && (appEnv === 'production' || env.ALLOW_MOCK_PROVIDERS !== 'true')) fail('RAG_RERANK_PROVIDER');
  if (rag.rerankProvider === 'http' && (!rag.rerankBaseUrl || !rag.rerankApiKey)) fail('RAG_RERANK_CONFIG');
  if(rag.embeddingModel!=='BAAI/bge-m3'||rag.embeddingProfile!=='bge-m3-1024')fail('RAG_EMBEDDING_PROFILE');
  const kb = {
    noteEnabled: false,
    noteCollection: env.KB_NOTE_HYBRID_COLLECTION?.trim() || 'huahuo_kb_note_hybrid_chunks',
    documentCollection: env.KB_DOCUMENT_KEYWORD_COLLECTION?.trim() || 'huahuo_kb_keyword_chunks',
  };
  if(kb.noteCollection===kb.documentCollection||![kb.noteCollection,kb.documentCollection].every(v=>/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(v)))fail('KB_COLLECTIONS');
  const maxUploadBytes=100*1024*1024;
  const uploadHardMaxBytes=integer('HTTP_UPLOAD_HARD_MAX_BYTES',2*1024*1024*1024,100*1024*1024,2*1024*1024*1024);
  const httpRequestTimeoutMs=integer('HTTP_REQUEST_TIMEOUT_MS',60_000,1_000,600_000);
  const httpConnectionTimeoutMs=integer('HTTP_CONNECTION_TIMEOUT_MS',65_000,1_000,600_000);
  if(httpConnectionTimeoutMs<httpRequestTimeoutMs)fail('HTTP_CONNECTION_TIMEOUT_MS');
  let storageS3:AppConfig['storageS3'];
  if(storageDriver==='s3'&&['api-server','worker'].includes(role))storageS3={endpoint:url('STORAGE_S3_ENDPOINT',appEnv==='production'?['https:']:['http:','https:']),region:env.STORAGE_S3_REGION??'us-east-1',bucket:required('STORAGE_S3_BUCKET'),accessKeyId:required('STORAGE_S3_ACCESS_KEY_ID'),secretAccessKey:required('STORAGE_S3_SECRET_ACCESS_KEY'),maxBytes:uploadHardMaxBytes};
  let storageAliyunOss:AppConfig['storageAliyunOss'];
  if(storageDriver==='aliyun-oss'&&['api-server','worker'].includes(role))storageAliyunOss={endpoint:url('STORAGE_ALIYUN_OSS_ENDPOINT',appEnv==='production'?['https:']:['http:','https:']),region:env.STORAGE_ALIYUN_OSS_REGION??'cn-beijing',bucket:required('STORAGE_ALIYUN_OSS_BUCKET'),accessKeyId:required('ALIYUN_RAM_ACCESS_KEY_ID'),accessKeySecret:required('ALIYUN_RAM_ACCESS_KEY_SECRET'),secure:env.STORAGE_ALIYUN_OSS_SECURE!=='false',timeoutMs:integer('STORAGE_ALIYUN_OSS_TIMEOUT_MS',120000,1000,600000),...(env.STORAGE_ALIYUN_OSS_KEY_PREFIX?.trim()?{keyPrefix:env.STORAGE_ALIYUN_OSS_KEY_PREFIX.trim()}:{}),maxBytes:uploadHardMaxBytes};
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['fatal','error','warn','info','debug','trace','silent'].includes(logLevel)) fail('LOG_LEVEL');
  const queuePrefix=env.REDIS_KEY_PREFIX??'huahuo-dev';
  if(!/^[a-zA-Z0-9_-]{1,64}$/.test(queuePrefix))fail('REDIS_KEY_PREFIX');
  const workerQueues=(env.WORKER_QUEUES??'content,ai,commercial,maintenance').split(',') as QueueName[];
  if(!workerQueues.length||new Set(workerQueues).size!==workerQueues.length||workerQueues.some(q=>!['content','ai','commercial','maintenance'].includes(q)))fail('WORKER_QUEUES');
  if(env.ENABLE_DEMO_TASKS==='true'&&appEnv==='production')fail('ENABLE_DEMO_TASKS');
  if(env.TEST_TASK_DELAY_MS&&appEnv!=='test')fail('TEST_TASK_DELAY_MS');
  return scopedConfig({
    apiServiceBaseUrl: loadApiServiceBaseUrl(env),
    metrics: loadMetricsConfig(role, env),
    processingNodes:loadProcessingNodesConfig(env),runtimeRevision:0,uploadHardMaxBytes,
    taskPolicy:{maxAttempts:3,retryBaseMs:1000,retryMaxMs:60000,concurrency:{content:2,ai:1,commercial:1,maintenance:1}},
    queuePrefix,workerQueues,taskLeaseMs:integer('TASK_LEASE_MS',15000,1000,60000),taskRedeliveryMs:integer('TASK_REDELIVERY_MS',30000,1000,300000),schedulerIntervalMs:integer('SCHEDULER_INTERVAL_MS',1000,100,10000),
    demoTasks:env.ENABLE_DEMO_TASKS==='true',testTaskDelayMs:integer('TEST_TASK_DELAY_MS',0,0,5000),
    role, host: env.HOST ?? (['worker','scheduler'].includes(role) ? '127.0.0.1' : '0.0.0.0'),
    port: integer('PORT', ['worker','scheduler'].includes(role) ? 3100 : 3000, 1, 65535),
    databaseUrl, poolMax: integer('DATABASE_POOL_MAX', role === 'migrate' ? 1 : 5, 1, 30),
    httpRequestTimeoutMs, httpConnectionTimeoutMs,
    shutdownTimeoutMs: integer('SHUTDOWN_TIMEOUT_MS', role === 'scheduler' ? 30000 : 300000, 1000, 3600000),
    ssl: sslMode === 'verify-full' ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) } : false,
    statementTimeout: integer('DATABASE_STATEMENT_TIMEOUT_MS', role === 'migrate' ? 30000 : 5000, 100, 60000),
    redisCacheUrl: role === 'migrate' ? '' : url('REDIS_CACHE_URL', ['redis:', 'rediss:']),
    redisQueueUrl: role === 'migrate' ? '' : url('REDIS_QUEUE_URL', ['redis:', 'rediss:']),
    schemaMinVersion: integer('DB_SCHEMA_MIN_VERSION', 1, 1, 99999), instanceId: randomUUID(), logLevel,
    connectDeadlineMs: integer('DATABASE_CONNECT_DEADLINE_MS', 60000, 1000, 120000),
    migrationLockTimeoutMs: integer('MIGRATION_LOCK_TIMEOUT_MS', 10000, 100, 60000),
    appTokenSecret: env.APP_TOKEN_SECRET,
    adminSessionSecret: env.ADMIN_SESSION_SECRET,
    jwt: {
      issuer: env.APP_JWT_ISSUER?.trim() || 'huahuo-server',
      audience: jwtAudience,
      serverAudience: jwtServerAudience,
      keyId: jwtKeyId,
      accessTtlSeconds: integer('APP_ACCESS_TOKEN_TTL_SECONDS', 900, 60, 86_400),
      refreshTtlSeconds: integer('REFRESH_TOKEN_TTL_SECONDS', 30 * 86_400, 3600, 365 * 86_400),
      ...(jwtPrivateKey ? { privateKeyPem: jwtPrivateKey } : {}),
      ...(jwtPublicKey ? { publicKeyPem: jwtPublicKey } : {}),
      ...(jwtPreviousPublicKey ? { previousPublicKeyPem: jwtPreviousPublicKey } : {}),
      ...(jwtPreviousKeyId ? { previousKeyId: jwtPreviousKeyId } : {}),
    },
    agentToServerServiceKey, serverToAgentServiceKey,
    smsProvider, smsAliyun, showTestOtp: env.SHOW_TEST_OTP === 'true' && appEnv !== 'production', appEnv,
    agreementVersion: env.USER_AGREEMENT_VERSION ?? (appEnv === 'production' ? '' : '2026-08-20'),
    privacyVersion: env.PRIVACY_POLICY_VERSION ?? (appEnv === 'production' ? '' : '2026-08-20'),
    adminOrigin: env.ADMIN_PUBLIC_BASE_URL ? new URL(env.ADMIN_PUBLIC_BASE_URL).origin : '',
    billingMode, billingPolicyVersion,
    storageDriver, storageLocalRoot: env.STORAGE_LOCAL_ROOT ?? './var/storage', maxUploadBytes, storageS3, storageAliyunOss, storageQuotaBytes:1024*1024*1024, appPublicBaseUrl: env.APP_PUBLIC_BASE_URL ?? 'http://127.0.0.1:3000', tagExtractorProvider,
    milvus: {
      ...(env.MILVUS_ADDRESS?.trim() ? { address: env.MILVUS_ADDRESS.trim() } : {}),
      ...(env.MILVUS_USERNAME?.trim() ? { username: env.MILVUS_USERNAME.trim() } : {}),
      ...(env.MILVUS_PASSWORD?.trim() ? { password: env.MILVUS_PASSWORD.trim() } : {}),
      database: env.MILVUS_DATABASE?.trim() || 'default',
      tls: bool('MILVUS_TLS', true),
      createIfMissing: bool('MILVUS_CREATE_IF_MISSING', false),
      searchConcurrency: 50,
      denseCandidates: 20,
      bm25Candidates: 20,
      hybridCandidates: 30,
      rrfK: 60,
    },
    rag,
    kb,
  });
}
