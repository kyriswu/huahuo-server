import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {Redis} from 'ioredis';
import {loadConfig} from '../../src/config/config.js';
import {poolFor} from '../../src/plugins/dependencies.js';
import {migrate} from '../../src/db/migrate.js';
import {buildAdminServer} from '../../src/apps/admin.js';
import {buildApiServer} from '../../src/apps/api-server.js';
import {hashPassword} from '../../src/modules/identity/crypto.js';
import {ProcessingNodes} from '../../src/modules/processing-nodes/service.js';
import type {ProcessingNode} from '../../src/modules/processing-nodes/model.js';
import {RuntimeSettings,currentRuntimeConfig} from '../../src/modules/runtime-settings/service.js';
import {ParserExecutionError} from '../../src/lib/document-parser-machine/index.js';
import {insertFixtureUser,insertFixtureSession,testJwtEnv} from './jwt-fixture.js';
import {BillingService} from '../../src/modules/billing/service.js';
import {transaction} from '../../src/modules/identity/store.js';
import {AdminDocumentTrials} from '../../src/modules/admin/document-trials.js';
import {AdminService} from '../../src/modules/admin/service.js';
import {extractionConfig} from '../support/extraction-config.js';
import {sampleExtraction} from '../support/document-extraction.js';
import type {FileContext} from '../../src/integrations/document-extraction.js';

const database=process.env.TEST_DATABASE_MIGRATION_URL,redisUrl=process.env.REDIS_QUEUE_URL;
if(!database||!/^huahuo_test_/.test(new URL(database).pathname.slice(1))||!redisUrl||new URL(redisUrl).hostname!=='127.0.0.1'||Number(new URL(redisUrl).pathname.slice(1))<10)throw Error('ISOLATED_DEPENDENCIES_REQUIRED');
const env={...testJwtEnv,APP_ENV:'test',LOG_LEVEL:'silent',APP_PUBLIC_BASE_URL:'http://runtime-api.test',ADMIN_PUBLIC_BASE_URL:'http://runtime-admin.test',APP_TOKEN_SECRET:'a'.repeat(48),ADMIN_SESSION_SECRET:'b'.repeat(48),REDIS_CACHE_URL:process.env.REDIS_CACHE_URL,REDIS_QUEUE_URL:redisUrl,REDIS_KEY_PREFIX:'runtime_'+randomUUID().replaceAll('-',''),PROCESSING_NODES_ENABLED:'true'};
const root=poolFor(loadConfig('migrate',{DATABASE_URL:database}));
const adminConfig=loadConfig('admin',{...env,DATABASE_URL:process.env.TEST_DATABASE_ADMIN_URL});
const workerConfig=loadConfig('worker',{...env,DATABASE_URL:process.env.TEST_DATABASE_WORKER_URL});
const adminPool=poolFor(adminConfig),workerPool=poolFor(workerConfig),redis=new Redis(redisUrl,{lazyConnect:true,maxRetriesPerRequest:0});redis.on('error',()=>undefined);
const nodes=new ProcessingNodes(workerPool,workerConfig);
const app=await buildAdminServer({config:adminConfig,dependencies:{pool:adminPool,check:async()=>({postgres:true,schema:true,redisCache:true,redisQueue:true}),close:async()=>undefined}});
let superCookie='',csrf='',operatorCookie='',operatorCsrf='';
const adminIds:string[]=[];
const baseNode=(extra:Partial<ProcessingNode>={}):ProcessingNode=>({id:randomUUID(),name:'Test CPU node',capabilities:['document','audio'],resourceClass:'cpu',mode:'always-on',regionId:null,instanceId:null,privateIp:null,baseUrl:'http://127.0.0.1:18000/'+randomUUID(),healthPath:'',tokenEnv:null,concurrency:1,idleSeconds:60,startupSeconds:10,queueSeconds:10,enabled:true,revision:1,...extra});
const request=()=>({requestId:randomUUID(),fingerprint:createHash('sha256').update('document/config').digest('hex')});
const headers=()=>({cookie:superCookie,origin:env.ADMIN_PUBLIC_BASE_URL,'x-csrf-token':csrf});
async function get(){const r=await app.inject({url:'/admin/api/v1/configuration',headers:{cookie:superCookie}});expect(r.statusCode,r.body).toBe(200);return r.json().data;}
async function save(category:string,values:Record<string,unknown>,revision?:number,custom=headers()){
 return app.inject({method:'PUT',url:'/admin/api/v1/configuration/'+category,headers:custom,payload:{revision:revision??(await get()).revision,values}});
}
async function nodeSave(node:ProcessingNode,revision=0){return app.inject({method:'PUT',url:'/admin/api/v1/processing-nodes/'+node.id,headers:headers(),payload:{node,revision}});}
beforeAll(async()=>{
 await migrate(loadConfig('migrate',{DATABASE_URL:database}));await redis.connect();
 await root.query('UPDATE runtime_configuration SET "values"=\'{}\',revision=revision+1');await root.query(`UPDATE processing_nodes SET config=jsonb_set(config,'{enabled}','false')`);
 const password='isolated-runtime-password-123';
 for(const role of ['superadmin','operator']){
  const username='runtime_'+role+'_'+randomUUID().slice(0,8);
  const id=randomUUID();adminIds.push(id);await root.query('INSERT INTO admin_users(id,username,password_hash,role) VALUES($1,$2,$3,$4)',[id,username,await hashPassword(password),role]);
  const r=await app.inject({method:'POST',url:'/admin/api/v1/login',headers:{origin:env.ADMIN_PUBLIC_BASE_URL},payload:{username,password}});expect(r.statusCode,r.body).toBe(200);
  const cookie=String(r.headers['set-cookie']).split(';')[0]!;
  if(role==='superadmin'){superCookie=cookie;csrf=r.json().data.csrfToken;}else{operatorCookie=cookie;operatorCsrf=r.json().data.csrfToken;}
 }
});
afterAll(async()=>{
 await app.close();await nodes.close();
 await root.query('DELETE FROM admin_sessions WHERE admin_id=ANY($1::uuid[])',[adminIds]);await root.query('DELETE FROM admin_users WHERE id=ANY($1::uuid[])',[adminIds]);
 await root.query('UPDATE runtime_configuration SET "values"=\'{}\',revision=revision+1');await root.query(`UPDATE processing_nodes SET config=jsonb_set(config,'{enabled}','false')`);
 const keys=await redis.keys(env.REDIS_KEY_PREFIX+':*');if(keys.length)await redis.del(...keys);redis.disconnect();
 await Promise.all([root.end(),adminPool.end(),workerPool.end()]);
});

