import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Redis} from 'ioredis';
import {loadTestConfig as loadConfig} from '../sms-fixture.js';
import {extractionConfig} from '../support/extraction-config.js';
import {migrate} from '../../src/db/migrate.js';
import {poolFor} from '../../src/plugins/dependencies.js';
import {buildApiServer} from '../../src/apps/api-server.js';
import {RagIngestionJobs} from '../../src/modules/rag/jobs.js';
import {RagIngestionRepository} from '../../src/modules/rag/repository.js';
import {ResourceClaims} from '../../src/modules/storage/resource-claims.js';
import {RedisTemporaryUploads} from '../../src/modules/storage/temporary-uploads.js';
import {TaskEngine} from '../../src/modules/tasks/engine.js';
import {TaskService} from '../../src/modules/tasks/service.js';
import {TaskScheduler} from '../../src/modules/tasks/scheduler.js';
import {BillingService} from '../../src/modules/billing/service.js';
import {TextIngestionService} from '../../src/modules/text-ingestion/service.js';
import {TextIngestionJobs} from '../../src/modules/text-ingestion/jobs.js';
import {mockOssUploadConfig,MockOssStorageAdapter,testOssConfig} from '../support/oss-upload.js';
import {StorageService} from '../../src/modules/storage/service.js';
import {mockKnowledgeIndex} from '../support/kb-index.js';
import {insertFixtureUser,insertFixtureSession,testJwtEnv} from './jwt-fixture.js';
import { fixtureScopeHeaders } from './jwt-fixture.js';
import {sampleExtraction} from '../support/document-extraction.js';
import {DocumentExtractionClient,type ExtractionResponse,type FileContext} from '../../src/integrations/document-extraction.js';
import type {Attempt} from '../../src/modules/tasks/engine.js';
import {RagQueryService} from '../../src/modules/rag/query-service.js';
import {knowledgeIndex} from '../../src/modules/kb/profile.js';
import {ProcessingNodes} from '../../src/modules/processing-nodes/service.js';
import {ParserExecutionDeferred,ParserExecutionError} from '../../src/lib/document-parser-machine/index.js';
import type {KbSnapshot} from '../../src/modules/kb/types.js';
import {decodeDocumentReference,encodeDocumentReference} from '../../src/modules/ingestion/document-reference.js';
import {configureTestMilvus} from '../support/milvus.js';
import {withTraceId} from '../../src/lib/trace.js';
import {AliyunOssStorageAdapter} from '../../src/integrations/object-storage/aliyun-oss.js';
import OSS from 'ali-oss';

const database=process.env.TEST_DATABASE_MIGRATION_URL,redisUrl=process.env.REDIS_QUEUE_URL;
if(!database||!/^huahuo_test_/.test(new URL(database).pathname.slice(1))||!redisUrl||!['127.0.0.1','localhost'].includes(new URL(redisUrl).hostname)||Number(new URL(redisUrl).pathname.slice(1))<10)throw new Error('ISOLATED_REAL_DEPENDENCIES_REQUIRED');
const root=poolFor(loadConfig('migrate',{DATABASE_URL:database})),redis=new Redis(redisUrl,{lazyConnect:true,maxRetriesPerRequest:0});redis.on('error',()=>undefined);
const directory=await mkdtemp(join(tmpdir(),'document-extraction-test-'));
const pdf=Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
type Scenario='success'|'pending'|'get-error'|'unknown-post'|'accepted-without-reply'|'failed-file'|'cancel-error';
let scenario:Scenario='success',baseUrl='',postCount=0,sourceReads=0,deleteCount=0,failGet=false;
let hold=false,lastResponse:ExtractionResponse|undefined,autoCallback=true,getCount=0;
let deliverCallback:((url:string,jobId:string,result:ExtractionResponse)=>Promise<void>)|undefined;
let onGet:(()=>Promise<void>)|undefined;
let beforeAsyncReply:(()=>Promise<void>)|undefined;
let replyJobId:string|undefined;
const requests:Array<{inputs:Array<{kind:string;uri:string;mime_type:string}>;contexts:Array<FileContext|null>;config:unknown;traceId?:string}> = [];
const remoteJobs=new Map<string,{response:ExtractionResponse;cancelled:boolean;consumed?:boolean;callbackUrl:string}>();
const errors:unknown[]=[];
const server=createServer((req,res)=>{void(async()=>{
 req.url=req.url?.replace(/^\/node-[^/]+/,'');
 if(req.url?.startsWith('/source.')){sourceReads++;res.writeHead(200,{'content-type':'application/pdf'});res.end(pdf);return;}
 const jobMatch=/^\/jobs\/([A-Za-z0-9_-]+)(?:\/(result|ack))?$/.exec(req.url??'');
 if(jobMatch){
  if(req.method==='GET')getCount++;
  const job=remoteJobs.get(jobMatch[1]!);if(!job){res.writeHead(404);res.end('{}');return;}
  if(req.method==='DELETE'){deleteCount++;job.cancelled=true;if(scenario==='cancel-error'){scenario='success';res.writeHead(503);res.end('{}');return;}}
  await onGet?.();
  if(failGet&&req.method==='GET'){failGet=false;res.writeHead(503);res.end('{}');return;}
  const state=job.cancelled?'cancelled':hold?'running':'completed';
  if(jobMatch[2]==='ack'){
   if(state==='running'){res.writeHead(409);res.end('{}');return;}
   job.consumed=true;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({job_id:jobMatch[1],state,result_state:'consumed'}));return;
  }
  if(jobMatch[2]==='result'){
   if(job.consumed){res.writeHead(410);res.end('{}');return;}
   res.writeHead(state==='running'?202:200,{'content-type':'application/json'});
   res.end(JSON.stringify({job_id:jobMatch[1],state,...(state==='completed'?{result:job.response}:{})}));
   if(state!=='running')job.consumed=true;return;
  }
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({job_id:jobMatch[1],state,result_state:job.consumed?'consumed':state==='running'?'pending':'available'}));return;
 }
 if(req.method==='POST'&&['/extract','/extract-async'].includes(req.url??'')){
  postCount++;const parts:Buffer[]=[];for await(const b of req)parts.push(Buffer.from(b));
  expect(req.headers['content-type']).toBe('application/json');
  const payload=JSON.parse(Buffer.concat(parts).toString()) as {inputs:Array<{kind:string;uri:string;mime_type:string}>;file_contexts:FileContext[];config?:unknown;callback_url:string};
  const contexts=payload.file_contexts;
  expect(payload.inputs).toHaveLength(contexts.length);
  expect(payload.inputs[0]).toMatchObject({kind:'uri',mime_type:expect.any(String)});
  expect(new URL(payload.inputs[0]!.uri).protocol).toMatch(/^https?:$/);
  expect(payload).not.toHaveProperty('files');
  const config=payload.config??null;requests.push({inputs:payload.inputs,contexts,config,traceId:typeof req.headers['x-trace-id']==='string'?req.headers['x-trace-id']:undefined});
  let body=sampleExtraction(contexts[0]!);lastResponse=body;
  if(scenario==='unknown-post'){res.writeHead(503);res.end('{}');return;}
  if(scenario==='failed-file'){scenario='success';body={summary:{inputs:1,results:0,errors:1},results:[],errors:[{index:0,error:'temporary file failure'}]};}
  if(req.url==='/extract-async'){
   const id=randomUUID(),callbackUrl=payload.callback_url;expect(new URL(callbackUrl).origin).toBe('http://api.internal.test');expect(new URL(callbackUrl).pathname).toMatch(/^\/internal\/v1\/document-parser\/callbacks\//);remoteJobs.set(id,{response:body,cancelled:false,callbackUrl});
   if(scenario==='accepted-without-reply'){res.writeHead(503);res.end('{}');return;}
   await beforeAsyncReply?.();if(autoCallback)await deliverCallback!(callbackUrl,id,body);res.writeHead(202);res.end(JSON.stringify({job_id:replyJobId??id}));return;
  }
  res.writeHead(200);res.end(JSON.stringify(body));return;
 }
 res.writeHead(404);res.end('{}');
 })().catch(error=>{errors.push(error);res.writeHead(500);res.end('{}');});});
