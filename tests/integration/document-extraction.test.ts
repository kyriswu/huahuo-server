import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {Redis} from 'ioredis';
import {loadConfig} from '../../src/config/config.js';
import {migrate} from '../../src/db/migrate.js';
import {poolFor} from '../../src/plugins/dependencies.js';
import {buildApiServer} from '../../src/apps/api-server.js';
import {RagIngestionJobs} from '../../src/modules/rag/jobs.js';
import {RagIngestionRepository} from '../../src/modules/rag/repository.js';
import {TaskEngine} from '../../src/modules/tasks/engine.js';
import {TaskService} from '../../src/modules/tasks/service.js';
import {TaskScheduler} from '../../src/modules/tasks/scheduler.js';
import {TextIngestionService} from '../../src/modules/text-ingestion/service.js';
import {TextIngestionJobs} from '../../src/modules/text-ingestion/jobs.js';
import {storageFor} from '../../src/modules/storage/port.js';
import {StorageService} from '../../src/modules/storage/service.js';
import {mockKnowledgeIndex} from '../support/kb-index.js';
import {insertFixtureUser,insertFixtureSession,testJwtEnv} from './jwt-fixture.js';
import {sampleExtraction} from '../support/document-extraction.js';
import type {ExtractionResponse,FileContext} from '../../src/integrations/document-extraction.js';
import type {Attempt} from '../../src/modules/tasks/engine.js';
import {RagQueryService} from '../../src/modules/rag/query-service.js';
import {MilvusRepository} from '../../src/modules/rag/adapters/milvus.js';
import type {KbSnapshot} from '../../src/modules/kb/types.js';

const database=process.env.TEST_DATABASE_MIGRATION_URL,redisUrl=process.env.REDIS_QUEUE_URL;
if(!database||!/^huahuo_test_/.test(new URL(database).pathname.slice(1))||!redisUrl||!['127.0.0.1','localhost'].includes(new URL(redisUrl).hostname)||Number(new URL(redisUrl).pathname.slice(1))<10)throw new Error('ISOLATED_REAL_DEPENDENCIES_REQUIRED');
const root=poolFor(loadConfig('migrate',{DATABASE_URL:database})),redis=new Redis(redisUrl,{lazyConnect:true,maxRetriesPerRequest:0});redis.on('error',()=>undefined);
const directory=await mkdtemp(join(tmpdir(),'document-extraction-test-'));
const pdf=Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
type Scenario='success'|'pending'|'get-error'|'unknown-post'|'failed-file'|'cancel-error';
let scenario:Scenario='success',baseUrl='',postCount=0,sourceReads=0,deleteCount=0,failGet=false;
let hold=false,lastResponse:ExtractionResponse|undefined;
let onGet:(()=>Promise<void>)|undefined;
let beforeAsyncReply:(()=>Promise<void>)|undefined;
const requests:Array<{contexts:Array<FileContext|null>;config:unknown}> = [];
const remoteJobs=new Map<string,{response:ExtractionResponse;cancelled:boolean;consumed?:boolean}>();
const errors:unknown[]=[];
const server=createServer((req,res)=>{void(async()=>{
 if(req.url==='/source.pdf'){sourceReads++;res.writeHead(200,{'content-type':'application/pdf'});res.end(pdf);return;}
 const jobMatch=/^\/jobs\/([A-Za-z0-9_-]+)(?:\/(result|ack))?$/.exec(req.url??'');
 if(jobMatch){
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
  const form=await new Request('http://local.test',{method:'POST',headers:{'content-type':req.headers['content-type']!},body:Buffer.concat(parts)}).formData();
  const contexts=JSON.parse(form.get('file_contexts') as string) as FileContext[];
  expect(form.getAll('files')).toHaveLength(contexts.length);expect(Buffer.from(await(form.get('files') as File).arrayBuffer())).toEqual(pdf);
  const config=JSON.parse(form.get('config') as string);requests.push({contexts,config});
  const body=sampleExtraction(contexts[0]!);lastResponse=body;
  if(scenario==='unknown-post'){res.writeHead(503);res.end('{}');return;}
  if(scenario==='failed-file'){scenario='success';res.writeHead(200);res.end(JSON.stringify({summary:{inputs:1,results:0,errors:1},results:[],errors:[{index:0,error:'temporary file failure'}]}));return;}
  if(req.url==='/extract-async'){const id=randomUUID();remoteJobs.set(id,{response:body,cancelled:false});await beforeAsyncReply?.();res.writeHead(202);res.end(JSON.stringify({job_id:id}));return;}
  res.writeHead(200);res.end(JSON.stringify(body));return;
 }
 res.writeHead(404);res.end('{}');
 })().catch(error=>{errors.push(error);res.writeHead(500);res.end('{}');});});
