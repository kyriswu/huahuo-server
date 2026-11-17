import {describe,it,expect} from 'vitest';
import {Writable} from 'node:stream';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createErrorSerializer,type DiagnosticError} from '../../src/lib/error-log.js';
import {DomainError} from '../../src/lib/domain-error.js';
import {buildBase} from '../../src/apps/base.js';
import {config,dependencies} from '../helpers.js';

function evidence(name:string,body:string){
 const directory=process.env.ERROR_DIAGNOSTICS_EVIDENCE_DIR;
 if(directory){mkdirSync(directory,{recursive:true});writeFileSync(join(directory,name),body);}
}

describe('bounded redacted error diagnostics',()=>{
 it('retains the original type, message, stack, code and nested cause without driver payloads',()=>{
  const root=Object.assign(new TypeError('socket connection failed'),{code:'ECONNREFUSED',query:'private SQL',parameters:['private row'],detail:'private row',headers:{authorization:'private header'},config:{apiKey:'private config'},response:{body:'private response'}});
  const error=new Error('upstream request failed',{cause:root});
  const result=createErrorSerializer(config(),{})(error);
  expect(result).toMatchObject({type:'Error',message:'upstream request failed',cause:{type:'TypeError',message:'socket connection failed',code:'ECONNREFUSED'}});
  expect(result.stack).toMatch(/error-log\.test\.ts:\d+:\d+/);expect(result.cause!.stack).toContain('TypeError: socket connection failed');
  expect(JSON.stringify(result)).not.toMatch(/private SQL|private row|private header|private config|private response|parameters|headers/);
 });
 it('masks configured secrets wherever they occur, including encoded and escaped forms',()=>{
  const cfg=config(),secret='actual-model-key-special&value';cfg.rag.embeddingApiKey=secret;
  const nodeToken='actual-node-secret-value';
  const result=createErrorSerializer(cfg,{PROCESSING_NODE_TOKEN_TEST:nodeToken})(new Error(`model ${secret} encoded ${encodeURIComponent(secret)} node ${nodeToken} app ${cfg.appTokenSecret}`));
  const body=JSON.stringify(result);expect(body).toContain('[REDACTED]');
  for(const value of [secret,encodeURIComponent(secret),nodeToken,cfg.appTokenSecret!])expect(body).not.toContain(value);
 });
 it('redacts connection credentials, signed URL values, auth headers and personal contact details',()=>{
  const message='connect postgresql://user:short@db.test/app failed\nfetch https://oss.test/file?OSSAccessKeyId=secret-id&Signature=secret-signature#private-fragment\nAuthorization: Bearer bearer-private-token\nCookie: session=private-cookie\npassword="quoted password"\napi_key=private-key\ncontact person@example.com +8613812345678';
  const body=JSON.stringify(createErrorSerializer(config(),{})(new Error(message)));
  expect(body).toContain('db.test/app');expect(body).toContain('oss.test/file');
  for(const value of ['user:short','secret-id','secret-signature','private-fragment','bearer-private-token','private-cookie','quoted password','private-key','person@example.com','13812345678'])expect(body).not.toContain(value);
 });
 it('masks SQL and provider payload dumps embedded in a diagnostic message',()=>{
  const body=JSON.stringify(createErrorSerializer(config(),{})(new Error('Failed query: SELECT private-column FROM private-table\nparams: private-row-value\nresponse_body: private-provider-body\nprivate_key="private-key-value"')));
  expect(body).toContain('Failed query: [REDACTED]');
  expect(body).not.toMatch(/private-column|private-table|private-row-value|private-provider-body|private-key-value/);
 });
 it('redacts PEM and escaped multi-line configured secrets',()=>{
  const cfg=config(),pem='-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----';cfg.jwt.privateKeyPem=pem;
  const body=JSON.stringify(createErrorSerializer(cfg,{})(new Error(pem+'\n'+JSON.stringify(pem))));
  expect(body).not.toContain('private-material');expect(body).not.toContain('PRIVATE KEY');
 });
 it('limits recursive causes, aggregates, huge messages and cycles without throwing',()=>{
  const error=new AggregateError(Array.from({length:20},()=>new Error('x'.repeat(100000))),'many failures');
  Object.defineProperty(error,'cause',{value:error});
  const result=createErrorSerializer(config(),{})(error);
  expect(result.errors).toHaveLength(3);expect(result.cause!.message).toBe('[Circular error]');expect(JSON.stringify(result).length).toBeLessThan(36000);
  let nested:Error=new Error('deep');for(let n=0;n<10;n++)nested=new Error('wrapper',{cause:nested});
  expect(JSON.stringify(createErrorSerializer(config(),{})(nested))).toContain('[Cause depth limit]');
 });
 it('survives throwing diagnostic getters and non-Error thrown values',()=>{
  const hostile=Object.create(null) as object;for(const key of ['message','stack','cause','code','constructor','errors'])Object.defineProperty(hostile,key,{get(){throw Error('getter');}});
  const serialize=createErrorSerializer(config(),{});
  expect(()=>serialize(hostile)).not.toThrow();expect(serialize(null).message).toBe('Non-Error value thrown');expect(serialize('plain thrown error').message).toBe('plain thrown error');
 });
 it('adds a cause without changing DomainError commit behavior or its public code',()=>{
  const root=new Error('provider refused connection'),failure=new DomainError(503,'PROVIDER_UNAVAILABLE',false,{cause:root});
  expect(failure.cause).toBe(root);expect(failure.commit).toBe(false);expect(failure.message).toBe('PROVIDER_UNAVAILABLE');
  expect(new DomainError(429,'LIMITED',true).commit).toBe(true);
 });
});