describe('categorized runtime configuration: real isolated PostgreSQL/Redis, no paid provider',()=>{
 it('requires admin sessions, denies App Bearer and isolates the API role',async()=>{
  expect((await app.inject({url:'/admin/api/v1/configuration',headers:{authorization:'Bearer app-token'}})).statusCode).toBe(401);
  const cfg=loadConfig('api-server',{...env,DATABASE_URL:process.env.TEST_DATABASE_API_URL});const api=await buildApiServer({config:cfg});
  try{expect((await api.inject('/admin/api/v1/configuration')).statusCode).toBe(404);}finally{await api.close();}
  const r=await app.inject({url:'/admin/api/v1/processing-nodes',headers:{cookie:operatorCookie}});expect(r.statusCode).toBe(200);
  expect(r.json().data.items.find((n:ProcessingNode)=>n.instanceId==='i-2zejbbo2svjieb44tqy8')).toMatchObject({enabled:false,resourceClass:'cpu',capabilities:['document']});
 });
 it('validates CSRF, current role, typed bounds, categories and secret-free complete parameters',async()=>{
  expect((await save('tasks',{'tasks.maxAttempts':4},undefined,{cookie:superCookie,origin:env.ADMIN_PUBLIC_BASE_URL,'x-csrf-token':'bad'})).statusCode).toBe(403);
  expect((await save('tasks',{'tasks.maxAttempts':4},undefined,{cookie:operatorCookie,origin:env.ADMIN_PUBLIC_BASE_URL,'x-csrf-token':operatorCsrf})).statusCode).toBe(403);
  for(const[category,patch]of [ ['tasks',{'tasks.maxAttempts':99}],['tasks',{'storage.quotaBytes':4096}],['features',{'secret':'no'}],['document',{'document.mode':'async'}],['document',{'document.parameters':{api_key:'must-not-persist'}}] ] as const){
   const r=await save(category,patch);expect(r.statusCode,r.body).toBe(400);expect(r.body).not.toContain('must-not-persist');
  }
 });
 it('uses compare-and-swap and records before/after audits in the same transaction',async()=>{
  const old=await get();const both=await Promise.all([save('tasks',{'tasks.maxAttempts':4},old.revision),save('tasks',{'tasks.maxAttempts':5},old.revision)]);
  expect(both.map(r=>r.statusCode).sort()).toEqual([200,409]);
  const audits=(await root.query("SELECT reason FROM admin_audit_events WHERE action='configuration.update' AND trace_id=$1",[both.find(r=>r.statusCode===200)!.json().traceId])).rows;
  expect(audits).toHaveLength(1);expect(JSON.parse(audits[0].reason)).toMatchObject({category:'tasks',before:{'tasks.maxAttempts':3}});
  const view=await get();expect(view.definitions.map((d:{category:string})=>d.category)).toEqual(expect.arrayContaining(['tasks','document','rag','storage','billing','features']));
  expect(JSON.stringify(view)).not.toContain('password_hash');
 });
 it('keeps a consistent per-request snapshot across concurrent edits and refreshes subsequent work',async()=>{
  await save('tasks',{'tasks.maxAttempts':4});const settings=new RuntimeSettings(workerPool,workerConfig);
  let release!:()=>void;let entered!:()=>void;const gate=new Promise<void>(r=>release=r),start=new Promise<void>(r=>entered=r);
  const first=settings.run(async()=>{expect(workerConfig.taskPolicy.maxAttempts).toBe(4);entered();await gate;expect(workerConfig.taskPolicy.maxAttempts).toBe(4);return currentRuntimeConfig()!.runtimeRevision;});
  await start;await save('tasks',{'tasks.maxAttempts':6});
  const second=await settings.run(async()=>{expect(workerConfig.taskPolicy.maxAttempts).toBe(6);return workerConfig.runtimeRevision;});
  release();expect(await first).toBeLessThan(second);expect(currentRuntimeConfig()).toBeUndefined();expect(workerConfig.taskPolicy.maxAttempts).toBe(3);
 });
 it('applies the database upload limit through existing App routes',async()=>{
  await save('storage',{'storage.maxUploadBytes':1000});
  const cfg=loadConfig('api-server',{...env,DATABASE_URL:process.env.TEST_DATABASE_API_URL}),api=await buildApiServer({config:cfg});
  const userId=await insertFixtureUser(root),sessionId=randomUUID(),bearer=await insertFixtureSession(root,userId,sessionId);
  try{
   const r=await api.inject({method:'POST',url:'/api/v1/media/upload-token',headers:{authorization:'Bearer '+bearer,'x-idempotency-key':randomUUID()},payload:{sourceScene:'note_import',fileName:'large.txt',mimeType:'text/plain',sizeBytes:1001,durationSeconds:0}});
   expect(r.statusCode,r.body).toBe(400);expect(r.json().error.code).toBe('UPLOAD_METADATA_INVALID');
  }finally{await api.close();await save('storage',{'storage.maxUploadBytes':104857600});}
 });
 it('validates RAG parameters and isolates current query/attempt snapshots from subsequent edits',async()=>{
  for(const patch of [{'rag.searchConcurrency':51},{'rag.embeddingBatchSize':0},{'rag.embeddingApiKey':'must-not-persist'}])expect((await save('rag',patch)).statusCode).toBe(400);
  expect((await save('rag',{'rag.rrfK':44},undefined,{cookie:operatorCookie,origin:env.ADMIN_PUBLIC_BASE_URL,'x-csrf-token':operatorCsrf})).statusCode).toBe(403);
  expect((await save('rag',{'rag.rrfK':44,'rag.embeddingBatchSize':3,'rag.plainTextMaxChars':43210})).statusCode).toBe(200);
  const settings=new RuntimeSettings(workerPool,workerConfig);
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),start=new Promise<void>(r=>entered=r);
  const first=settings.run(async()=>{expect(workerConfig.milvus.rrfK).toBe(44);expect(workerConfig.rag.embeddingBatchSize).toBe(3);entered();await gate;expect(workerConfig.milvus.rrfK).toBe(44);expect(workerConfig.rag.plainTextMaxChars).toBe(43210);});
  await start;
  try{expect((await save('rag',{'rag.rrfK':75,'rag.embeddingBatchSize':6,'rag.plainTextMaxChars':50000})).statusCode).toBe(200);await settings.run(async()=>{expect(workerConfig.milvus.rrfK).toBe(75);expect(workerConfig.rag.embeddingBatchSize).toBe(6);});}
  finally{release();await first;await save('rag',{'rag.rrfK':60,'rag.embeddingBatchSize':32});}
  expect(workerConfig.milvus.rrfK).toBe(60);
 });
 it('assigns by occupied capacity, preserves node affinity and shares document/audio occupancy',async()=>{
  const a=baseNode(),b=baseNode();expect((await nodeSave(a)).statusCode).toBe(200);expect((await nodeSave(b)).statusCode).toBe(200);
  const first=await nodes.bind('first-'+a.id,'document'),second=await nodes.bind('second-'+a.id,'audio');expect(first.id).not.toBe(second.id);
  expect((await nodes.bind('first-'+a.id,'document')).id).toBe(first.id);
  await expect(nodes.bind('first-'+a.id,'audio')).rejects.toMatchObject({code:'PROCESSING_ASSIGNMENT_CONFLICT'});
  const disabled={...Object.fromEntries(Object.entries(first).reverse()),enabled:false} as ProcessingNode;expect((await nodeSave(disabled,1)).statusCode).toBe(200);
  expect((await nodes.assigned('first-'+a.id)).id).toBe(first.id);
  expect((await nodes.bind('third-'+a.id,'document')).id).toBe(second.id);
  const change={...disabled,baseUrl:'http://127.0.0.1:19000',revision:2};expect((await nodeSave(change,2)).statusCode).toBe(409);
  await nodes.settle('first-'+a.id);await nodes.settle('second-'+a.id);await nodes.settle('third-'+a.id);
  await root.query(`UPDATE processing_nodes SET config=jsonb_set(config,'{enabled}','false')`);
 });
 it('selects an immutable billing policy without granting the current month twice',async()=>{
  const version='runtime-'+randomUUID().slice(0,8),userId=await insertFixtureUser(root);
  await root.query("INSERT INTO billing_policies(policy_version,mode,monthly_credit_limit,currency) VALUES($1,'development',20000000,'USD')",[version]);
  const cfg=loadConfig('api-server',{...env,DATABASE_URL:process.env.TEST_DATABASE_API_URL,BILLING_MODE:'development'}),pool=poolFor(cfg),settings=new RuntimeSettings(pool,cfg),billing=new BillingService(pool,cfg);
  try{
   await settings.run(()=>transaction(pool,tx=>billing.ensureAccountTx(tx,userId)));
   expect((await save('billing',{'billing.policyVersion':version})).statusCode).toBe(200);
   await settings.run(()=>transaction(pool,tx=>billing.ensureAccountTx(tx,userId)));
   const lots=(await root.query("SELECT policy_version,granted_credits::text FROM credit_lots WHERE user_id=$1 AND lot_kind='monthly'",[userId])).rows;
   expect(lots).toEqual([{policy_version:'credit-policy-v1',granted_credits:'10000000'}]);
  }finally{await save('billing',{'billing.policyVersion':'credit-policy-v1'});await pool.end();}
 });
 it('forbids duplicate ECS registration and revision races',async()=>{
  const existing=(await nodes.list()).find(n=>n.instanceId==='i-2zejbbo2svjieb44tqy8')!;
  expect((await nodeSave({...existing,id:randomUUID(),revision:1})).statusCode).toBe(409);
  expect((await nodeSave({...existing,name:'stale'},0)).statusCode).toBe(409);
 });
 it('stores one JSON configuration per node and increments the existing row on edits',async()=>{
  const node=baseNode({enabled:false});expect((await nodeSave(node)).statusCode).toBe(200);
  const first=await nodeSave({...node,name:'Renamed CPU'},1);expect(first.statusCode,first.body).toBe(200);
  const next=await nodeSave({...first.json().data,name:'Shared document/audio CPU'},2);expect(next.statusCode,next.body).toBe(200);
  const rows=(await root.query('SELECT * FROM processing_nodes WHERE id=$1',[node.id])).rows;
  expect(rows).toHaveLength(1);expect(Object.keys(rows[0]).sort()).toEqual(['config','created_at','id','revision','updated_at']);
  expect(rows[0].revision).toBe(3);expect(rows[0].config).toMatchObject({name:'Shared document/audio CPU',capabilities:['document','audio'],enabled:false});
  expect(rows[0].config).not.toHaveProperty('revision');expect(rows[0].config).not.toHaveProperty('id');
  expect((await nodes.list()).find(n=>n.id===node.id)).toMatchObject({...node,name:'Shared document/audio CPU',revision:3});
  expect((await nodeSave({...node,name:'Stale edit'},1)).statusCode).toBe(409);
  await expect(root.query(`UPDATE processing_nodes SET config=jsonb_set(config,'{concurrency}','0') WHERE id=$1`,[node.id])).rejects.toMatchObject({code:'23514'});
 });
 it('retains ambiguous execution and resumes the original node after disabling it',async()=>{
  const node=baseNode();expect((await nodeSave(node)).statusCode).toBe(200);const input=request();
  await expect(nodes.withNode('document',input,async()=>{throw new ParserExecutionError('TEST_REMOTE_UNKNOWN');})).rejects.toMatchObject({code:'DOCUMENT_PARSER_EXECUTION_UNKNOWN'});
  expect((await root.query('SELECT settled FROM processing_node_assignments WHERE request_id=$1',[input.requestId])).rows[0].settled).toBe(false);
  const status=await(await nodes.runtime(node)).machine.state.status();expect(status?.uncertain).toBe(1);
  expect((await nodeSave({...node,enabled:false},1)).statusCode).toBe(200);
  expect(await nodes.withNode('document',{...input,resume:true},async ctx=>ctx.baseUrl)).toBe(node.baseUrl);
  expect((await root.query('SELECT settled FROM processing_node_assignments WHERE request_id=$1',[input.requestId])).rows[0].settled).toBe(true);
  await expect(nodes.withNode('document',input,async()=>{throw Error('must not run');})).rejects.toMatchObject({code:'PROCESSING_ASSIGNMENT_SETTLED'});
 });
 it('enforces shared Redis slots across capabilities and protects routing changes until drained',async()=>{
  const node=baseNode();expect((await nodeSave(node)).statusCode).toBe(200);const first=request(),second=request();
  let release!:()=>void;let started!:()=>void;const gate=new Promise<void>(r=>release=r),start=new Promise<void>(r=>started=r);let audioStarted=false;
  const work=nodes.withNode('document',first,async()=>{started();await gate;});await start;
  const audio=nodes.withNode('audio',second,async()=>{audioStarted=true;});
  try{await new Promise(r=>setTimeout(r,80));expect(audioStarted).toBe(false);expect((await(await nodes.runtime(node)).machine.state.status())?.queued).toBe(1);expect((await nodeSave({...node,concurrency:2},1)).statusCode).toBe(409);}finally{release();await work;await audio;}
  const updated=await nodeSave({...node,enabled:false,concurrency:2},1);expect(updated.statusCode,updated.body).toBe(200);
 });
 it('keeps zero physical foreign keys and indexed ordinary node relationships',async()=>{
  expect((await root.query("SELECT count(*)::int AS n FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace")).rows[0].n).toBe(0);
  const indexes=(await root.query("SELECT indexname FROM pg_indexes WHERE tablename='processing_node_assignments'")).rows.map(r=>r.indexname);expect(indexes).toContain('processing_node_assignments_active');
  await expect(workerPool.query('UPDATE runtime_configuration SET revision=revision+1')).rejects.toMatchObject({code:'42501'});
 });
 it('blocks fresh admission if Redis loses durable remote occupancy',async()=>{
  await root.query(`UPDATE processing_nodes SET config=jsonb_set(config,'{enabled}','false')`);const node=baseNode();expect((await nodeSave(node)).statusCode).toBe(200);const previous=request();
  await expect(nodes.withNode('document',previous,async()=>{throw new ParserExecutionError('TEST_REMOTE_UNKNOWN');})).rejects.toMatchObject({code:'DOCUMENT_PARSER_EXECUTION_UNKNOWN'});
  const runtime=await nodes.runtime(node),keys=await redis.keys(runtime.machine.state.keyPrefix+':*');if(keys.length)await redis.del(...keys);
  let executed=false;await expect(nodes.withNode('audio',request(),async()=>{executed=true;})).rejects.toMatchObject({code:'PROCESSING_NODE_COORDINATION_UNCERTAIN'});expect(executed).toBe(false);
  expect((await root.query('SELECT started,settled FROM processing_node_assignments WHERE request_id=$1',[previous.requestId])).rows[0]).toMatchObject({started:true,settled:false});
 });
});


