import { loadRecordingOutlineConfig, type RecordingOutlineSettings } from './recording-outline.js';
import type { QueueName } from '../modules/tasks/model.js';
import { loadMetricsConfig, type MetricsConfig } from './metrics.js';
import { loadTelemetryConfig, type TelemetryConfig } from './telemetry.js';
import { packageVersion } from '../observability/identity.js';
import { loadAgentBaseUrl, loadApiServiceBaseUrl } from './service-addresses.js';
import { loadRecorderVerifier, type RecorderVerifierConfig } from './recorder-verifier.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadAliyunOtpConfig, loadFeishuOtpConfig, type AliyunOtpConfig, type FeishuOtpConfig } from './sms.js';
import { loadProcessingNodesConfig, type ProcessingNodesConfig } from './processing-nodes.js';
import { loadFunAsrWorkflowConfig, type FunAsrWorkflowConfig } from './funasr.js';
import { scopedConfig } from '../modules/runtime-settings/service.js';
import { CONTENT_ASSET_EMBEDDING_MODEL, CONTENT_ASSET_EMBEDDING_PROFILE, CONTENT_ASSET_EMBEDDING_MAX_BATCH_SIZE, CONTENT_ASSET_RERANK_MODEL } from '../lib/search-index/model-profile.js';
export const DEFAULT_CONTENT_ASSET_COLLECTION = 'huahuo_kb_content_asset_hybrid_chunks';
export type Role = 'api-server' | 'admin' | 'worker' | 'scheduler' | 'migrate';
export type Env = Record<string, string | undefined>;
export interface AppConfig {
  metrics: MetricsConfig;
  telemetry: TelemetryConfig;
  processingNodes: ProcessingNodesConfig;
  funAsr?: FunAsrWorkflowConfig;
  recordingOutline?: RecordingOutlineSettings;
  runtimeRevision: number;
  uploadHardMaxBytes: number;
  taskPolicy: { maxAttempts:number;retryBaseMs:number;retryMaxMs:number;concurrency:Record<QueueName,number> };
  queuePrefix:string; workerQueues:QueueName[]; taskLeaseMs:number; taskRedeliveryMs:number; schedulerIntervalMs:number; demoTasks:boolean; testTaskDelayMs:number;
  role: Role; host: string; port: number; databaseUrl: string; poolMax: number;
  httpRequestTimeoutMs: number; httpConnectionTimeoutMs: number;
  httpTrustProxyHops: number;
  ssl: false | { rejectUnauthorized: true; ca?: string };
  statementTimeout: number; redisCacheUrl: string; redisQueueUrl: string;
  schemaMinVersion: number; instanceId: string; logLevel: string;
  connectDeadlineMs: number; migrationLockTimeoutMs: number;
  justOneApiToken?: string; huahuoShareHost?: string;
  appTokenSecret?: string; adminSessionSecret?: string;
  jwt: { issuer:string; audience:string[]; serverAudience:string; keyId:string; accessTtlSeconds:number; refreshTtlSeconds:number; privateKeyPem?:string; publicKeyPem?:string };
  gatewayStudio: { enabled: boolean; origin: string; publicPath: string };
  smsAliyun?: AliyunOtpConfig;
  smsFeishu?: FeishuOtpConfig;
  appEnv: string; agreementVersion: string; privacyVersion: string; adminOrigin: string;
  billingMode: 'disabled' | 'development' | 'live'; billingPolicyVersion: string;
  storageDriver: 'local' | 's3' | 'aliyun-oss'; storageLocalRoot: string; maxUploadBytes: number;
  appPublicBaseUrl: string;
  apiServiceBaseUrl?: string;
  agentBaseUrl?: string;
  recorderVerifier?: RecorderVerifierConfig;
  storageQuotaBytes:number;
  tagExtractorProvider: 'deterministic' | 'disabled' | 'llm' | 'dify';
  storageS3?: { endpoint:string; region:string; bucket:string; accessKeyId:string; secretAccessKey:string; maxBytes:number };
  storageAliyunOss?: { endpoint:string; publicEndpoint?:string; region:string; bucket:string; accessKeyId:string; accessKeySecret:string; secure:boolean; timeoutMs:number; keyPrefix?:string; maxBytes:number };
  milvus: MilvusConfig;
  rag: RagConfig;
  kb: { contentAssetEnabled: boolean; contentAssetCollection: string; documentCollection: string; indexLayout: 'bm25' | 'sparse-v1' };
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
  enabled: boolean;
  sourceAllowedHosts: string[];
  plainTextMaxChars: number;
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
  contentAssetRerankBudgetMs: number;
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
  const jwtAudience = (env.APP_JWT_AUDIENCE?.trim() || 'huahuo-server,huahuo-agent').split(',').map(value => value.trim()).filter(Boolean);
  const jwtServerAudience = env.APP_JWT_SERVER_AUDIENCE?.trim() || 'huahuo-server';
  const jwtKeyId = env.APP_JWT_KEY_ID?.trim() || 'server-current';
  if (!jwtAudience.length || new Set(jwtAudience).size !== jwtAudience.length || jwtAudience.some(value => !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) || !jwtAudience.includes(jwtServerAudience)) fail('APP_JWT_AUDIENCE');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(jwtServerAudience)) fail('APP_JWT_SERVER_AUDIENCE');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(jwtKeyId)) fail('APP_JWT_KEY_ID');
  if (role === 'api-server' && appEnv === 'production' && (!jwtPrivateKey || !jwtPublicKey)) fail('APP_JWT_KEYS');
  if ((jwtPrivateKey && !jwtPublicKey) || (!jwtPrivateKey && jwtPublicKey)) fail('APP_JWT_KEYS');
  const studioEnabled = env.HUAHUO_STUDIO_AUTH_ENABLED ?? 'false';
  if (!['true', 'false'].includes(studioEnabled) || (appEnv === 'production' && studioEnabled === 'true')) fail('HUAHUO_STUDIO_AUTH_ENABLED');
  const studioPath = env.HUAHUO_AGENT_PUBLIC_PATH?.trim() || '/agent';
  if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(studioPath)) fail('HUAHUO_AGENT_PUBLIC_PATH');
  let studioOrigin = '';
  try {
    const raw = env.HUAHUO_STUDIO_ORIGIN?.trim();
    const parsed = new URL(raw || env.APP_PUBLIC_BASE_URL || 'http://localhost:3000');
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || (raw && (parsed.pathname !== '/' || parsed.search || parsed.hash))) fail('HUAHUO_STUDIO_ORIGIN');
    studioOrigin = parsed.origin;
  } catch { fail('HUAHUO_STUDIO_ORIGIN'); }
  const gatewayStudio = { enabled: studioEnabled === 'true', origin: studioOrigin, publicPath: studioPath };
  const smsFeishu = role === 'api-server' ? loadFeishuOtpConfig(env, appEnv) : undefined;
  const smsAliyun = role === 'api-server' && !smsFeishu ? loadAliyunOtpConfig(env) : undefined;
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
    enabled: true,
    sourceAllowedHosts: csv('RAG_SOURCE_ALLOWED_HOSTS'),
    plainTextMaxChars: 50_000,
    ...(env.RAG_EMBEDDING_BASE_URL?.trim() ? { embeddingBaseUrl: env.RAG_EMBEDDING_BASE_URL.trim() } : {}),
    ...(env.RAG_EMBEDDING_API_KEY?.trim() ? { embeddingApiKey: env.RAG_EMBEDDING_API_KEY.trim() } : {}),
    embeddingModel: env.RAG_EMBEDDING_MODEL?.trim() || CONTENT_ASSET_EMBEDDING_MODEL,
    embeddingDimensions: integer('RAG_EMBEDDING_DIMENSIONS', 1024, 1024, 1024),
    embeddingProfile: env.RAG_EMBEDDING_PROFILE?.trim() || CONTENT_ASSET_EMBEDDING_PROFILE,
    embeddingBatchSize: CONTENT_ASSET_EMBEDDING_MAX_BATCH_SIZE,
    indexingConcurrency: 2,
    embeddingTimeoutMs: 30_000,
    embeddingMaxRetries: 2,
    providerMode: ragProvider,
    rerankProvider: ((env.RAG_RERANK_PROVIDER?.trim() || 'disabled') as RagConfig['rerankProvider']),
    ...(env.RAG_RERANK_BASE_URL?.trim() ? { rerankBaseUrl: env.RAG_RERANK_BASE_URL.trim() } : {}),
    ...(env.RAG_RERANK_API_KEY?.trim() ? { rerankApiKey: env.RAG_RERANK_API_KEY.trim() } : {}),
    rerankModel: env.RAG_RERANK_MODEL?.trim() || CONTENT_ASSET_RERANK_MODEL,
    rerankTimeoutMs: 30_000,
    contentAssetRerankBudgetMs: 200,
  };
  for(const [key,value] of [['RAG_EMBEDDING_BASE_URL',rag.embeddingBaseUrl],['RAG_RERANK_BASE_URL',rag.rerankBaseUrl]] as const){
    if(!value)continue;try{const endpoint=new URL(value);if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||(appEnv==='production'&&endpoint.protocol!=='https:'))fail(key);}catch{fail(key);}
  }
  if (!['disabled', 'mock', 'http'].includes(rag.rerankProvider)) fail('RAG_RERANK_PROVIDER');
  if (rag.rerankProvider === 'mock' && (appEnv === 'production' || env.ALLOW_MOCK_PROVIDERS !== 'true')) fail('RAG_RERANK_PROVIDER');
  if (rag.rerankProvider === 'http' && (!rag.rerankBaseUrl || !rag.rerankApiKey)) fail('RAG_RERANK_CONFIG');
  if(rag.embeddingModel!==CONTENT_ASSET_EMBEDDING_MODEL||rag.embeddingProfile!==CONTENT_ASSET_EMBEDDING_PROFILE)fail('RAG_EMBEDDING_PROFILE');
  if(rag.rerankProvider==='http'&&rag.rerankModel!==CONTENT_ASSET_RERANK_MODEL)fail('RAG_RERANK_MODEL');
  const indexLayout = env.KB_INDEX_LAYOUT?.trim() || 'bm25';
  if(indexLayout!=='bm25'&&indexLayout!=='sparse-v1')return fail('KB_INDEX_LAYOUT');
  const kb: AppConfig['kb'] = {
    indexLayout,
    contentAssetEnabled: false,
    contentAssetCollection: env.KB_CONTENT_ASSET_HYBRID_COLLECTION?.trim() || DEFAULT_CONTENT_ASSET_COLLECTION,
    documentCollection: env.KB_DOCUMENT_KEYWORD_COLLECTION?.trim() || 'huahuo_kb_keyword_chunks',
  };
  if(kb.contentAssetCollection===kb.documentCollection||![kb.contentAssetCollection,kb.documentCollection].every(v=>/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(v)))fail('KB_COLLECTIONS');
  const assetIndexName=kb.contentAssetCollection+'_asset_v2';
  const documentIndexName=kb.documentCollection+(indexLayout==='sparse-v1'?'_sparse_v1':'');
  if(assetIndexName.length>255||assetIndexName===documentIndexName)fail('KB_COLLECTIONS');
  if(indexLayout==='sparse-v1'&&[kb.contentAssetCollection,kb.documentCollection].some(name=>name.length>245||name.endsWith('_sparse_v1')))fail('KB_COLLECTIONS');
  const maxUploadBytes=100*1024*1024;
  const uploadHardMaxBytes=integer('HTTP_UPLOAD_HARD_MAX_BYTES',2*1024*1024*1024,100*1024*1024,2*1024*1024*1024);
  const httpRequestTimeoutMs=integer('HTTP_REQUEST_TIMEOUT_MS',60_000,1_000,600_000);
  const httpConnectionTimeoutMs=integer('HTTP_CONNECTION_TIMEOUT_MS',65_000,1_000,600_000);
  if(httpConnectionTimeoutMs<httpRequestTimeoutMs)fail('HTTP_CONNECTION_TIMEOUT_MS');
  let storageS3:AppConfig['storageS3'];
  if(storageDriver==='s3'&&['api-server','worker'].includes(role))storageS3={endpoint:url('STORAGE_S3_ENDPOINT',appEnv==='production'?['https:']:['http:','https:']),region:env.STORAGE_S3_REGION??'us-east-1',bucket:required('STORAGE_S3_BUCKET'),accessKeyId:required('STORAGE_S3_ACCESS_KEY_ID'),secretAccessKey:required('STORAGE_S3_SECRET_ACCESS_KEY'),maxBytes:uploadHardMaxBytes};
  let storageAliyunOss:AppConfig['storageAliyunOss'];
  if(storageDriver==='aliyun-oss'&&['api-server','worker'].includes(role))storageAliyunOss={endpoint:url('STORAGE_ALIYUN_OSS_ENDPOINT',appEnv==='production'?['https:']:['http:','https:']),...(env.STORAGE_ALIYUN_OSS_PUBLIC_ENDPOINT?.trim()?{publicEndpoint:url('STORAGE_ALIYUN_OSS_PUBLIC_ENDPOINT',['https:'])}:{}),region:env.STORAGE_ALIYUN_OSS_REGION??'cn-beijing',bucket:required('STORAGE_ALIYUN_OSS_BUCKET'),accessKeyId:required('ALIYUN_RAM_ACCESS_KEY_ID'),accessKeySecret:required('ALIYUN_RAM_ACCESS_KEY_SECRET'),secure:env.STORAGE_ALIYUN_OSS_SECURE!=='false',timeoutMs:integer('STORAGE_ALIYUN_OSS_TIMEOUT_MS',120000,1000,600000),...(env.STORAGE_ALIYUN_OSS_KEY_PREFIX?.trim()?{keyPrefix:env.STORAGE_ALIYUN_OSS_KEY_PREFIX.trim()}:{}),maxBytes:uploadHardMaxBytes};
  if(storageAliyunOss){
    const publicUrl=new URL(storageAliyunOss.publicEndpoint??storageAliyunOss.endpoint);
    if(publicUrl.hostname.includes('-internal.'))fail('STORAGE_ALIYUN_OSS_PUBLIC_ENDPOINT');
  }
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
    agentBaseUrl: role === 'api-server' ? loadAgentBaseUrl(env) : undefined,
    recorderVerifier: role === 'api-server' ? loadRecorderVerifier(env) : undefined,
    metrics: loadMetricsConfig(role, env),
    telemetry: loadTelemetryConfig(env, packageVersion),
    processingNodes:loadProcessingNodesConfig(env),runtimeRevision:0,uploadHardMaxBytes,
    recordingOutline: role==='worker' ? loadRecordingOutlineConfig(env) : undefined,
    funAsr: loadFunAsrWorkflowConfig(role, env, billingMode),
    taskPolicy:{maxAttempts:3,retryBaseMs:1000,retryMaxMs:60000,concurrency:{content:2,ai:1,commercial:1,maintenance:1}},
    queuePrefix,workerQueues,taskLeaseMs:integer('TASK_LEASE_MS',15000,1000,60000),taskRedeliveryMs:integer('TASK_REDELIVERY_MS',30000,1000,300000),schedulerIntervalMs:integer('SCHEDULER_INTERVAL_MS',1000,100,10000),
    demoTasks:env.ENABLE_DEMO_TASKS==='true',testTaskDelayMs:integer('TEST_TASK_DELAY_MS',0,0,5000),
    role, host: env.HOST ?? (['worker','scheduler'].includes(role) ? '127.0.0.1' : '0.0.0.0'),
    port: integer('PORT', ['worker','scheduler'].includes(role) ? 3100 : 3000, 1, 65535),
    databaseUrl, poolMax: integer('DATABASE_POOL_MAX', role === 'migrate' ? 1 : 5, 1, 30),
    httpRequestTimeoutMs, httpConnectionTimeoutMs,
    httpTrustProxyHops: integer('HTTP_TRUST_PROXY_HOPS', 0, 0, 2),
    ssl: sslMode === 'verify-full' ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) } : false,
    statementTimeout: integer('DATABASE_STATEMENT_TIMEOUT_MS', role === 'migrate' ? 30000 : 5000, 100, 60000),
    redisCacheUrl: role === 'migrate' ? '' : url('REDIS_CACHE_URL', ['redis:', 'rediss:']),
    redisQueueUrl: role === 'migrate' ? '' : url('REDIS_QUEUE_URL', ['redis:', 'rediss:']),
    schemaMinVersion: integer('DB_SCHEMA_MIN_VERSION', 1, 1, 99999), instanceId: randomUUID(), logLevel,
    connectDeadlineMs: integer('DATABASE_CONNECT_DEADLINE_MS', 60000, 1000, 120000),
    migrationLockTimeoutMs: integer('MIGRATION_LOCK_TIMEOUT_MS', 10000, 100, 60000),
    ...(role === 'worker' ? {justOneApiToken:env.JUSTONE_API_TOKEN?.trim()} : {}),
    ...(role === 'api-server' || role === 'worker' ? {huahuoShareHost:env.HUAHUO_SHARE_HOST?.trim().toLowerCase()} : {}),
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
    },
    gatewayStudio,
    smsAliyun, smsFeishu, appEnv,
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