interface LogRow{level:number;service:string;service_instance_id:string;traceId:string;msg:string;errorCode?:string;method?:string;route?:string;statusCode?:number;err?:DiagnosticError;}
describe('error diagnostics through the real Fastify HTTP logger',()=>{
 it.each(['api-server','admin','worker','scheduler'] as const)('%s correlates one redacted 500 with its response and route template',async role=>{
  const cfg={...config(role),logLevel:'info'},lines:string[]=[];
  const stream=new Writable({write(chunk,_encoding,done){lines.push(String(chunk));done();}});
  const app=await buildBase({config:cfg,dependencies:dependencies(),loggerStream:stream});
  const cause=Object.assign(new Error(`database failed password=driver-password\nsecret value ${cfg.appTokenSecret}`),{code:'ECONNREFUSED',detail:'do not serialize private row'});
  app.get('/broken/:id',async()=>{throw new TypeError('failed to read upstream data',{cause});});
  app.get('/dependency',async()=>{throw new DomainError(503,'UPSTREAM_UNAVAILABLE',false,{cause});});
  app.get('/expected',async()=>{throw new DomainError(400,'INVALID_INPUT');});
  const base=await app.listen({host:'127.0.0.1',port:0});
  try{
   const traceId='diagnostic-trace-'+role;
   const response=await fetch(base+'/broken/private-resource-id?token=private-query-value',{headers:{authorization:'Bearer request-private-credential',cookie:'session=request-private-cookie','x-trace-id':traceId}});
   const body=await response.text();expect(response.status).toBe(500);expect(response.headers.get('x-trace-id')).toBe(traceId);
   expect(JSON.parse(body)).toMatchObject({success:false,traceId,error:{code:'INTERNAL_ERROR',message:'Service temporarily unavailable'}});
   expect(body).not.toMatch(/TypeError|upstream data|ECONNREFUSED|stack|driver-password/);
   const errorRows=lines.join('').trim().split('\n').map(line=>JSON.parse(line) as LogRow).filter(row=>row.level===50);
   expect(errorRows).toHaveLength(1);const log=errorRows[0]!;
   expect(log).toMatchObject({service:cfg.metrics.service,role,env:'test',version:cfg.telemetry.version,service_instance_id:cfg.instanceId,traceId,errorCode:'INTERNAL_ERROR',method:'GET',route:'/broken/:id',statusCode:500,err:{type:'TypeError',message:'failed to read upstream data',cause:{code:'ECONNREFUSED'}}});
   expect(log).not.toHaveProperty('instanceId');
   expect(log.err!.stack).toMatch(/error-log\.test\.ts:\d+:\d+/);
   expect(log.err!.cause!.stack).toContain('database failed');
   await (await fetch(base+'/dependency',{headers:{'x-trace-id':'dependency-trace-'+role}})).text();
   expect((await fetch(base+'/expected')).status).toBe(400);expect((await fetch(base+'/missing')).status).toBe(404);
   const logs=lines.join(''),allRows=logs.trim().split('\n').map(line=>JSON.parse(line) as LogRow),failures=allRows.filter(row=>row.level===50);
   expect(failures).toHaveLength(2);expect(failures[1]).toMatchObject({statusCode:503,errorCode:'UPSTREAM_UNAVAILABLE',traceId:'dependency-trace-'+role,err:{type:'DomainError',cause:{code:'ECONNREFUSED'}}});
   for(const value of ['request-private-credential','request-private-cookie','private-resource-id','private-query-value','driver-password','do not serialize private row',cfg.appTokenSecret!])expect(logs).not.toContain(value);
   evidence(role+'.jsonl',logs);evidence(role+'-500-response.json',body+'\n');
  }finally{await app.close();stream.end();}
 });
});