describe('Admin-only document trial, no business ingestion',()=>{
 const counts=async()=>Object.fromEntries(await Promise.all(['notes','resources','rag_ingestion_versions','text_ingestion_jobs','kb_document_keyword_builds','kb_document_keyword_chunks','tasks','task_inputs'].map(async table=>[table,Number((await root.query('SELECT count(*) AS n FROM '+table)).rows[0].n)])));
 it('checks admin session, superadmin and CSRF before accepting a trial',async()=>{
  expect((await app.inject('/admin/api/v1/document-trials/capabilities')).statusCode).toBe(401);
  expect((await app.inject({url:'/admin/api/v1/document-trials/capabilities',headers:{cookie:operatorCookie}})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/admin/api/v1/document-trials',headers:{cookie:superCookie,origin:env.ADMIN_PUBLIC_BASE_URL},payload:{fileUrl:'https://example.test/a.pdf'}})).statusCode).toBe(403);
 });
 it('extracts native Markdown through the business parser without writing documents or indexes',async()=>{
  const before=await counts(),content='# 管理员试用\n\nNATIVE_NO_STORE_2718\n';
  const created=await app.inject({method:'POST',url:'/admin/api/v1/document-trials/upload?fileName=trial.md&mimeType=text%2Fmarkdown',headers:{...headers(),'content-type':'application/octet-stream'},payload:Buffer.from(content)});
  expect(created.statusCode,created.body).toBe(202);const id=created.json().data.id;
  await vi.waitFor(async()=>{const r=await app.inject({url:'/admin/api/v1/document-trials/'+id,headers:{cookie:superCookie}});expect(r.json().data.state).toBe('completed');});
  const result=await app.inject({url:'/admin/api/v1/document-trials/'+id+'/result',headers:{cookie:superCookie}});expect(result.statusCode,result.body).toBe(200);expect(result.json().data.result.content).toContain('NATIVE_NO_STORE_2718');
  expect(await counts()).toEqual(before);
  expect((await root.query("SELECT count(*)::int AS n FROM admin_audit_events WHERE action='document-trial.start' AND target_id=$1",[id])).rows[0].n).toBe(1);
 });
 it('rejects unsupported names, unconfigured PDF and unsafe download links',async()=>{
  for(const[fileName,expected]of [['../a.txt',400],['a.exe',400],['a.pdf',503]] as const){
   const r=await app.inject({method:'POST',url:'/admin/api/v1/document-trials/upload?'+new URLSearchParams({fileName,mimeType:'application/octet-stream'}),headers:{...headers(),'content-type':'application/octet-stream'},payload:Buffer.from('sample')});expect(r.statusCode,r.body).toBe(expected);
  }
  const url=await app.inject({method:'POST',url:'/admin/api/v1/document-trials',headers:headers(),payload:{fileUrl:'http://169.254.169.254/latest/meta-data/'}});expect(url.statusCode,url.body).toBe(400);
 });
 it('uses the same full config, extraction protocol and node occupancy for PDF without business persistence',async()=>{
  await root.query(`UPDATE processing_nodes SET config=jsonb_set(config,'{enabled}','false')`);const node=baseNode({capabilities:['document']});expect((await nodeSave(node)).statusCode).toBe(200);
  const extraction=extractionConfig('sync');await root.query('UPDATE runtime_configuration SET "values"=$1,revision=revision+1',[JSON.stringify({'document.mode':'sync','document.parameters':extraction.parameters,'document.pollMs':100})]);
  const fetchDouble=vi.fn<typeof fetch>(async(_url,options)=>{
   const form=options!.body as FormData;expect(JSON.parse(String(form.get('config')))).toEqual(extraction.parameters);
   const context=(JSON.parse(String(form.get('file_contexts'))) as FileContext[])[0]!;return new Response(JSON.stringify(sampleExtraction(context)),{status:200});
  });
  const service=new AdminDocumentTrials(adminPool,adminConfig,fetchDouble),scope=await new AdminService(adminPool,adminConfig.adminSessionSecret!).authenticate(superCookie.split('=')[1]);
  const before=await counts();
  try{
   const job=await service.start(scope,{file:{bytes:Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF'),fileName:'trial.pdf',contentType:'application/pdf',finalUrl:''}},randomUUID());
   await vi.waitFor(()=>expect(service.status(scope,job.id).state).toBe('completed'));
   expect(fetchDouble).toHaveBeenCalledTimes(1);expect(service.result(scope,job.id).result).toMatchObject({summary:{errors:0}});
   expect((await root.query('SELECT settled FROM processing_node_assignments WHERE request_id=$1',[job.id])).rows[0].settled).toBe(true);
   expect(()=>service.status({...scope,adminId:randomUUID()},job.id)).toThrow('ADMIN_TRIAL_NOT_FOUND');expect(await counts()).toEqual(before);
  }finally{await service.close();await root.query('UPDATE runtime_configuration SET "values"=\'{}\',revision=revision+1');await root.query(`UPDATE processing_nodes SET config=jsonb_set(config,'{enabled}','false')`);}
 });
});