let originalNodes:Record<string,unknown>[]=[];
beforeAll(async()=>{vi.spyOn(OSS.prototype,'request').mockRejectedValue(new Error('OSS_NETWORK_FORBIDDEN'));await migrate(loadConfig('migrate',{DATABASE_URL:database}));await redis.connect();originalNodes=(await root.query('SELECT * FROM processing_nodes')).rows;await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw new Error('TEST_ADDRESS');baseUrl=`http://127.0.0.1:${address.port}`;});
afterAll(async()=>{await root.query('UPDATE runtime_configuration SET "values"=\'{}\',revision=revision+1');await root.query('DELETE FROM processing_nodes');for(const row of originalNodes)await root.query('INSERT INTO processing_nodes(id,config,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5)',[row.id,JSON.stringify(row.config),row.revision,row.created_at,row.updated_at]);redis.disconnect();await root.end();await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true});});

async function setup(mode:'sync'|'async',state:Scenario='success',realKeyword=false,serviceDefaults=false){
 scenario=state;autoCallback=state==='success'||state==='failed-file';getCount=0;postCount=0;sourceReads=0;deleteCount=0;failGet=state==='get-error';hold=state==='pending'||state==='cancel-error';onGet=undefined;beforeAsyncReply=undefined;replyJobId=undefined;requests.splice(0);errors.splice(0);remoteJobs.clear();
 const prefix='extract_'+randomUUID().replaceAll('-','');
 const env={...testJwtEnv,APP_ENV:'test',LOG_LEVEL:'silent',APP_PUBLIC_BASE_URL:'http://api.test',API_SERVICE_BASE_URL:'http://api.internal.test',ADMIN_PUBLIC_BASE_URL:'http://admin.test',APP_TOKEN_SECRET:'a'.repeat(48),ADMIN_SESSION_SECRET:'b'.repeat(48),REDIS_CACHE_URL:process.env.REDIS_CACHE_URL,REDIS_QUEUE_URL:redisUrl,REDIS_KEY_PREFIX:prefix,
  RAG_PROVIDER_MODE:'mock',ALLOW_MOCK_PROVIDERS:'true',RAG_SOURCE_ALLOWED_HOSTS:'127.0.0.1,fixture-assets.oss-cn-beijing.aliyuncs.com',STORAGE_DRIVER:'local',STORAGE_LOCAL_ROOT:join(directory,prefix),
  };
 const apiConfig=loadConfig('api-server',{...env,DATABASE_URL:process.env.TEST_DATABASE_API_URL}),workerConfig=loadConfig('worker',{...env,DATABASE_URL:process.env.TEST_DATABASE_WORKER_URL});
 if(realKeyword)for(const cfg of [apiConfig,workerConfig])configureTestMilvus(cfg);
 const extraction=extractionConfig(mode);if(!extraction.enabled)throw Error('TEST_CONFIG_REQUIRED');
 await root.query('UPDATE runtime_configuration SET "values"=\'{}\',revision=revision+1');
 const documentApi={mode:'async' as const,parameters:serviceDefaults?null:extraction.parameters,timeoutSeconds:3120,pollMs:100,maxResponseBytes:67108864};
 await root.query('DELETE FROM processing_nodes');
 const nodeId=randomUUID(),nodePrefix=prefix+':processing-node:{'+nodeId+'}';
 await root.query('INSERT INTO processing_nodes(id,config) VALUES($1,$2)',[nodeId,JSON.stringify({documentApi,name:'loopback parser',capabilities:['document'],resourceClass:'cpu',mode:'always-on',regionId:null,instanceId:null,privateIp:null,baseUrl:baseUrl+'/node-'+prefix,healthPath:'',tokenEnv:null,eciFallback:null,concurrency:1,idleSeconds:60,startupSeconds:600,queueSeconds:3600})]);
 apiConfig.rag.enabled=true;workerConfig.rag.enabled=true;
 const apiPool=poolFor(apiConfig),workerPool=poolFor(workerConfig),storage=new MockOssStorageAdapter(workerConfig.storageLocalRoot),memory=mockKnowledgeIndex();
 const deps={index:(snapshot:KbSnapshot)=>realKeyword?knowledgeIndex(apiConfig,snapshot):memory.keyword,
  embedding:()=>{throw new Error('DOCUMENT_PATH_MUST_NOT_USE_EMBEDDING');},tokenizer:()=>{throw new Error('DOCUMENT_PATH_MUST_NOT_USE_MODEL_TOKENIZER');}};
 const pipeline=new RagIngestionJobs(workerPool,workerConfig,storage,{kb:deps});
 const engine=new TaskEngine(workerPool,120000,undefined,undefined,undefined,pipeline);
 const userId=await insertFixtureUser(root),sessionId=randomUUID(),workspaceId=randomUUID();const bearer=await insertFixtureSession(root,userId,sessionId);
 await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'Extraction test',true,$3)",[workspaceId,userId,randomUUID()]);
 const uploads=new RedisTemporaryUploads(apiConfig),claims=new ResourceClaims(apiConfig,uploads);
 const scope={userId,sessionId,traceId:randomUUID()},repository=new RagIngestionRepository(apiPool,apiConfig,claims);
 const api=await buildApiServer({config:apiConfig});
 deliverCallback=async(url,id,result)=>{const target=new URL(url),response=await api.inject({method:'POST',url:target.pathname+target.search,payload:{event:'extraction.completed',event_id:randomUUID(),job_id:id,state:'completed',result}});expect(response.statusCode,response.body).toBe(200);if(target.searchParams.has('traceId')){expect(response.headers['x-trace-id']).toBe(target.searchParams.get('traceId'));expect(response.json().traceId).toBe(target.searchParams.get('traceId'));}};
 const start=async()=>{
  const response=await api.inject({method:'POST',url:'/api/v1/rag/ingestions',headers:{...fixtureScopeHeaders(bearer),'x-idempotency-key':randomUUID()},payload:{ossUrl:baseUrl+'/source.pdf',fileName:'source.pdf',mimeType:'application/pdf'}});
  expect(response.statusCode,response.body).toBe(200);return response.json().data as {jobId:string;documentVersionId:string};
 };
 const attempt=async(id:string)=>vi.waitFor(async()=>{const a=await engine.claim(id,randomUUID());expect(a,a?undefined:JSON.stringify((await root.query('SELECT state,attempt_no,max_attempts,available_at,clock_timestamp() AS clock,external_state FROM tasks WHERE id=$1',[id])).rows)).not.toBeNull();return a!;},{interval:20,timeout:3000});
 const run=(a:Attempt,executor=engine)=>withTraceId(a.task.trace_id,async()=>{for(let phase=0;phase<6;phase++){try{await executor.execute(a);}catch(error){const e=error as {code?:string;retryable?:boolean};await executor.fail(a,e.code??'TEST_FAILED',e.retryable!==false);return error;}
  const row=(await root.query('SELECT state FROM tasks WHERE id=$1',[a.task.id])).rows[0];const ready=(await root.query('SELECT 1 FROM document_parse_callbacks WHERE task_id=$1 AND terminal_state IS NOT NULL AND NOT consumed',[a.task.id])).rowCount;
  if(!ready||!['waiting_external','reconciling'].includes(row.state))return undefined;a=await attempt(a.task.id);
 }throw Error('TEST_PHASE_LIMIT');});
 const task=async(id:string)=>(await root.query('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];
 const close=async()=>{deliverCallback=undefined;onGet=undefined;beforeAsyncReply=undefined;await api.close();await pipeline.close();await uploads.close();await Promise.all([apiPool.end(),workerPool.end()]);const keys=await redis.keys(prefix+':*');if(keys.length)await redis.del(...keys);};
 return {apiConfig,workerConfig,apiPool,workerPool,storage,uploads,deps,pipeline,engine,scope,workspaceId,bearer,repository,api,start,attempt,run,task,close,prefix,nodePrefix,nodeId,documentApi};
}

describe('existing document workflows: real isolated PG/Redis/storage, loopback fake parser, no private requests',()=>{
 it('runs existing authenticated PDF ingestion end to end and preserves exact KB output/receipts',async()=>{
  const s=await setup('sync');try{
   const created=await s.start(),version=(await root.query('SELECT processing_snapshot FROM rag_ingestion_versions WHERE id=$1',[created.documentVersionId])).rows[0];
   const parser=version.processing_snapshot.parser;expect(parser.sourceResourceId).toBe(created.documentVersionId);expect(parser.parseRunId).toMatch(/^[a-f0-9-]{36}$/);
   expect(await s.run(await s.attempt(created.jobId))).toBeUndefined();expect((await s.task(created.jobId)).state).toBe('succeeded');
   const traceId=(await s.task(created.jobId)).trace_id;expect(traceId).toMatch(/^[a-f0-9-]{36}$/);expect(requests[0]!.traceId).toBe(traceId);
   expect(new URL([...remoteJobs.values()][0]!.callbackUrl).searchParams.get('traceId')).toBe(traceId);
   expect(postCount).toBe(1);expect(sourceReads).toBe(0);expect(requests[0]!.config).toEqual(s.documentApi.parameters);expect(parser).not.toHaveProperty('extraction');
   expect(requests[0]!.contexts).toEqual([{source_resource_id:parser.sourceResourceId,parse_run_id:parser.parseRunId}]);
   const row=(await root.query('SELECT * FROM rag_ingestion_versions WHERE id=$1',[created.documentVersionId])).rows[0];
   const chunks:Buffer[]=[];for await(const chunk of await s.storage.read(row.canonical_content_uri))chunks.push(Buffer.from(chunk));expect(Buffer.concat(chunks).toString()).toBe(lastResponse!.results[0]!.content);
   const assets=(await root.query('SELECT * FROM rag_document_assets WHERE version_id=$1',[created.documentVersionId])).rows;
   expect(assets).toHaveLength(1);expect(assets[0]).toMatchObject({upload_status:'ready',char_start:null,char_end:null});
   const assetConfig={...s.apiConfig,storageDriver:'aliyun-oss' as const,storageAliyunOss:{region:'cn-beijing',endpoint:'https://oss.example.invalid',bucket:'fixture-bucket',accessKeyId:'test',accessKeySecret:'test',secure:true,timeoutMs:1000,keyPrefix:'fixture-resources',maxBytes:100000}};
   const assetRepository=new RagIngestionRepository(s.apiPool,assetConfig);
   const read=vi.fn(async()=>{throw new Error('DOWNLOAD_PROXY_FORBIDDEN');}),signUrl=vi.fn(async(key:string)=>`https://signed.test/${key}`),directStorage={read,signUrl};
   const imageLink=await assetRepository.asset(s.scope,created.jobId,assets[0].id,directStorage);
   expect(imageLink).toMatchObject({url:`https://signed.test/${assets[0].id}`,mimeType:assets[0].mime_type,sizeBytes:Number(assets[0].byte_size)});
   expect(signUrl).toHaveBeenCalledExactlyOnceWith(assets[0].id,900);
   const extractionLink=await assetRepository.extraction(s.scope,created.jobId,directStorage);
   expect(extractionLink).toMatchObject({url:`https://signed.test/${row.parse_artifact_uri}`,mimeType:'application/json',contentEncoding:'gzip'});
   expect(signUrl).toHaveBeenLastCalledWith(row.parse_artifact_uri,900,{contentEncoding:'gzip'});expect(read).not.toHaveBeenCalled();
   await expect(assetRepository.asset(s.scope,created.jobId,randomUUID(),directStorage)).rejects.toMatchObject({code:'RESOURCE_NOT_FOUND'});
   await expect(new RagIngestionRepository(s.apiPool,{...assetConfig,storageAliyunOss:{...assetConfig.storageAliyunOss,bucket:'other-bucket'}}).asset(s.scope,created.jobId,assets[0].id,directStorage)).rejects.toMatchObject({code:'DOCUMENT_ASSET_STORAGE_UNAVAILABLE'});
   await expect(new RagIngestionRepository(s.apiPool,{...assetConfig,storageAliyunOss:{...assetConfig.storageAliyunOss,keyPrefix:'other-prefix'}}).asset(s.scope,created.jobId,assets[0].id,directStorage)).rejects.toMatchObject({code:'DOCUMENT_ASSET_STORAGE_UNAVAILABLE'});
   expect(signUrl).toHaveBeenCalledTimes(2);expect(read).not.toHaveBeenCalled();
   expect(Number((await root.query('SELECT count(*) FROM kb_document_keyword_builds WHERE source_id=$1 AND published',[created.documentVersionId])).rows[0].count)).toBe(1);
   const assetApi=await buildApiServer({config:assetConfig}),readObject=vi.spyOn(AliyunOssStorageAdapter.prototype,'read').mockRejectedValue(new Error('DOWNLOAD_PROXY_FORBIDDEN'));
   try{
    const extractionPath=`/api/v1/rag/ingestions/${created.jobId}/extraction`,assetPath=`/api/v1/rag/ingestions/${created.jobId}/assets/${assets[0].id}`;
    const response=await assetApi.inject({method:'GET',url:extractionPath,headers:fixtureScopeHeaders(s.bearer)});
    expect(response.statusCode,response.body).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
    const data=response.json().data,signed=new URL(data.url);expect(data).toMatchObject({mimeType:'application/json',contentEncoding:'gzip'});
    expect(signed.pathname).toBe(`/fixture-resources/${row.parse_artifact_uri}`);expect(signed.searchParams.has('response-content-type')).toBe(false);expect(signed.searchParams.get('response-content-encoding')).toBe('gzip');
    expect(response.body).not.toContain('data_base64');expect(data).not.toHaveProperty('results');expect(Date.parse(data.expiresAt)).toBeGreaterThan(Date.now());
    const imageResponse=await assetApi.inject({method:'GET',url:assetPath,headers:fixtureScopeHeaders(s.bearer)});
    expect(imageResponse.statusCode,imageResponse.body).toBe(200);expect(imageResponse.headers['cache-control']).toBe('no-store');
    expect(imageResponse.json().data).toMatchObject({mimeType:assets[0].mime_type,sizeBytes:Number(assets[0].byte_size)});
    expect(new URL(imageResponse.json().data.url).pathname).toBe(`/fixture-resources/${assets[0].id}`);
    expect(new URL(imageResponse.json().data.url).searchParams.has('response-content-type')).toBe(false);
    const other=await insertFixtureUser(root),otherToken=await insertFixtureSession(root,other,randomUUID());
    for(const url of [extractionPath,assetPath])expect((await assetApi.inject({method:'GET',url,headers:fixtureScopeHeaders(otherToken)})).statusCode).toBe(404);
    expect((await assetApi.inject({method:'GET',url:`/api/v1/rag/ingestions/${randomUUID()}/extraction`,headers:fixtureScopeHeaders(s.bearer)})).statusCode).toBe(404);
    expect((await assetApi.inject({method:'GET',url:`/api/v1/rag/ingestions/${created.jobId}/assets/${randomUUID()}`,headers:fixtureScopeHeaders(s.bearer)})).statusCode).toBe(404);
    await s.repository.action(s.scope,created.jobId,'delete');
    for(const url of [extractionPath,assetPath])expect((await assetApi.inject({method:'GET',url,headers:fixtureScopeHeaders(s.bearer)})).statusCode).toBe(404);
    expect(readObject).not.toHaveBeenCalled();
   }finally{readObject.mockRestore();await assetApi.close();}
   expect(errors).toHaveLength(0);
  }finally{await s.close();}
 });
 it('releases the Worker lease immediately while keeping the remote slot, then resumes from a callback without GET',async()=>{
  const s=await setup('async','pending');try{
   const created=await s.start(),first=await s.attempt(created.jobId);
   expect(await s.engine.execute(first)).toBe(false);const waiting=await s.task(created.jobId);
   expect(waiting).toMatchObject({state:'waiting_external',lease_owner:null,external_state:'submitted',attempt_no:1,resume_count:0});
   expect(getCount).toBe(0);expect(postCount).toBe(1);expect(await s.engine.heartbeat(first)).toBe(false);
   expect(await redis.zcard(s.nodePrefix+':active')).toBe(1);
   const [id,remote]=[...remoteJobs][0]!;await deliverCallback!(remote.callbackUrl,id,remote.response);
   const due=(await root.query("SELECT available_at<=clock_timestamp() AS due FROM task_outbox WHERE task_id=$1 AND status='pending'",[created.jobId])).rows[0];expect(due.due).toBe(true);
   expect(await s.run(await s.attempt(created.jobId))).toBeUndefined();
   const done=await s.task(created.jobId);expect(done).toMatchObject({state:'succeeded',attempt_no:2,resume_count:1});expect(getCount).toBe(0);expect(sourceReads).toBe(0);
   expect(await redis.zcard(s.nodePrefix+':active')).toBe(0);expect(errors).toHaveLength(0);
  }finally{await s.close();}
 });
 it('performs bounded fallback GET after a lost callback, keeps original node settings and never redownloads or resubmits',async()=>{
  const s=await setup('async','get-error');try{
   const created=await s.start();expect(await s.run(await s.attempt(created.jobId))).toBeUndefined();expect((await s.task(created.jobId)).state).toBe('waiting_external');expect(getCount).toBe(0);
   await root.query("UPDATE tasks SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[created.jobId]);
   expect(await s.run(await s.attempt(created.jobId))).toBeTruthy();expect((await s.task(created.jobId)).state).toBe('reconciling');
   await root.query(`UPDATE processing_nodes SET config=jsonb_set(config,'{documentApi,timeoutSeconds}','4000'),revision=revision+1 WHERE id=$1`,[s.nodeId]);
   await root.query("UPDATE tasks SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[created.jobId]);
   expect(await s.run(await s.attempt(created.jobId))).toBeUndefined();expect(postCount).toBe(1);expect(sourceReads).toBe(0);expect((await s.task(created.jobId)).state).toBe('succeeded');
  }finally{await s.close();}
 });
 it('retains ambiguous submission without a job ID and never blindly reclaims/resubmits it',async()=>{
  const s=await setup('async','unknown-post');try{
   const created=await s.start();expect(await s.run(await s.attempt(created.jobId))).toBeTruthy();const task=await s.task(created.jobId);
   expect(task).toMatchObject({state:'reconciling',external_state:'unknown'});expect(task.external_reference).toMatch(/^xberg-intent:/);
   await root.query("UPDATE tasks SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[created.jobId]);expect(await s.engine.claim(created.jobId,randomUUID())).toBeNull();expect(postCount).toBe(1);
   expect(await redis.zcard(s.nodePrefix+':active')).toBe(1);
  }finally{await s.close();}
 });
 it('recovers an accepted submission using its authenticated durable callback without another POST',async()=>{
  const s=await setup('async','accepted-without-reply');try{
   const created=await s.start();expect(await s.run(await s.attempt(created.jobId))).toBeTruthy();
   const before=await s.task(created.jobId);expect(before.external_reference).toMatch(/^xberg-intent:/);
   expect(await s.engine.claim(created.jobId,randomUUID())).toBeNull();
   const [jobId,job]=[...remoteJobs.entries()][0]!,url=new URL(job.callbackUrl).pathname;
   const payload={event:'extraction.completed',event_id:randomUUID(),job_id:jobId,state:'completed',result:job.response};
   const callbacks=await Promise.all([s.api.inject({method:'POST',url,payload}),s.api.inject({method:'POST',url,payload})]);
   expect(callbacks.map(r=>r.statusCode)).toEqual([200,200]);expect(callbacks.map(r=>r.json().data.duplicate).sort()).toEqual([false,true]);
   const bound=await s.task(created.jobId);expect(bound).toMatchObject({state:'reconciling',external_state:'submitted',version:before.version});
   expect(decodeDocumentReference(bound.external_reference)).toMatchObject({phase:'job',jobId});
   expect((await s.api.inject({method:'POST',url,payload:{...payload,job_id:randomUUID()}})).statusCode).toBe(409);
   expect((await s.api.inject({method:'POST',url,payload:{event:'extraction.failed',event_id:randomUUID(),job_id:jobId,state:'failed'}})).statusCode).toBe(409);
   expect(await s.run(await s.attempt(created.jobId))).toBeUndefined();expect((await s.task(created.jobId)).state).toBe('succeeded');
   expect(postCount).toBe(1);expect(sourceReads).toBe(0);expect(getCount).toBe(0);expect(await redis.zcard(s.nodePrefix+':active')).toBe(0);
   expect((await root.query('SELECT count(*)::int AS n FROM task_results WHERE task_id=$1',[created.jobId])).rows[0].n).toBe(1);
   expect((await root.query('SELECT settled FROM processing_node_assignments WHERE request_id=$1',[decodeDocumentReference(bound.external_reference)!.requestId])).rows[0].settled).toBe(true);
   expect((await s.api.inject({method:'POST',url,payload})).json().data.duplicate).toBe(true);expect(await s.engine.claim(created.jobId,randomUUID())).toBeNull();
  }finally{await s.close();}
 });
 it('lets Scheduler recover a lost Worker after a callback binds its still-running intent',async()=>{
  const s=await setup('async','accepted-without-reply');try{
   const created=await s.start(),attempt=await s.attempt(created.jobId);
   // Leave the attempt running to model exit before Worker error bookkeeping.
   await expect(s.engine.execute(attempt)).rejects.toBeTruthy();
   const [jobId,job]=[...remoteJobs.entries()][0]!;
   await deliverCallback!(job.callbackUrl,jobId,job.response);expect((await s.task(created.jobId)).state).toBe('running');
   await root.query("UPDATE tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[created.jobId]);
   await new TaskScheduler(s.workerPool,{publish:async()=>undefined}).recover();
   expect(await s.task(created.jobId)).toMatchObject({state:'reconciling',lease_owner:null,external_state:'submitted'});
   expect(await s.run(await s.attempt(created.jobId))).toBeUndefined();expect((await s.task(created.jobId)).state).toBe('succeeded');
   expect(postCount).toBe(1);expect(getCount).toBe(0);expect(await redis.zcard(s.nodePrefix+':active')).toBe(0);
  }finally{await s.close();}
 });
 it.each([false,true])('keeps an early callback receipt when the POST reply arrives later (conflicting reply=%s)',async conflicting=>{
  const s=await setup('async');autoCallback=false;let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});beforeAsyncReply=()=>gate;
  try{
   const created=await s.start(),attempt=await s.attempt(created.jobId);
   const operation=s.engine.execute(attempt).catch(async error=>{await s.engine.fail(attempt,error.code??'TEST_FAILED',true);});
   await vi.waitFor(()=>expect(remoteJobs.size).toBe(1),{interval:10,timeout:3000});
   const before=await s.task(created.jobId),[jobId,job]=[...remoteJobs.entries()][0]!;
   const callback=await s.api.inject({method:'POST',url:new URL(job.callbackUrl).pathname,payload:{event:'extraction.completed',event_id:randomUUID(),job_id:jobId,state:'completed',result:job.response}});
   expect(callback.statusCode,callback.body).toBe(200);
   expect(await s.task(created.jobId)).toMatchObject({state:'running',version:before.version,lease_owner:before.lease_owner,lease_until:before.lease_until});
   if(conflicting)replyJobId=randomUUID();release();await operation;
   expect(decodeDocumentReference((await s.task(created.jobId)).external_reference)).toMatchObject({phase:'job',jobId});
   await root.query("UPDATE tasks SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[created.jobId]);
   expect(await s.run(await s.attempt(created.jobId))).toBeUndefined();expect((await s.task(created.jobId)).state).toBe('succeeded');
   expect(postCount).toBe(1);expect(getCount).toBe(0);expect(await redis.zcard(s.nodePrefix+':active')).toBe(0);
  }finally{release();await s.close();}
 });
 it('preserves cancellation when an ambiguous submission and its completed callback race',async()=>{
  const s=await setup('async','accepted-without-reply');try{
   const created=await s.start();
   const billing=new BillingService(s.apiPool,{...s.apiConfig,billingMode:'development'});
   const reservation=await billing.reserveCredits({userId:s.scope.userId,taskId:created.jobId,reservationKey:`task:${created.jobId}`,requestedCredits:5n});
   await root.query('UPDATE tasks SET reservation_id=$2 WHERE id=$1',[created.jobId,reservation.reservationId]);
   expect(await s.run(await s.attempt(created.jobId))).toBeTruthy();
   expect((await root.query('SELECT status FROM credit_reservations WHERE reservation_id=$1',[reservation.reservationId])).rows[0].status).toBe('reserved');
   const [jobId,job]=[...remoteJobs.entries()][0]!;
   const [callback]=await Promise.all([
    s.api.inject({method:'POST',url:new URL(job.callbackUrl).pathname,payload:{event:'extraction.completed',event_id:randomUUID(),job_id:jobId,state:'completed',result:job.response}}),
    new TaskService(s.apiPool,s.apiConfig.appTokenSecret!).mutate(s.scope,created.jobId,'cancel',randomUUID(),{}),
   ]);
   expect(callback.statusCode,callback.body).toBe(200);expect((await s.task(created.jobId)).cancel_requested_at).not.toBeNull();
   expect(await s.run(await s.attempt(created.jobId))).toBeTruthy();expect((await s.task(created.jobId)).state).toBe('cancelled');
   expect((await root.query('SELECT status FROM credit_reservations WHERE reservation_id=$1',[reservation.reservationId])).rows[0].status).toBe('released');
   expect((await root.query("SELECT count(*)::int AS n FROM credit_ledger_entries WHERE reservation_id=$1 AND entry_type='release'",[reservation.reservationId])).rows[0].n).toBe(1);
   expect(postCount).toBe(1);expect(deleteCount).toBe(0);expect(await redis.zcard(s.nodePrefix+':active')).toBe(0);
   expect((await root.query('SELECT count(*)::int AS n FROM task_results WHERE task_id=$1',[created.jobId])).rows[0].n).toBe(0);
   expect((await root.query('SELECT canonical_content_uri FROM rag_ingestion_versions WHERE id=$1',[created.documentVersionId])).rows[0].canonical_content_uri).toBeNull();
  }finally{await s.close();}
 });
 it('requires callback authentication and matching submission identity before binding an unknown job',async()=>{
  const s=await setup('async','accepted-without-reply');try{
   const created=await s.start();expect(await s.run(await s.attempt(created.jobId))).toBeTruthy();
   const before=await s.task(created.jobId),reference=decodeDocumentReference(before.external_reference)!;
   const [jobId,job]=[...remoteJobs.entries()][0]!,url=new URL(job.callbackUrl).pathname;
   const payload={event:'extraction.completed',event_id:randomUUID(),job_id:jobId,state:'completed',result:job.response};
   expect((await s.api.inject({method:'POST',url:url.replace('/internal/v1/','/api/v1/'),payload})).statusCode).toBe(404);
   expect((await s.api.inject({method:'POST',url:url.replace(/[^/]+$/,'A'.repeat(43)),payload})).statusCode).toBe(404);
   await root.query('UPDATE tasks SET external_reference=$2 WHERE id=$1',[created.jobId,encodeDocumentReference({...reference,fingerprint:'0'.repeat(64)})]);
   expect((await s.api.inject({method:'POST',url,payload})).statusCode).toBe(409);
   expect((await root.query('SELECT job_id FROM document_parse_callbacks WHERE task_id=$1',[created.jobId])).rows[0].job_id).toBeNull();
   await root.query('UPDATE tasks SET external_reference=$2 WHERE id=$1',[created.jobId,encodeDocumentReference({...reference,requestId:randomUUID()})]);
   expect((await s.api.inject({method:'POST',url,payload})).statusCode).toBe(200);
   expect((await s.task(created.jobId)).external_state).toBe('unknown');expect(await s.engine.claim(created.jobId,randomUUID())).toBeNull();
   // Durable duplicates can repair a matching old intent without overwriting the inbox.
   await root.query('UPDATE tasks SET external_reference=$2 WHERE id=$1',[created.jobId,before.external_reference]);
   expect((await s.api.inject({method:'POST',url,payload})).json().data.duplicate).toBe(true);
   expect(decodeDocumentReference((await s.task(created.jobId)).external_reference)).toMatchObject({phase:'job',jobId});expect(postCount).toBe(1);
  }finally{await s.close();}
 });
 it('recovers pre-submit admission on its original node without submitting twice',async()=>{
  const s=await setup('async');
  const crash=vi.spyOn(ProcessingNodes.prototype,'withNode').mockImplementationOnce(async function(this:ProcessingNodes,capability,input){
   const node=await this.bind(input.requestId,capability),runtime=await this.runtime(node);
   return runtime.machine.withDocumentParser(input,async()=>{throw new ParserExecutionError('TEST_CRASH_BEFORE_SUBMIT');});
  });
  try{
   const created=await s.start();expect(await s.run(await s.attempt(created.jobId))).toBeTruthy();expect(postCount).toBe(0);
   const before=await s.task(created.jobId);expect(before.external_reference).toMatch(/^xberg-bound:/);expect(before.external_state).toBe('none');
   await root.query("UPDATE tasks SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[created.jobId]);
   expect(await s.run(await s.attempt(created.jobId))).toBeUndefined();expect(postCount).toBe(1);
   const assignments=(await root.query('SELECT request_id,settled FROM processing_node_assignments WHERE request_id LIKE $1',[created.jobId+':%'])).rows;
   expect(assignments).toEqual([{request_id:created.jobId+':parse:1',settled:true}]);
  }finally{crash.mockRestore();await s.close();}
 });
 it.each([false,true])('releases unsubmitted admission when its signed URL expires (cancelled=%s)',async cancelled=>{
  const s=await setup('async'),expiry=Math.floor(Date.now()/1000)+3600;
  const defer=vi.spyOn(ProcessingNodes.prototype,'withNode').mockImplementationOnce(async function(this:ProcessingNodes,capability,input){
   const node=await this.bind(input.requestId,capability),runtime=await this.runtime(node);
   return runtime.machine.withDocumentParser(input,async()=>{throw new ParserExecutionDeferred('admitting',1);});
  });
  try{
   const created=await s.repository.create(s.scope,{ossUrl:baseUrl+`/source.pdf?Expires=${expiry}`,fileName:'source.pdf',mimeType:'application/pdf'});
   expect(await s.run(await s.attempt(created.jobId))).toBeUndefined();
   expect((await s.task(created.jobId)).external_reference).toMatch(/^xberg-bound:/);expect(postCount).toBe(0);
   if(cancelled)await new TaskService(s.apiPool,s.apiConfig.appTokenSecret!).mutate(s.scope,created.jobId,'cancel',randomUUID(),{});
   await root.query("UPDATE tasks SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[created.jobId]);
   const next=await s.attempt(created.jobId),clock=vi.spyOn(Date,'now').mockReturnValue(expiry*1000+1);
   try{expect(await s.run(next)).toBeTruthy();}finally{clock.mockRestore();}
   const task=await s.task(created.jobId);
   expect(task).toMatchObject({state:cancelled?'cancelled':'failed',external_state:'none',error_code:cancelled?'TASK_CANCELLED':'RAG_SOURCE_URL_EXPIRED'});
   expect(decodeDocumentReference(task.external_reference)?.phase).toBe(cancelled?'cancelled':'failed');
   expect((await root.query('SELECT settled FROM processing_node_assignments WHERE request_id LIKE $1',[created.jobId+':%'])).rows).toEqual([{settled:true}]);
   expect(await redis.hlen(s.nodePrefix+':jobs')).toBe(0);expect(await redis.zcard(s.nodePrefix+':active')).toBe(0);expect(postCount).toBe(0);expect(sourceReads).toBe(0);
  }finally{defer.mockRestore();await s.close();}
 });
 it('rechecks signed URL expiry immediately before submission and settles without an HTTP POST',async()=>{
  const s=await setup('async'),expiry=Math.floor(Date.now()/1000)+3600,extract=DocumentExtractionClient.prototype.extract;
  const advance=vi.spyOn(DocumentExtractionClient.prototype,'extract').mockImplementationOnce(async function(this:DocumentExtractionClient,...args:Parameters<DocumentExtractionClient['extract']>){
   const clock=vi.spyOn(Date,'now').mockReturnValue(expiry*1000+1);
   try{return await extract.call(this,...args);}finally{clock.mockRestore();}
  });
  try{
   const created=await s.repository.create(s.scope,{ossUrl:baseUrl+`/source.pdf?Expires=${expiry}`,fileName:'source.pdf',mimeType:'application/pdf'});
   expect(await s.run(await s.attempt(created.jobId))).toBeTruthy();
   expect(await s.task(created.jobId)).toMatchObject({state:'failed',external_state:'none',error_code:'RAG_SOURCE_URL_EXPIRED'});
   expect((await root.query('SELECT settled FROM processing_node_assignments WHERE request_id LIKE $1',[created.jobId+':%'])).rows).toEqual([{settled:true}]);
   expect((await root.query('SELECT job_id,consumed FROM document_parse_callbacks WHERE task_id=$1',[created.jobId])).rows).toEqual([{job_id:null,consumed:true}]);
   expect(postCount).toBe(0);expect(sourceReads).toBe(0);expect(await redis.hlen(s.nodePrefix+':jobs')).toBe(0);
  }finally{advance.mockRestore();await s.close();}
 });
 it('reuses both UUIDs and the complete admission snapshot on a safe same-batch retry',async()=>{
  const s=await setup('sync','failed-file');try{
   const created=await s.start();expect(await s.run(await s.attempt(created.jobId))).toBeTruthy();expect((await s.task(created.jobId)).state).toBe('retry_scheduled');
   await root.query(`UPDATE processing_nodes SET config=jsonb_set(config,'{documentApi,parameters,force_ocr}','true'),revision=revision+1 WHERE id=$1`,[s.nodeId]);
   await root.query("UPDATE tasks SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[created.jobId]);
   expect(await s.run(await s.attempt(created.jobId))).toBeUndefined();expect(postCount).toBe(2);expect(requests[0]).toEqual(requests[1]);expect((requests[1]!.config as {force_ocr:boolean}).force_ocr).toBe(false);
  }finally{await s.close();}
 });
 it.each([false,true])('settles cancellation after a terminal status; ambiguous DELETE is not resent (uncertain=%s)',async uncertain=>{
  const s=await setup('async',uncertain?'cancel-error':'pending');try{
   const created=await s.start();expect(await s.run(await s.attempt(created.jobId))).toBeUndefined();
   await new TaskService(s.apiPool,s.apiConfig.appTokenSecret!).mutate(s.scope,created.jobId,'cancel',randomUUID(),{});
   expect(await s.run(await s.attempt(created.jobId))).toBeTruthy();
   if(uncertain){expect((await s.task(created.jobId)).state).toBe('reconciling');await root.query("UPDATE tasks SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[created.jobId]);expect(await s.run(await s.attempt(created.jobId))).toBeTruthy();}
   expect((await s.task(created.jobId)).state).toBe('cancelled');expect(postCount).toBe(1);expect(deleteCount).toBe(1);expect(await redis.zcard(s.nodePrefix+':active')).toBe(0);
   expect(Number((await root.query('SELECT count(*) FROM task_results WHERE task_id=$1',[created.jobId])).rows[0].count)).toBe(0);
  }finally{await s.close();}
 });
 it.each([['pdf','application/pdf'],['txt','text/plain'],['md','text/markdown'],['csv','text/csv']])('sends FILE_UPLOAD %s as a URL to the external extractor without source reads',async(ext,mime)=>{
  const s=await setup('async');const text=new TextIngestionJobs(s.workerPool,s.workerConfig,s.deps);
  try{
   s.apiConfig.rag.providerMode='disabled';s.workerConfig.rag.providerMode='disabled';
   const service=new TextIngestionService(s.apiPool,s.apiConfig),job=await service.create(s.scope,{source_type:'FILE_UPLOAD',origin_resource_uri:baseUrl+'/source.'+ext},randomUUID());
   const row=(await root.query('SELECT current_task_id FROM text_ingestion_jobs WHERE id=$1',[job.id])).rows[0];
   const engine=new TaskEngine(s.workerPool,120000,undefined,undefined,undefined,undefined,undefined,text);
   const attempt=await s.attempt(row.current_task_id);
   expect(await s.run(attempt,engine)).toBeUndefined();const saved=(await root.query('SELECT * FROM text_ingestion_jobs WHERE id=$1',[job.id])).rows[0];
   expect(sourceReads).toBe(0);expect(postCount).toBe(1);expect(requests[0]!.inputs).toEqual([{kind:'uri',uri:baseUrl+'/source.'+ext,mime_type:mime}]);
   expect(saved.ingest_status).toBe('success');expect(saved.raw_content).toBe(lastResponse!.results[0]!.content);expect(requests[0]!.contexts).toEqual([{source_resource_id:job.id,parse_run_id:row.current_task_id}]);
  }finally{await text.close();await s.close();}
 });
 it.each([false,true])('resumes accepted text jobs after URL expiry and allowlist removal (cancelled=%s)',async cancelled=>{
  const s=await setup('async','pending'),text=new TextIngestionJobs(s.workerPool,s.workerConfig,s.deps),expiry=Math.floor(Date.now()/1000)+60;
  const engine=new TaskEngine(s.workerPool,120000,undefined,undefined,undefined,undefined,undefined,text);
  try{
   const job=await new TextIngestionService(s.apiPool,s.apiConfig).create(s.scope,{source_type:'FILE_UPLOAD',origin_resource_uri:baseUrl+`/source.md?Expires=${expiry}`},randomUUID());
   const taskId=(await root.query('SELECT current_task_id FROM text_ingestion_jobs WHERE id=$1',[job.id])).rows[0].current_task_id;
   expect(await s.run(await s.attempt(taskId),engine)).toBeUndefined();expect(postCount).toBe(1);
   s.workerConfig.rag.sourceAllowedHosts=[];
   if(cancelled)await new TaskService(s.apiPool,s.apiConfig.appTokenSecret!).mutate(s.scope,taskId,'cancel',randomUUID(),{});
   else {const [id,remote]=[...remoteJobs][0]!;await deliverCallback!(remote.callbackUrl,id,remote.response);}
   const next=await s.attempt(taskId),clock=vi.spyOn(Date,'now').mockReturnValue(expiry*1000+1);
   try{await s.run(next,engine);}finally{clock.mockRestore();}
   expect((await s.task(taskId)).state).toBe(cancelled?'cancelled':'succeeded');
   expect(postCount).toBe(1);expect(sourceReads).toBe(0);expect(deleteCount).toBe(cancelled?1:0);expect(await redis.hlen(s.nodePrefix+':jobs')).toBe(0);
  }finally{await text.close();await s.close();}
 });
 it.each([false,true])('reuses an already uploaded mother resource and serializes same-batch retries across admission keys (versioned=%s)',async versioned=>{
  const s=await setup('sync');
  // The worker signs as OSS but the test writes extraction artifacts on disk.
  // Route the indexer's separately constructed reader to that same test disk;
  // the SDK request guard still prevents every unmocked cloud method.
  const readObject=vi.spyOn(AliyunOssStorageAdapter.prototype,'read').mockImplementation(async key=>{
   if(!key.startsWith('extractions/'))throw new Error('SOURCE_READ_FORBIDDEN');
   return s.storage.read(key);
  });
  try{
   Object.assign(s.apiConfig,mockOssUploadConfig(s.apiConfig));
   Object.assign(s.workerConfig,mockOssUploadConfig(s.workerConfig));
   Object.assign(s.apiConfig.storageAliyunOss!,{endpoint:'https://oss-cn-beijing-internal.aliyuncs.com',publicEndpoint:testOssConfig.endpoint});
   const storage=new StorageService(s.apiPool,s.apiConfig,s.storage,s.uploads),upload=await storage.createUpload(s.scope,{fileName:'source.pdf',mimeType:'application/pdf',sizeBytes:BigInt(pdf.byteLength)},randomUUID());
   await s.storage.uploadPart(upload.uploadUrl,pdf);
   s.storage.setHeadMetadata(upload.resourceId,{version:versioned?'oss-version:source-version':'etag:"source-etag"'});
   await storage.complete(s.scope,upload.uploadId,randomUUID());
   const sourceUrl=(await storage.playback(s.scope,upload.resourceId)).url;
   expect(new URL(sourceUrl).searchParams.get('versionId')).toBe(versioned?'source-version':null);
   const batch=randomUUID(),input={ossUrl:sourceUrl,fileName:'source.pdf',mimeType:'application/pdf',sourceResourceId:upload.resourceId,parseRunId:batch};
   const wrongVersion=new URL(sourceUrl);wrongVersion.searchParams.set('versionId','different-version');
   await expect(s.repository.create(s.scope,{...input,ossUrl:wrongVersion.toString()})).rejects.toMatchObject({code:'RAG_SOURCE_RESOURCE_MISMATCH'});
   if(versioned){
    const missingVersion=new URL(sourceUrl);missingVersion.searchParams.delete('versionId');
    await expect(s.repository.create(s.scope,{...input,ossUrl:missingVersion.toString()})).rejects.toMatchObject({code:'RAG_SOURCE_RESOURCE_MISMATCH'});
   }
   await expect(s.repository.create(s.scope,{...input,ossUrl:sourceUrl.replace(upload.resourceId,randomUUID())})).rejects.toMatchObject({code:'RAG_SOURCE_RESOURCE_MISMATCH'});
   const results=await Promise.all([s.repository.create(s.scope,{...input,idempotencyKey:randomUUID()}),s.repository.create(s.scope,{...input,idempotencyKey:randomUUID()})]);
   expect(results[0]!.jobId).toBe(results[1]!.jobId);expect(results.filter(r=>r.reused)).toHaveLength(1);
   expect((await root.query('SELECT source_sha256 FROM rag_ingestion_versions WHERE id=$1',[results[0]!.documentVersionId])).rows[0].source_sha256).toBeNull();
   await expect(storage.remove(s.scope,s.workspaceId,upload.resourceId,randomUUID())).rejects.toMatchObject({code:'RESOURCE_REFERENCED'});
   // Simulate an admitted file waiting until its original URL expires. Only its
   // owned resource/version may supply a fresh URL at parser submission time.
   const expired=new URL(sourceUrl);expired.searchParams.set('x-oss-date','20000101T000000Z');
   await root.query('UPDATE rag_ingestion_versions SET source_url=$2 WHERE id=$1',[results[0]!.documentVersionId,expired.href]);
   expect(await s.run(await s.attempt(results[0]!.jobId))).toBeUndefined();expect(sourceReads).toBe(0);expect(postCount).toBe(1);
   expect(requests[0]!.contexts).toEqual([{source_resource_id:upload.resourceId,parse_run_id:batch}]);expect(new URL(String(requests[0]!.inputs[0]!.uri)).pathname).toBe(new URL(sourceUrl).pathname);expect(new URL(String(requests[0]!.inputs[0]!.uri)).searchParams.get('x-oss-expires')).toBe('3600');
   expect(new URL(String(requests[0]!.inputs[0]!.uri)).searchParams.get('x-oss-date')).not.toBe('20000101T000000Z');
   expect(readObject).toHaveBeenCalled();expect(readObject.mock.calls.every(([key])=>key.startsWith('extractions/'))).toBe(true);
   expect(OSS.prototype.request).not.toHaveBeenCalled();
   await expect(s.repository.create(s.scope,{...input,ossUrl:sourceUrl.replace(upload.resourceId,randomUUID())})).rejects.toMatchObject({code:'RAG_SOURCE_RESOURCE_MISMATCH'});
   await s.repository.action(s.scope,results[0]!.jobId,'delete');expect(Number((await root.query("SELECT count(*) FROM resource_refs WHERE resource_id=$1 AND ref_kind='document-source'",[upload.resourceId])).rows[0].count)).toBe(0);
  }finally{readObject.mockRestore();await s.close();}
 });
 it('only hands a cancelled parser step off for its live owner, attempt and recoverable receipt',async()=>{
  const s=await setup('async','pending');try{
   const created=await s.start(),first=await s.attempt(created.jobId);
   const receipt={phase:'job' as const,requestId:`${created.jobId}:parse:${first.attempt}`,fingerprint:'a'.repeat(64),jobId:'accepted-job'};
   await root.query("UPDATE tasks SET external_state='submitted',external_reference=$2 WHERE id=$1",[created.jobId,encodeDocumentReference(receipt)]);
   await new TaskService(s.apiPool,s.apiConfig.appTokenSecret!).mutate(s.scope,created.jobId,'cancel',randomUUID(),{});
   const cancelled=await s.task(created.jobId),outbox=async()=>Number((await root.query('SELECT count(*) AS n FROM task_outbox WHERE task_id=$1',[created.jobId])).rows[0].n),before=await outbox();
   for(const invalid of [{...first,owner:randomUUID()},{...first,attempt:first.attempt+1}]){
    expect(await s.engine.defer(invalid,60000)).toBe(false);expect(await s.task(created.jobId)).toMatchObject({version:cancelled.version,lease_owner:first.owner,lease_until:cancelled.lease_until});expect(await outbox()).toBe(before);
   }
   await root.query("UPDATE tasks SET external_state='unknown',external_reference=$2 WHERE id=$1",[created.jobId,encodeDocumentReference({...receipt,phase:'intent',jobId:undefined})]);
   expect(await s.engine.defer(first,60000)).toBe(false);expect((await s.task(created.jobId)).lease_owner).toBe(first.owner);expect(await outbox()).toBe(before);
   await root.query("UPDATE tasks SET external_state='submitted',external_reference=$2,lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[created.jobId,encodeDocumentReference(receipt)]);
   expect(await s.engine.defer(first,60000)).toBe(false);expect((await s.task(created.jobId)).lease_owner).toBe(first.owner);expect(await outbox()).toBe(before);
   expect(await s.engine.finish(first,'stale',0)).toBe(false);expect(postCount).toBe(0);
  }finally{await s.close();}
 });
 it('keeps an accepted job ID when cancellation races the POST response',async()=>{
  const s=await setup('async','pending');let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});beforeAsyncReply=()=>gate;
  try{
   const created=await s.start(),first=await s.attempt(created.jobId),operation=s.run(first);
   await vi.waitFor(()=>expect(remoteJobs.size).toBe(1),{interval:10,timeout:3000});
   await new TaskService(s.apiPool,s.apiConfig.appTokenSecret!).mutate(s.scope,created.jobId,'cancel',randomUUID(),{});release();
   expect(await operation).toBeUndefined();expect(await s.task(created.jobId)).toMatchObject({state:'cancel_requested',lease_owner:null,lease_until:null,external_state:'submitted'});
   expect(await s.engine.heartbeat(first)).toBe(false);expect(await s.engine.finish(first,'stale',0)).toBe(false);
   expect(await s.run(await s.attempt(created.jobId))).toBeTruthy();expect((await s.task(created.jobId)).state).toBe('cancelled');expect(deleteCount).toBe(1);expect(postCount).toBe(1);
   expect(await redis.zcard(s.nodePrefix+':active')).toBe(0);
  }finally{release();await s.close();}
 });
 it('cancels an in-flight parse when its existing document is deleted instead of publishing late output',async()=>{
  const s=await setup('async','pending');try{
   const created=await s.start(),operation=s.run(await s.attempt(created.jobId));await vi.waitFor(()=>expect(remoteJobs.size).toBe(1),{interval:10,timeout:3000});
   await s.repository.action(s.scope,created.jobId,'delete');expect(await operation).toBeUndefined();
   expect(await s.task(created.jobId)).toMatchObject({state:'cancel_requested',lease_owner:null,lease_until:null});
   expect(await s.run(await s.attempt(created.jobId))).toBeTruthy();expect((await s.task(created.jobId)).state).toBe('cancelled');expect(deleteCount).toBe(1);expect(postCount).toBe(1);
   const row=(await root.query('SELECT canonical_content_uri,deleted_at FROM rag_ingestion_versions WHERE id=$1',[created.documentVersionId])).rows[0];expect(row.deleted_at).toBeTruthy();expect(row.canonical_content_uri).toBeNull();
   expect(Number((await root.query('SELECT count(*) FROM rag_document_assets WHERE version_id=$1',[created.documentVersionId])).rows[0].count)).toBe(0);
  }finally{await s.close();}
 });
 it.skipIf(!process.env.TEST_MILVUS_ADDRESS)('retrieves parsed content through the existing real BM25 document pipeline without embedding or rerank',async()=>{
  const s=await setup('sync','success',true),queries=new RagQueryService(s.apiPool,s.apiConfig,{index:s.deps.index,embedding:{model:'forbidden',dimensions:1024,embed:async()=>{throw new Error('EMBEDDING_MUST_NOT_RUN');}},rerank:{rerank:async()=>{throw new Error('RERANK_MUST_NOT_RUN');}}});
  try{
   s.apiConfig.rag.providerMode='disabled';s.workerConfig.rag.providerMode='disabled';
   const created=await s.start();expect(await s.run(await s.attempt(created.jobId))).toBeUndefined();
   const result=await queries.query(s.scope,{query:'Native',sourceType:'file',mode:'keyword',documentKey:created.documentVersionId});
   expect(result.mode).toBe('keyword');expect(result.results.length).toBeGreaterThan(0);expect(JSON.stringify(result.results)).toContain('Native');
  }finally{await queries.close();await s.close();}
 });
});