beforeAll(async()=>{await migrate(loadConfig('migrate',{DATABASE_URL:database}));await redis.connect();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw new Error('TEST_ADDRESS');baseUrl=`http://127.0.0.1:${address.port}`;});
afterAll(async()=>{redis.disconnect();await root.end();await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true});});

async function setup(mode:'sync'|'async',state:Scenario='success',realKeyword=false){
 scenario=state;postCount=0;sourceReads=0;deleteCount=0;failGet=state==='get-error';hold=state==='pending'||state==='cancel-error';onGet=undefined;beforeAsyncReply=undefined;requests.splice(0);errors.splice(0);remoteJobs.clear();
 const prefix='extract_'+randomUUID().replaceAll('-','');
 const env={...testJwtEnv,APP_ENV:'test',LOG_LEVEL:'silent',APP_PUBLIC_BASE_URL:'http://api.test',ADMIN_PUBLIC_BASE_URL:'http://admin.test',APP_TOKEN_SECRET:'a'.repeat(48),ADMIN_SESSION_SECRET:'b'.repeat(48),REDIS_CACHE_URL:process.env.REDIS_CACHE_URL,REDIS_QUEUE_URL:redisUrl,REDIS_KEY_PREFIX:prefix,
  RAG_PROVIDER_MODE:'mock',ALLOW_MOCK_PROVIDERS:'true',RAG_SOURCE_ALLOWED_HOSTS:'127.0.0.1',RAG_ENABLED:'true',STORAGE_DRIVER:'local',STORAGE_LOCAL_ROOT:join(directory,prefix),DOCUMENT_EXTRACTION_MODE:mode,
  DOCUMENT_EXTRACTION_POLL_MS:'100',DOCUMENT_PARSER_MODE:'always-on',DOCUMENT_PARSER_BASE_URL:baseUrl,DOCUMENT_PARSER_HEALTH_PATH:''};
 const apiConfig=loadConfig('api-server',{...env,DATABASE_URL:process.env.TEST_DATABASE_API_URL}),workerConfig=loadConfig('worker',{...env,DATABASE_URL:process.env.TEST_DATABASE_WORKER_URL});
 apiConfig.rag.enabled=true;workerConfig.rag.enabled=true;
 const apiPool=poolFor(apiConfig),workerPool=poolFor(workerConfig),storage=storageFor(workerConfig),memory=mockKnowledgeIndex();
 const deps={index:(snapshot:KbSnapshot)=>realKeyword?new MilvusRepository({...apiConfig.milvus,address:process.env.TEST_MILVUS_ADDRESS!,username:'root',password:'Milvus',tls:false,createIfMissing:true,database:'default',collection:snapshot.target.collection,mode:snapshot.mode}):memory,
  embedding:()=>{throw new Error('DOCUMENT_PATH_MUST_NOT_USE_EMBEDDING');},tokenizer:()=>{throw new Error('DOCUMENT_PATH_MUST_NOT_USE_MODEL_TOKENIZER');}};
 const pipeline=new RagIngestionJobs(workerPool,workerConfig,storage,{kb:deps});
 const engine=new TaskEngine(workerPool,120000,undefined,undefined,undefined,pipeline);
 const userId=await insertFixtureUser(root),sessionId=randomUUID(),workspaceId=randomUUID();const bearer=await insertFixtureSession(root,userId,sessionId);
 await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'Extraction test',true,$3)",[workspaceId,userId,randomUUID()]);
 const scope={userId,sessionId,traceId:randomUUID()},repository=new RagIngestionRepository(apiPool,apiConfig.rag,apiConfig.appEnv,apiConfig.kb.documentCollection,apiConfig);
 const api=await buildApiServer({config:apiConfig});
 const start=async()=>{
  const response=await api.inject({method:'POST',url:'/api/v1/rag/ingestions',headers:{authorization:'Bearer '+bearer,'x-idempotency-key':randomUUID()},payload:{ossUrl:baseUrl+'/source.pdf',fileName:'source.pdf',mimeType:'application/pdf'}});
  expect(response.statusCode,response.body).toBe(200);return response.json().data as {jobId:string;documentVersionId:string};
 };
 const attempt=async(id:string)=>{const a=await engine.claim(id,randomUUID());expect(a).not.toBeNull();return a!;};
 const run=async(a:Attempt)=>{try{await engine.execute(a);return undefined;}catch(error){const e=error as {code?:string;retryable?:boolean};await engine.fail(a,e.code??'TEST_FAILED',e.retryable!==false);return error;}};
 const task=async(id:string)=>(await root.query('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];
 const close=async()=>{onGet=undefined;beforeAsyncReply=undefined;await api.close();await pipeline.close();await Promise.all([apiPool.end(),workerPool.end()]);const keys=await redis.keys(prefix+':*');if(keys.length)await redis.del(...keys);};
 return {apiConfig,workerConfig,apiPool,workerPool,storage,deps,pipeline,engine,scope,bearer,repository,api,start,attempt,run,task,close,prefix};
}

describe('existing document workflows: real isolated PG/Redis/storage, loopback fake parser, no private requests',()=>{
 it('runs existing authenticated PDF ingestion end to end and preserves exact KB output/receipts',async()=>{
  const s=await setup('sync');try{
   const created=await s.start(),version=(await root.query('SELECT processing_snapshot FROM rag_ingestion_versions WHERE id=$1',[created.documentVersionId])).rows[0];
   const parser=version.processing_snapshot.parser;expect(parser.sourceResourceId).toBe(created.documentVersionId);expect(parser.parseRunId).toMatch(/^[a-f0-9-]{36}$/);
   expect(await s.run(await s.attempt(created.jobId))).toBeUndefined();expect((await s.task(created.jobId)).state).toBe('succeeded');
   expect(postCount).toBe(1);expect(sourceReads).toBe(1);expect(requests[0]!.config).toEqual(parser.extraction.parameters);
   expect(requests[0]!.contexts).toEqual([{source_resource_id:parser.sourceResourceId,parse_run_id:parser.parseRunId}]);
   const row=(await root.query('SELECT * FROM rag_ingestion_versions WHERE id=$1',[created.documentVersionId])).rows[0];
   const chunks:Buffer[]=[];for await(const chunk of await s.storage.read(row.canonical_content_uri))chunks.push(Buffer.from(chunk));expect(Buffer.concat(chunks).toString()).toBe(lastResponse!.results[0]!.content);
   const assets=(await root.query('SELECT * FROM rag_document_assets WHERE version_id=$1',[created.documentVersionId])).rows;
   expect(assets).toHaveLength(1);expect(assets[0]).toMatchObject({upload_status:'ready',char_start:null,char_end:null});
   const assetConfig={...s.apiConfig,storageDriver:'aliyun-oss' as const,storageAliyunOss:{region:'cn-beijing',endpoint:'https://oss.example.invalid',bucket:'fixture-bucket',accessKeyId:'test',accessKeySecret:'test',secure:true,timeoutMs:1000,keyPrefix:'fixture-resources',maxBytes:100000}};
   const assetRepository=new RagIngestionRepository(s.apiPool,assetConfig.rag,assetConfig.appEnv,assetConfig.kb.documentCollection,assetConfig);
   const read=vi.fn(async()=>Readable.from([Buffer.from('fake-image')]));
   await assetRepository.asset(s.scope,created.jobId,assets[0].id,{read});expect(read).toHaveBeenCalledExactlyOnceWith(assets[0].id);
   expect(Number((await root.query('SELECT count(*) FROM kb_document_keyword_builds WHERE source_id=$1 AND published',[created.documentVersionId])).rows[0].count)).toBe(1);
   const response=await s.api.inject({method:'GET',url:`/api/v1/rag/ingestions/${created.jobId}/extraction`,headers:{authorization:'Bearer '+s.bearer}});
   expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual(lastResponse);expect(response.body).not.toContain('data_base64');
   const other=await insertFixtureUser(root),otherToken=await insertFixtureSession(root,other,randomUUID());
   expect((await s.api.inject({method:'GET',url:`/api/v1/rag/ingestions/${created.jobId}/extraction`,headers:{authorization:'Bearer '+otherToken}})).statusCode).toBe(404);
   await s.repository.action(s.scope,created.jobId,'delete');expect((await s.api.inject({method:'GET',url:`/api/v1/rag/ingestions/${created.jobId}/extraction`,headers:{authorization:'Bearer '+s.bearer}})).statusCode).toBe(404);
   expect(errors).toHaveLength(0);
  }finally{await s.close();}
 });
 it('keeps the Redis slot through asynchronous completion and saves job_id before the first GET',async()=>{
  const s=await setup('async','pending');try{
   const created=await s.start();let observed=false;
   onGet=async()=>{const row=await s.task(created.jobId);expect(row.external_state).toBe('submitted');expect(row.external_reference).toMatch(/^xberg-job:/);observed=true;};
   const operation=s.run(await s.attempt(created.jobId));
   await vi.waitFor(()=>expect(observed).toBe(true),{interval:10,timeout:3000});
   expect(await redis.zcard(s.prefix+':document-parser:{single}:active')).toBe(1);expect((await s.task(created.jobId)).state).toBe('running');
   hold=false;expect(await operation).toBeUndefined();expect((await s.task(created.jobId)).state).toBe('succeeded');expect(postCount).toBe(1);
   expect(await redis.zcard(s.prefix+':document-parser:{single}:active')).toBe(0);expect(errors).toHaveLength(0);
  }finally{await s.close();}
 });
 it('recovers a known async job with GET only and does not redownload the mother file',async()=>{
  const s=await setup('async','get-error');try{
   const created=await s.start();expect(await s.run(await s.attempt(created.jobId))).toBeTruthy();expect((await s.task(created.jobId)).state).toBe('reconciling');
   expect(await redis.zcard(s.prefix+':document-parser:{single}:active')).toBe(1);
   await root.query("UPDATE tasks SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[created.jobId]);
   expect(await s.run(await s.attempt(created.jobId))).toBeUndefined();expect(postCount).toBe(1);expect(sourceReads).toBe(1);expect((await s.task(created.jobId)).state).toBe('succeeded');
  }finally{await s.close();}
 });
 it('retains ambiguous submission without a job ID and never blindly reclaims/resubmits it',async()=>{
  const s=await setup('async','unknown-post');try{
   const created=await s.start();expect(await s.run(await s.attempt(created.jobId))).toBeTruthy();const task=await s.task(created.jobId);
   expect(task).toMatchObject({state:'reconciling',external_state:'unknown'});expect(task.external_reference).toMatch(/^xberg-intent:/);
   await root.query("UPDATE tasks SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[created.jobId]);expect(await s.engine.claim(created.jobId,randomUUID())).toBeNull();expect(postCount).toBe(1);
   expect(await redis.zcard(s.prefix+':document-parser:{single}:active')).toBe(1);
  }finally{await s.close();}
 });
 it('reuses both UUIDs and the complete admission snapshot on a safe same-batch retry',async()=>{
  const s=await setup('sync','failed-file');try{
   const created=await s.start();expect(await s.run(await s.attempt(created.jobId))).toBeTruthy();expect((await s.task(created.jobId)).state).toBe('retry_scheduled');
   if(s.workerConfig.documentExtraction.enabled)s.workerConfig.documentExtraction.parameters.force_ocr=true;
   await root.query("UPDATE tasks SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[created.jobId]);
   expect(await s.run(await s.attempt(created.jobId))).toBeUndefined();expect(postCount).toBe(2);expect(requests[0]).toEqual(requests[1]);expect((requests[1]!.config as {force_ocr:boolean}).force_ocr).toBe(false);
  }finally{await s.close();}
 });
 it.each([false,true])('settles a durable cancellation only after a remote terminal state; ambiguous DELETE is not resent (uncertain=%s)',async uncertain=>{
  const s=await setup('async',uncertain?'cancel-error':'pending');try{
   const created=await s.start(),operation=s.run(await s.attempt(created.jobId));
   await vi.waitFor(()=>expect(remoteJobs.size).toBe(1),{interval:10,timeout:3000});
   await new TaskService(s.apiPool,s.apiConfig.appTokenSecret!).mutate(s.scope,created.jobId,'cancel',randomUUID(),{});
   expect(await operation).toBeTruthy();
   if(uncertain){
    // Cancellation changed the original attempt version; recovery, not that stale worker, owns the next transition.
    await root.query("UPDATE tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[created.jobId]);
    await new TaskScheduler(s.workerPool,{publish:async()=>undefined}).recover();
    expect((await s.task(created.jobId)).state).toBe('reconciling');expect(await s.run(await s.attempt(created.jobId))).toBeTruthy();
   }
   expect((await s.task(created.jobId)).state).toBe('cancelled');expect(postCount).toBe(1);expect(deleteCount).toBe(1);expect(await redis.zcard(s.prefix+':document-parser:{single}:active')).toBe(0);
   expect(Number((await root.query('SELECT count(*) FROM task_results WHERE task_id=$1',[created.jobId])).rows[0].count)).toBe(0);
  }finally{await s.close();}
 });
 it('uses the same managed extractor for the existing FILE_UPLOAD workflow',async()=>{
  const s=await setup('async');const text=new TextIngestionJobs(s.workerPool,s.workerConfig,s.deps);
  try{
   s.apiConfig.rag.providerMode='disabled';s.workerConfig.rag.providerMode='disabled';
   const service=new TextIngestionService(s.apiPool,s.apiConfig),job=await service.create(s.scope,{source_type:'FILE_UPLOAD',origin_resource_uri:baseUrl+'/source.pdf'},randomUUID());
   const row=(await root.query('SELECT current_task_id FROM text_ingestion_jobs WHERE id=$1',[job.id])).rows[0];
   const engine=new TaskEngine(s.workerPool,120000,undefined,undefined,undefined,undefined,undefined,text),a=await engine.claim(row.current_task_id,randomUUID());expect(a).not.toBeNull();
   expect(await engine.execute(a!)).toBe(true);const saved=(await root.query('SELECT * FROM text_ingestion_jobs WHERE id=$1',[job.id])).rows[0];
   expect(saved.ingest_status).toBe('success');expect(saved.raw_content).toBe(lastResponse!.results[0]!.content);expect(requests[0]!.contexts).toEqual([{source_resource_id:job.id,parse_run_id:row.current_task_id}]);
  }finally{await text.close();await s.close();}
 });
 it('reuses an already uploaded mother resource and serializes same-batch retries across admission keys',async()=>{
  const s=await setup('sync');try{
   const storage=new StorageService(s.apiPool,s.apiConfig,s.storage),upload=await storage.createUpload(s.scope,{sourceScene:'note_import',fileName:'source.pdf',mimeType:'application/pdf',sizeBytes:BigInt(pdf.byteLength),durationSeconds:0},randomUUID());
   await storage.put(upload.uploadId,upload.headers['X-Upload-Capability'],Readable.from([pdf]));await storage.complete(s.scope,upload.uploadId,randomUUID());
   const batch=randomUUID(),input={ossUrl:baseUrl+'/source.pdf',fileName:'source.pdf',mimeType:'application/pdf',sourceResourceId:upload.resourceId,parseRunId:batch};
   const results=await Promise.all([s.repository.create(s.scope,{...input,idempotencyKey:randomUUID()}),s.repository.create(s.scope,{...input,idempotencyKey:randomUUID()})]);
   expect(results[0]!.jobId).toBe(results[1]!.jobId);expect(results.filter(r=>r.reused)).toHaveLength(1);
   await expect(storage.remove(s.scope,(await root.query('SELECT workspace_id FROM resources WHERE resource_id=$1',[upload.resourceId])).rows[0].workspace_id,upload.resourceId,randomUUID())).rejects.toMatchObject({code:'RESOURCE_REFERENCED'});
   expect(await s.run(await s.attempt(results[0]!.jobId))).toBeUndefined();expect(sourceReads).toBe(0);expect(postCount).toBe(1);
   expect(requests[0]!.contexts).toEqual([{source_resource_id:upload.resourceId,parse_run_id:batch}]);
   await s.repository.action(s.scope,results[0]!.jobId,'delete');expect(Number((await root.query("SELECT count(*) FROM resource_refs WHERE resource_id=$1 AND ref_kind='document-source'",[upload.resourceId])).rows[0].count)).toBe(0);
  }finally{await s.close();}
 });
 it('keeps an accepted job ID when cancellation races the POST response',async()=>{
  const s=await setup('async','pending');let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});beforeAsyncReply=()=>gate;
  try{
   const created=await s.start(),operation=s.run(await s.attempt(created.jobId));
   await vi.waitFor(()=>expect(remoteJobs.size).toBe(1),{interval:10,timeout:3000});
   await new TaskService(s.apiPool,s.apiConfig.appTokenSecret!).mutate(s.scope,created.jobId,'cancel',randomUUID(),{});release();
   expect(await operation).toBeTruthy();expect((await s.task(created.jobId)).state).toBe('cancelled');expect(deleteCount).toBe(1);expect(postCount).toBe(1);
   expect(await redis.zcard(s.prefix+':document-parser:{single}:active')).toBe(0);
  }finally{release();await s.close();}
 });
 it('cancels an in-flight parse when its existing document is deleted instead of publishing late output',async()=>{
  const s=await setup('async','pending');try{
   const created=await s.start(),operation=s.run(await s.attempt(created.jobId));await vi.waitFor(()=>expect(remoteJobs.size).toBe(1),{interval:10,timeout:3000});
   await s.repository.action(s.scope,created.jobId,'delete');expect(await operation).toBeTruthy();
   expect((await s.task(created.jobId)).state).toBe('cancelled');expect(deleteCount).toBe(1);
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
