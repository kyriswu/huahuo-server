import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { registerInternalApi } from '../../src/http/internal-api.js';
import { DomainError } from '../../src/modules/identity/store.js';

const scopeHeaders=()=>({'x-huahuo-user-id':randomUUID(),'x-huahuo-session-id':randomUUID(),'x-huahuo-auth-method':'bearer'});
describe('internal API scope',()=>{
  it('owns the prefix, requires trusted scope, loads settings and hides routes from public OpenAPI',async()=>{
    const app=Fastify(),enter=vi.fn((done:(error?:Error)=>void)=>done());
    await app.register(swagger,{openapi:{info:{title:'fixture',version:'1'}}});
    app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof DomainError?error.statusCode:500).send({error:error instanceof Error?error.message:'INTERNAL_ERROR'}));
    registerInternalApi(app,internal=>{
      internal.post('/echo',{config:{internalApi:{auth:'trusted-scope',runtimeSettings:true}}},async request=>({userId:request.authScope!.userId}));
    },{enter:async done=>enter(done)});
    try{
      const denied=await app.inject({method:'POST',url:'/internal/v1/echo'});
      expect(denied.statusCode).toBe(401);expect(enter).not.toHaveBeenCalled();
      const headers=scopeHeaders(),response=await app.inject({method:'POST',url:'/internal/v1/echo',headers});
      expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({userId:headers['x-huahuo-user-id']});
      expect(response.headers['cache-control']).toBe('no-store');expect(enter).toHaveBeenCalledOnce();
      expect((await app.inject({method:'POST',url:'/echo',headers})).statusCode).toBe(404);
      expect((await app.inject({url:'/internal/v1/missing'})).statusCode).toBe(404);
      expect(app.swagger().paths).not.toHaveProperty('/internal/v1/echo');
    }finally{await app.close();}
  });
  it('runs business capability authorization before reading malformed JSON',async()=>{
    const app=Fastify(),authorize=vi.fn(async()=>{throw new DomainError(404,'CAPABILITY_NOT_FOUND');});
    app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof DomainError?error.statusCode:500).send({error:error instanceof Error?error.message:'INTERNAL_ERROR'}));
    registerInternalApi(app,internal=>internal.post('/callback',{config:{internalApi:{auth:'parser-capability',authorize}}},async()=>({accepted:true})));
    try{
      const response=await app.inject({method:'POST',url:'/internal/v1/callback',headers:{'content-type':'application/json'},payload:'{malformed'});
      expect(response.statusCode).toBe(404);expect(response.json()).toEqual({error:'CAPABILITY_NOT_FOUND'});expect(authorize).toHaveBeenCalledOnce();
    }finally{await app.close();}
  });
  it('validates gateway requests before authorization can rotate or revoke a session',async()=>{
    const app=Fastify(),authorize=vi.fn(async()=>undefined);
    registerInternalApi(app,internal=>internal.get('/gateway',{config:{internalApi:{auth:'gateway-session',authorize}},
      schema:{querystring:{type:'object',properties:{limit:{type:'integer'}}}}},async()=>({ok:true})));
    try{
      expect((await app.inject({url:'/internal/v1/gateway?limit=invalid'})).statusCode).toBe(400);
      expect(authorize).not.toHaveBeenCalled();
      expect((await app.inject({url:'/internal/v1/gateway?limit=1'})).statusCode).toBe(200);
      expect(authorize).toHaveBeenCalledOnce();
    }finally{await app.close();}
  });
  it('refuses registration without an explicit policy',async()=>{
    const app=Fastify();registerInternalApi(app,internal=>{internal.get('/forgotten',async()=>({ok:true}));});
    await expect(app.ready()).rejects.toThrow('INTERNAL_API_POLICY_REQUIRED');await app.close();
  });
  it('refuses a settings-dependent route without settings',async()=>{
    const app=Fastify();registerInternalApi(app,internal=>{internal.post('/query',{config:{internalApi:{auth:'trusted-scope',runtimeSettings:true}}},async()=>({ok:true}));});
    await expect(app.ready()).rejects.toThrow('INTERNAL_API_POLICY_REQUIRED');await app.close();
  });
});
