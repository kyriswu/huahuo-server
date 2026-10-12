import { describe,it,expect } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { env } from '../helpers.js';
describe('role configuration',()=>{
 it('validates roles, ports, secrets and dependencies without exposing values',()=>{
  for (const patch of [{SERVICE_ROLE:'admin'},{DATABASE_URL:'secret-invalid-url'},{PORT:'NaN'},{DATABASE_POOL_MAX:'0'},{APP_TOKEN_SECRET:'short'},{REDIS_QUEUE_URL:''}]) {
   expect(()=>loadConfig('api-server',{...env,...patch})).toThrow(/^INVALID_CONFIG:/);
  }
 });
 it('rejects production mock/bypass but allows disabled capabilities',()=>{
  const production={...env,APP_ENV:'production',DATABASE_SSL_MODE:'verify-full',APP_PUBLIC_BASE_URL:'https://api.example.test'};
  expect(()=>loadConfig('api-server',production)).not.toThrow();
  for(const patch of [{PROVIDER_MODE:'mock',ALLOW_MOCK_PROVIDERS:'true'},{DEV_AUTH_BYPASS:'true',ALLOW_DEV_AUTH:'true'},{PAYMENT_PROVIDER:'mock'}]) expect(()=>loadConfig('api-server',{...production,...patch})).toThrow();
  expect(()=>loadConfig('api-server',{...env,PROVIDER_MODE:'mock'})).toThrow();
  expect(()=>loadConfig('api-server',{...env,PROVIDER_MODE:'mock',ALLOW_MOCK_PROVIDERS:'true'})).not.toThrow();
 });
 it('rejects conflicting TLS URL parameters, unverified modes and unreadable CA',()=>{
  for(const patch of [{DATABASE_URL:env.DATABASE_URL+'?sslmode=no-verify'},{DATABASE_SSL_MODE:'require'},{DATABASE_SSL_MODE:'verify-full',DATABASE_SSL_CA_FILE:'/missing/ca'},{DATABASE_SSL_CA_FILE:'x'}]) expect(()=>loadConfig('worker',{...env,...patch})).toThrow();
  expect(loadConfig('worker',{...env,DATABASE_SSL_MODE:'verify-full'}).ssl).toEqual({rejectUnauthorized:true});
 });
 it('migrate requires no Redis or provider identity secrets',()=>expect(loadConfig('migrate',{DATABASE_URL:env.DATABASE_URL}).redisCacheUrl).toBe(''));
});
