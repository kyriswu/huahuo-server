import { describe,it,expect } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { env } from '../helpers.js';
describe('role configuration',()=>{
 it('configures native Milvus v2 recall budgets without changing the embedding model',()=>{
  const cfg=loadConfig('api-server',env);
  expect(cfg.milvus).toMatchObject({collection:'huahuo_chunks',denseCandidates:20,bm25Candidates:20,hybridCandidates:30,rrfK:60});
  expect(cfg.rag).toMatchObject({embeddingModel:'Qwen/Qwen3-Embedding-8B',embeddingDimensions:4096});
  for(const patch of [{RAG_DENSE_CANDIDATES:'0'},{RAG_BM25_CANDIDATES:'201'},{RAG_HYBRID_CANDIDATES:'1.5'},{RAG_RRF_K:'0'}])expect(()=>loadConfig('api-server',{...env,...patch})).toThrow(/^INVALID_CONFIG:/);
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
