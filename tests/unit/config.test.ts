import { describe,it,expect } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { loadGpuSpotConfig } from '../../src/integrations/gpu-spot/config.js';
import { env } from '../helpers.js';
import {applyValues,validateValues} from '../../src/modules/runtime-settings/registry.js';
describe('role configuration',()=>{
 it('does not retain a second ENV source for the database-managed drain budget',()=>{
  for(const role of ['api-server','worker','admin','scheduler'] as const){
   expect(loadConfig(role,env)).not.toHaveProperty('shutdownTimeoutMs');
   expect(loadConfig(role,{...env,SHUTDOWN_TIMEOUT_MS:'30000'})).not.toHaveProperty('shutdownTimeoutMs');
  }
 });
 it.each(['api-server','worker'] as const)('%s uses the same RAM identity for OSS and ECI',async role=>{
  const shared={...env,ALIYUN_RAM_ACCESS_KEY_ID:'shared-test-id',ALIYUN_RAM_ACCESS_KEY_SECRET:'shared-test-secret',
   STORAGE_DRIVER:'aliyun-oss',STORAGE_ALIYUN_OSS_ENDPOINT:'https://oss-cn-beijing.aliyuncs.com',STORAGE_ALIYUN_OSS_BUCKET:'test-bucket',
   STORAGE_ALIYUN_OSS_ACCESS_KEY_ID:'unused-legacy-id',STORAGE_ALIYUN_OSS_ACCESS_KEY_SECRET:'unused-legacy-secret'};
  const oss=loadConfig(role,shared).storageAliyunOss;
  const gpu=loadGpuSpotConfig({...shared,GPU_SPOT_PROVIDER:'aliyun-eci',GPU_SPOT_REGION_ID:'cn-beijing',GPU_SPOT_VPC_ID:'vpc-test',
   GPU_SPOT_SECURITY_GROUP_ID:'sg-test',GPU_SPOT_VSWITCH_IDS:'vsw-test',GPU_SPOT_INSTANCE_TYPES:'ecs.gn6i-c4g1.xlarge',GPU_SPOT_IMAGE:'nginx:latest'});
  if(gpu.provider!=='aliyun-eci')throw new Error('unexpected disabled');
  const credentials=await gpu.connection.credentials();
  expect(oss).toMatchObject({accessKeyId:'shared-test-id',accessKeySecret:'shared-test-secret',bucket:'test-bucket'});
  expect(credentials).toEqual({accessKeyId:oss?.accessKeyId,accessKeySecret:oss?.accessKeySecret});
 });
 it.each(['ALIYUN_RAM_ACCESS_KEY_ID','ALIYUN_RAM_ACCESS_KEY_SECRET'])('requires %s for OSS without falling back to retired aliases',key=>{
  for(const role of ['api-server','worker'] as const)expect(()=>loadConfig(role,{...env,STORAGE_DRIVER:'aliyun-oss',
   STORAGE_ALIYUN_OSS_ENDPOINT:'https://oss-cn-beijing.aliyuncs.com',STORAGE_ALIYUN_OSS_BUCKET:'test-bucket',
   ALIYUN_RAM_ACCESS_KEY_ID:'shared-test-id',ALIYUN_RAM_ACCESS_KEY_SECRET:'shared-test-secret',[key]:'',
   STORAGE_ALIYUN_OSS_ACCESS_KEY_ID:'unused-legacy-id',STORAGE_ALIYUN_OSS_ACCESS_KEY_SECRET:'unused-legacy-secret'})).toThrow(`INVALID_CONFIG:${key}`);
 });
 it('does not require RAM credentials for roles without an Aliyun client',()=>{
  for(const role of ['admin','scheduler','migrate'] as const)expect(loadConfig(role,{...env,STORAGE_DRIVER:'aliyun-oss'}).storageAliyunOss).toBeUndefined();
  expect(loadConfig('api-server',env).storageAliyunOss).toBeUndefined();
 });
 it('validates the shared Milvus concurrency limit',()=>{
  expect(loadConfig('api-server',env).milvus.searchConcurrency).toBe(50);
  for(const value of [0,-1,1.5,51,NaN])expect(()=>validateValues({'rag.searchConcurrency':value},loadConfig('api-server',env))).toThrow('CONFIGURATION_INVALID');
 });
 it('sets a separate 200ms Note rerank budget without changing other rerank timeouts',()=>{
  expect(loadConfig('api-server',env).rag).toMatchObject({noteRerankBudgetMs:200,rerankTimeoutMs:30000});
  expect(applyValues(loadConfig('api-server',env),{'rag.noteRerankBudgetMs':350},1).rag.noteRerankBudgetMs).toBe(350);
  for(const value of [0,-1,1.5,30001,NaN])expect(()=>validateValues({'rag.noteRerankBudgetMs':value},loadConfig('api-server',env))).toThrow('CONFIGURATION_INVALID');
 });
 it('configures native Milvus recall budgets and the fixed BGE model',()=>{
  const cfg=loadConfig('api-server',env);
  expect(cfg.milvus).toMatchObject({denseCandidates:20,bm25Candidates:20,hybridCandidates:30,rrfK:60});
  expect(cfg.rag).toMatchObject({embeddingModel:'BAAI/bge-m3',embeddingDimensions:1024,embeddingProfile:'bge-m3-1024'});
  for(const patch of [{'rag.denseCandidates':0},{'rag.bm25Candidates':201},{'rag.hybridCandidates':1.5},{'rag.rrfK':0}])expect(()=>validateValues(patch,cfg)).toThrow('CONFIGURATION_INVALID');
 });
 it('does not persist endpoint credentials and fixes the native tokenizer input limit',()=>{
  for(const patch of [{RAG_EMBEDDING_BASE_URL:'https://user:secret@example.test/v1'},{RAG_RERANK_BASE_URL:'https://example.test?token=secret'},{RAG_TOKENIZER_MAX_INPUT_TOKENS:'32768'}])expect(()=>loadConfig('api-server',{...env,...patch})).toThrow(/^INVALID_CONFIG:/);
 });
 it('validates roles, ports, secrets and dependencies without exposing values',()=>{
  for (const patch of [{SERVICE_ROLE:'admin'},{DATABASE_URL:'secret-invalid-url'},{PORT:'NaN'},{DATABASE_POOL_MAX:'0'},{APP_TOKEN_SECRET:'short'},{REDIS_QUEUE_URL:''}]) {
   expect(()=>loadConfig('api-server',{...env,...patch})).toThrow(/^INVALID_CONFIG:/);
  }
 });
 it('rejects production mock/bypass but allows disabled capabilities',()=>{
  const production={...env,APP_ENV:'production',DATABASE_SSL_MODE:'verify-full',APP_PUBLIC_BASE_URL:'https://api.example.test',APP_JWT_PRIVATE_KEY:'cA==',APP_JWT_PUBLIC_KEY:'cA==',HUAHUO_AGENT_TO_SERVER_API_KEY:'a'.repeat(43),HUAHUO_SERVER_TO_AGENT_API_KEY:'b'.repeat(43)};
  expect(()=>loadConfig('api-server',production)).not.toThrow();
  expect(()=>loadConfig('api-server',{...production,HUAHUO_AGENT_TO_SERVER_API_KEY:undefined})).toThrow('INVALID_CONFIG:HUAHUO_SERVICE_API_KEY');
  expect(()=>loadConfig('api-server',{...production,HUAHUO_SERVER_TO_AGENT_API_KEY:undefined})).toThrow('INVALID_CONFIG:HUAHUO_SERVICE_API_KEY');
  expect(()=>loadConfig('api-server',{...production,HUAHUO_AGENT_TO_SERVER_API_KEY:'a'.repeat(43),HUAHUO_SERVER_TO_AGENT_API_KEY:'a'.repeat(43)})).toThrow('INVALID_CONFIG:HUAHUO_SERVICE_API_KEY_DIRECTIONAL_COLLISION');
  for(const patch of [{PROVIDER_MODE:'mock',ALLOW_MOCK_PROVIDERS:'true'},{DEV_AUTH_BYPASS:'true',ALLOW_DEV_AUTH:'true'},{PAYMENT_PROVIDER:'mock'}]) expect(()=>loadConfig('api-server',{...production,...patch})).toThrow();
  expect(()=>loadConfig('api-server',{...env,PROVIDER_MODE:'mock'})).toThrow();
  expect(()=>loadConfig('api-server',{...env,PROVIDER_MODE:'mock',ALLOW_MOCK_PROVIDERS:'true'})).not.toThrow();
 });
 it('rejects conflicting TLS URL parameters, unverified modes and unreadable CA',()=>{
  for(const patch of [{DATABASE_URL:env.DATABASE_URL+'?sslmode=no-verify'},{DATABASE_SSL_MODE:'require'},{DATABASE_SSL_MODE:'verify-full',DATABASE_SSL_CA_FILE:'/missing/ca'},{DATABASE_SSL_CA_FILE:'x'}]) expect(()=>loadConfig('worker',{...env,...patch})).toThrow();
  expect(loadConfig('worker',{...env,DATABASE_SSL_MODE:'verify-full'}).ssl).toEqual({rejectUnauthorized:true});
 });
 it('migrate requires no Redis or provider identity secrets',()=>expect(loadConfig('migrate',{DATABASE_URL:env.DATABASE_URL}).redisCacheUrl).toBe(''));
 it('requires the shared Server and Agent audiences and validates rotation metadata',()=>{
  expect(loadConfig('api-server',env).jwt).toMatchObject({issuer:'huahuo-server',audience:['huahuo-server','huahuo-agent'],serverAudience:'huahuo-server',keyId:'server-current'});
  expect(()=>loadConfig('api-server',{...env,APP_JWT_AUDIENCE:'legacy-client'})).toThrow('INVALID_CONFIG:APP_JWT_AUDIENCE');
  expect(()=>loadConfig('api-server',{...env,APP_JWT_PREVIOUS_KEY_ID:'old'})).toThrow('INVALID_CONFIG:APP_JWT_PREVIOUS_KEY');
 });
});
