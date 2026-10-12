import { describe,it,expect } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { env } from '../helpers.js';
import { normalizePhone,seal,unseal,canonical,hashPassword,verifyPassword } from '../../src/modules/identity/crypto.js';
import { LiveSmsProvider } from '../../src/integrations/sms.js';
describe('P02 security configuration and adapter boundary',()=>{
 it('normalizes only explicitly supported CN phone representations',()=>{
  expect(normalizePhone('13800000001')).toBe('+8613800000001');expect(normalizePhone('+8613800000001')).toBe('+8613800000001');
  for(const bad of ['+15551234567','12345','13800000001;drop'])expect(()=>normalizePhone(bad)).toThrow();
 });
 it('requires explicit mock flags and forbids production OTP echo',()=>{
  expect(()=>loadConfig('api-server',{...env,SMS_PROVIDER:'mock'})).toThrow();
  expect(()=>loadConfig('api-server',{...env,SHOW_TEST_OTP:'true',SMS_PROVIDER:'live'})).toThrow();
  expect(()=>loadConfig('api-server',{...env,APP_ENV:'production',DATABASE_SSL_MODE:'verify-full',APP_PUBLIC_BASE_URL:'https://api.example.test',SMS_PROVIDER:'mock',ALLOW_MOCK_PROVIDERS:'true'})).toThrow();
 });
 it('replay encryption is authenticated and request hashing ignores object key order',()=>{
  const secret='encryption-key'.repeat(4),result=seal({secret:'not-plaintext'},secret);expect(result).not.toContain('not-plaintext');
  expect(unseal(result,secret)).toEqual({secret:'not-plaintext'});expect(()=>unseal(result,'wrong')).toThrow();
  expect(canonical({b:1,a:[2]})).toBe(canonical({a:[2],b:1}));
 });
 it('scrypt verifies valid passwords only',async()=>{
  const hash=await hashPassword('long-test-password');expect(await verifyPassword('long-test-password',hash)).toBe(true);expect(await verifyPassword('wrong',hash)).toBe(false);
 });
 it('live adapter requires an accepted provider response, without real calls',async()=>{
  const message={phone:'+8613800000001',code:'123456',purpose:'login' as const,requestId:'fixture'};
  await expect(new LiveSmsProvider(async()=>({accepted:false})).send(message)).rejects.toThrow('SMS_PROVIDER_FAILED');
  await expect(new LiveSmsProvider(async()=>({accepted:true})).send(message)).resolves.toBeUndefined();
 });
});
