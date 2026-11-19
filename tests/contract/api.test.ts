import { describe,it,expect } from 'vitest';
import { buildApiServer } from '../../src/apps/api-server.js';
import { buildAdminServer } from '../../src/apps/admin.js';
import { buildBase } from '../../src/apps/base.js';
import { config, dependencies } from '../helpers.js';
describe('HTTP routes and response envelope (no Dart runtime)',()=>{
 it('trusts only the adjacent proxy hop when explicitly configured',async()=>{
  for(const hops of [0,1]){
   const app=await buildBase({config:{...config(),httpTrustProxyHops:hops},dependencies:dependencies()});
   app.get('/test-ip',async req=>({ip:req.ip}));
   try{
    const response=await app.inject({url:'/test-ip',remoteAddress:'10.0.0.2',headers:{'x-forwarded-for':'203.0.113.66, 198.51.100.8'}});
    expect(response.json().ip).toBe(hops===1?'198.51.100.8':'10.0.0.2');
   }finally{await app.close();}
  }
 });
 it('uses the client beyond two trusted proxies without accepting a forged earlier address',async()=>{
  const app=await buildBase({config:{...config(),httpTrustProxyHops:2},dependencies:dependencies()});
  app.get('/test-ip',async req=>({ip:req.ip,ips:req.ips}));
  try{
   const address=await app.listen({host:'127.0.0.1',port:0});
   // The loopback socket represents the trusted ingress; the rightmost XFF address is the
   // trusted outer proxy. Only the next address is the client's address.
   for(const forwarded of ['198.51.100.8, 10.0.0.8','203.0.113.66, 198.51.100.8, 10.0.0.8']){
    const response=await fetch(`${address}/test-ip`,{headers:{'x-forwarded-for':forwarded},signal:AbortSignal.timeout(3000)});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ip:'198.51.100.8',ips:['127.0.0.1','10.0.0.8','198.51.100.8']});
   }
  }finally{await app.close();}
 });
 it('exposes health, OpenAPI and trace correlation; API has no business/admin routes',async()=>{
  const app=await buildApiServer({config:config(),dependencies:dependencies()});
  try {
   const r=await app.inject({method:'GET',url:'/health/ready',headers:{'x-trace-id':'trace_docs_fixture'}});
   expect(r.statusCode).toBe(200);expect(r.json()).toEqual({success:true,data:{service:'api-server',status:'ready',version:config().telemetry.version},traceId:'trace_docs_fixture'});
   expect(r.headers['x-trace-id']).toBe('trace_docs_fixture');
   expect(app.swagger().info.version).toBe(config().telemetry.version);
   for(const url of ['/admin','/admin/api/v1','/admin/api/v1/users','/api/v1/home']) expect((await app.inject(url)).statusCode).toBe(404);
   expect(Object.keys(app.swagger().paths ?? {})).toContain('/api/v1/auth/login');
   expect(Object.keys(app.swagger().paths ?? {}).some(p=>p.startsWith('/admin'))).toBe(false);
  } finally {await app.close();}
 });
 it('denies admin independently even with an App Bearer token',async()=>{
  const app=await buildAdminServer({config:config('admin'),dependencies:dependencies()});
  try {
   for(const url of ['/admin','/admin/api/v1','/admin/api/v1/users','/admin/login']) {
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
 it('rejects empty and malformed JSON bodies and requires login fields',async()=>{
  const app=await buildApiServer({config:config(),dependencies:dependencies()});
  try{
   expect((await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:{'content-type':'application/json'}})).statusCode).toBe(400);
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
