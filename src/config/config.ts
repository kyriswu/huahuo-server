import type { QueueName } from '../modules/tasks/model.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
export type Role = 'api-server' | 'admin' | 'worker' | 'scheduler' | 'migrate';
export type Env = Record<string, string | undefined>;
export interface AppConfig {
  queuePrefix:string; workerQueues:QueueName[]; taskLeaseMs:number; taskRedeliveryMs:number; schedulerIntervalMs:number; demoTasks:boolean; testTaskDelayMs:number;
  role: Role; host: string; port: number; databaseUrl: string; poolMax: number;
  ssl: false | { rejectUnauthorized: true; ca?: string };
  statementTimeout: number; redisCacheUrl: string; redisQueueUrl: string;
  schemaMinVersion: number; instanceId: string; logLevel: string;
  connectDeadlineMs: number; migrationLockTimeoutMs: number;
  appTokenSecret?: string; adminSessionSecret?: string;
  smsProvider: 'mock' | 'disabled' | 'live'; showTestOtp: boolean;
  appEnv: string; agreementVersion: string; privacyVersion: string; adminOrigin: string;
  billingMode: 'disabled' | 'development' | 'live'; billingPolicyVersion: string;
  storageDriver: 'local' | 's3'; storageLocalRoot: string; maxUploadBytes: number;
  appPublicBaseUrl: string;
  storageQuotaBytes:number;
  tagExtractorProvider: 'deterministic' | 'disabled' | 'llm' | 'dify';
  storageS3?: { endpoint:string; region:string; bucket:string; accessKeyId:string; secretAccessKey:string; maxBytes:number };
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
  const smsProvider = (env.SMS_PROVIDER ?? 'disabled') as AppConfig['smsProvider'];
  if (!['mock', 'disabled', 'live'].includes(smsProvider)) fail('SMS_PROVIDER');
  if (smsProvider === 'mock' && (appEnv === 'production' || env.ALLOW_MOCK_PROVIDERS !== 'true')) fail('SMS_PROVIDER');
  if (env.SHOW_TEST_OTP === 'true' && (appEnv === 'production' || smsProvider !== 'mock')) fail('SHOW_TEST_OTP');
  const billingMode = (env.BILLING_MODE ?? (appEnv === 'development' ? 'development' : 'disabled')) as AppConfig['billingMode'];
  if (!['disabled', 'development', 'live'].includes(billingMode)) fail('BILLING_MODE');
  if (appEnv === 'production' && billingMode === 'development') fail('BILLING_MODE');
  const billingPolicyVersion = env.BILLING_POLICY_VERSION ?? 'credit-policy-v1';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(billingPolicyVersion)) fail('BILLING_POLICY_VERSION');
  const storageDriver=(env.STORAGE_DRIVER??'local') as AppConfig['storageDriver'];
  if(!['local','s3'].includes(storageDriver))fail('STORAGE_DRIVER');
  const tagExtractorProvider=(env.TAG_EXTRACTOR_PROVIDER ?? 'disabled') as AppConfig['tagExtractorProvider'];
  if(!['deterministic','disabled','llm','dify'].includes(tagExtractorProvider))fail('TAG_EXTRACTOR_PROVIDER');
  if(tagExtractorProvider==='deterministic' && (appEnv==='production'||env.ALLOW_MOCK_PROVIDERS!=='true'))fail('TAG_EXTRACTOR_PROVIDER');
  const maxUploadBytes=integer('MAX_UPLOAD_BYTES',100*1024*1024,1,2*1024*1024*1024);
  let storageS3:AppConfig['storageS3'];
  if(storageDriver==='s3'&&['api-server','worker'].includes(role))storageS3={endpoint:url('STORAGE_S3_ENDPOINT',appEnv==='production'?['https:']:['http:','https:']),region:env.STORAGE_S3_REGION??'us-east-1',bucket:required('STORAGE_S3_BUCKET'),accessKeyId:required('STORAGE_S3_ACCESS_KEY_ID'),secretAccessKey:required('STORAGE_S3_SECRET_ACCESS_KEY'),maxBytes:maxUploadBytes};
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['fatal','error','warn','info','debug','trace','silent'].includes(logLevel)) fail('LOG_LEVEL');
  const queuePrefix=env.REDIS_KEY_PREFIX??'huahuo-dev';
  if(!/^[a-zA-Z0-9_-]{1,64}$/.test(queuePrefix))fail('REDIS_KEY_PREFIX');
  const workerQueues=(env.WORKER_QUEUES??'content,ai,commercial,maintenance').split(',') as QueueName[];
  if(!workerQueues.length||new Set(workerQueues).size!==workerQueues.length||workerQueues.some(q=>!['content','ai','commercial','maintenance'].includes(q)))fail('WORKER_QUEUES');
  if(env.ENABLE_DEMO_TASKS==='true'&&appEnv==='production')fail('ENABLE_DEMO_TASKS');
  if(env.TEST_TASK_DELAY_MS&&appEnv!=='test')fail('TEST_TASK_DELAY_MS');
  return {
    queuePrefix,workerQueues,taskLeaseMs:integer('TASK_LEASE_MS',15000,1000,60000),taskRedeliveryMs:integer('TASK_REDELIVERY_MS',30000,1000,300000),schedulerIntervalMs:integer('SCHEDULER_INTERVAL_MS',1000,100,10000),
    demoTasks:env.ENABLE_DEMO_TASKS==='true',testTaskDelayMs:integer('TEST_TASK_DELAY_MS',0,0,5000),
    role, host: env.HOST ?? (['worker','scheduler'].includes(role) ? '127.0.0.1' : '0.0.0.0'),
    port: integer('PORT', ['worker','scheduler'].includes(role) ? 3100 : 3000, 1, 65535),
    databaseUrl, poolMax: integer('DATABASE_POOL_MAX', role === 'migrate' ? 1 : 5, 1, 30),
    ssl: sslMode === 'verify-full' ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) } : false,
    statementTimeout: integer('DATABASE_STATEMENT_TIMEOUT_MS', 5000, 100, 60000),
    redisCacheUrl: role === 'migrate' ? '' : url('REDIS_CACHE_URL', ['redis:', 'rediss:']),
    redisQueueUrl: role === 'migrate' ? '' : url('REDIS_QUEUE_URL', ['redis:', 'rediss:']),
    schemaMinVersion: integer('DB_SCHEMA_MIN_VERSION', 8, 1, 99999), instanceId: randomUUID(), logLevel,
    connectDeadlineMs: integer('DATABASE_CONNECT_DEADLINE_MS', 60000, 1000, 120000),
    migrationLockTimeoutMs: integer('MIGRATION_LOCK_TIMEOUT_MS', 10000, 100, 60000),
    appTokenSecret: env.APP_TOKEN_SECRET,
    adminSessionSecret: env.ADMIN_SESSION_SECRET,
    smsProvider, showTestOtp: env.SHOW_TEST_OTP === 'true' && appEnv !== 'production', appEnv,
    agreementVersion: env.USER_AGREEMENT_VERSION ?? (appEnv === 'production' ? '' : '2026-08-20'),
    privacyVersion: env.PRIVACY_POLICY_VERSION ?? (appEnv === 'production' ? '' : '2026-08-20'),
    adminOrigin: env.ADMIN_PUBLIC_BASE_URL ? new URL(env.ADMIN_PUBLIC_BASE_URL).origin : '',
    billingMode, billingPolicyVersion,
    storageDriver, storageLocalRoot: env.STORAGE_LOCAL_ROOT ?? './var/storage', maxUploadBytes, storageS3, storageQuotaBytes:integer('STORAGE_QUOTA_BYTES',1024*1024*1024,1,Number.MAX_SAFE_INTEGER), appPublicBaseUrl: env.APP_PUBLIC_BASE_URL ?? 'http://127.0.0.1:3000', tagExtractorProvider,
  };
}
