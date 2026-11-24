import Fastify,{type FastifyError} from 'fastify';
import {failure} from '../../src/contracts/envelope.js';
import { describe,expect,it,vi } from 'vitest';
import { registerIdentityRoutes } from '../../src/modules/identity/routes.js';
import type { IdentityService } from '../../src/modules/identity/service.js';
import type { WorkspaceService } from '../../src/modules/workspaces/service.js';

const uuid='11111111-1111-4111-8111-111111111111';
const body={phone:'13800000001',smsRequestId:uuid,smsCode:'123456',clientType:'app',clientId:'unit-client',agreementAccepted:true,agreementVersion:'test',privacyVersion:'test',clientVersion:'test'};
const response={tokenType:'Bearer',accessToken:'unit-token',refreshToken:'unit-refresh',accessTokenExpiresAt:new Date().toISOString(),expiresIn:900,rotated:false,firstLogin:false,user:{userId:uuid,displayName:'test',phoneMasked:'138****0001'},workspace:{status:'ready',workspaceId:uuid,lastSyncedAt:new Date().toISOString()},timeZone:'UTC'};
function fixture(){
 const app=Fastify({ajv:{customOptions:{removeAdditional:false}}});
 app.setErrorHandler<FastifyError>((error,req,reply)=>reply.code(error.validation?400:500).send(failure(error.validation?'VALIDATION_ERROR':'INTERNAL_ERROR','Request failed',req.id)));
 const sendCode=vi.fn().mockResolvedValue({smsRequestId:uuid,cooldownSeconds:60,providerMode:'live',testCode:'123456'}),login=vi.fn().mockResolvedValue(response);
 registerIdentityRoutes(app,{sendCode,login} as unknown as IdentityService,{} as WorkspaceService);
 return {app,sendCode,login};
}

describe('canonical identity request schemas',()=>{
 it('requires purpose=sign_in and rejects scene or unsupported purposes',async()=>{
  const {app,sendCode}=fixture();
  try{
   const result=await app.inject({method:'POST',url:'/api/v1/auth/sms-code',payload:{phone:body.phone,purpose:'sign_in'}});
   expect(result.statusCode).toBe(200);
   expect(result.json().data).toEqual({smsRequestId:uuid,cooldownSeconds:60,providerMode:'live'});
   for(const payload of [{phone:body.phone,scene:'login'},{phone:body.phone,purpose:'sign_up'},{phone:body.phone,purpose:'sign_in',scene:'login'}]){
    expect((await app.inject({method:'POST',url:'/api/v1/auth/sms-code',payload})).statusCode).toBe(400);
   }
   expect(sendCode).toHaveBeenCalledTimes(1);
  }finally{await app.close();}
 });
 it('serializes a Feishu receipt without exposing the code',async()=>{
  const {app,sendCode}=fixture();
  sendCode.mockResolvedValueOnce({smsRequestId:uuid,cooldownSeconds:60,providerMode:'mock',testCode:'123456'});
  try{
   const result=await app.inject({method:'POST',url:'/api/v1/auth/sms-code',payload:{phone:body.phone,purpose:'sign_in'}});
   expect(result.statusCode).toBe(200);
   expect(result.json().data).toEqual({smsRequestId:uuid,cooldownSeconds:60,providerMode:'mock'});
  }finally{await app.close();}
 });
 it('requires clientType and clientId, and rejects deviceId aliases',async()=>{
  const {app,login}=fixture();
  try{
   expect((await app.inject({method:'POST',url:'/api/v1/auth/login',payload:body})).statusCode).toBe(200);
   const {clientType:_,clientId:__,...old}=body;void _;void __;
   for(const payload of [{...old,deviceId:'legacy-device'},{...body,deviceId:'legacy-device'},{...body,clientType:'api'},{...body,clientId:''}]){
    expect((await app.inject({method:'POST',url:'/api/v1/auth/login',payload})).statusCode).toBe(400);
   }
   expect(login).toHaveBeenCalledTimes(1);expect(login.mock.calls[0]?.[0]).toMatchObject({clientType:'app',clientId:'unit-client'});
  }finally{await app.close();}
 });
});
