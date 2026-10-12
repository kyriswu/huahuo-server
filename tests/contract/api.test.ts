import { describe,it,expect } from 'vitest';
import { buildApiServer } from '../../src/apps/api-server.js';
import { buildAdminServer } from '../../src/apps/admin.js';
import { buildBase } from '../../src/apps/base.js';
import { config, dependencies } from '../helpers.js';
describe('P01 routes and App-compatible base envelope (no Dart runtime)',()=>{
 it('exposes health, OpenAPI and trace correlation; API has no business/admin routes',async()=>{
  const app=await buildApiServer({config:config(),dependencies:dependencies()});
  try {
   const r=await app.inject({method:'GET',url:'/health/ready',headers:{'x-trace-id':'trace_docs_fixture'}});
   expect(r.statusCode).toBe(200);expect(r.json()).toEqual({success:true,data:{service:'api-server',status:'ready',stage:'P06',mode:'asset-knowledge'},traceId:'trace_docs_fixture'});
   expect(r.headers['x-trace-id']).toBe('trace_docs_fixture');
   for(const url of ['/admin','/admin/api/v1','/api/v1/home']) expect((await app.inject(url)).statusCode).toBe(404);
   expect(Object.keys(app.swagger().paths ?? {})).toContain('/api/v1/auth/login');
   expect(Object.keys(app.swagger().paths ?? {}).some(p=>p.startsWith('/admin'))).toBe(false);
  } finally {await app.close();}
 });
 it('denies admin independently even with an App Bearer token',async()=>{
  const app=await buildAdminServer({config:config('admin'),dependencies:dependencies()});
  try {
   for(const url of ['/admin','/admin/api/v1','/admin/login']) {
    const r=await app.inject({url,headers:{authorization:'Bearer fake-user-token'}});expect(r.statusCode).toBe(401);expect(r.json().error.code).toBe('ADMIN_UNAUTHORIZED');
   }
   expect((await app.inject('/api/v1/home')).statusCode).toBe(404);
  }finally{await app.close();}
 });
 it('validates parameters and sanitizes unexpected errors',async()=>{
  const app=await buildApiServer({config:config(),dependencies:dependencies()});
  app.get('/test-error',async()=>{throw new Error('postgresql://secret-user:secret-password@private/db');});
  try{
   const bad=await app.inject('/health/ready?secret=do-not-reflect');expect(bad.statusCode).toBe(400);expect(bad.body).not.toContain('do-not-reflect');
   const fail=await app.inject('/test-error');expect(fail.statusCode).toBe(500);expect(fail.body).not.toContain('secret');
  }finally{await app.close();}
 });
 it('supports App empty JSON POST while requiring login fields and rejecting malformed JSON',async()=>{
  const app=await buildApiServer({config:config(),dependencies:dependencies()});
  try{
   expect((await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:{'content-type':'application/json'}})).statusCode).toBe(401);
   expect((await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{'content-type':'application/json'}})).statusCode).toBe(400);
   expect((await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{'content-type':'application/json'},payload:'{broken'})).statusCode).toBe(400);
  }finally{await app.close();}
 });
 it('registers P04 billing paths only under explicit development policy',async()=>{
  const app=await buildApiServer({config:{...config(),billingMode:'development',billingPolicyVersion:'credit-policy-v1'},dependencies:dependencies()});
  try { await app.ready(); expect(Object.keys(app.swagger().paths ?? {})).toEqual(expect.arrayContaining(['/api/v1/membership','/api/v1/account/credits','/api/v1/home','/api/v1/runs/{runId}/usage'])); }
  finally { await app.close(); }
 });
 it.each(['api-server','admin','worker','scheduler'] as const)('%s readiness is distinct from liveness',async role=>{
  const app=await buildBase({config:config(role),dependencies:dependencies(false)});
  try {expect((await app.inject('/health/ready')).statusCode).toBe(503);expect((await app.inject('/health/live')).statusCode).toBe(200);}
  finally{await app.close();}
 });
});
