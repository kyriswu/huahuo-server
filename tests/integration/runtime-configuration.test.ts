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
import {RUNTIME_CONFIGURATION_SCHEMA_KEY,RUNTIME_CONFIGURATION_SCHEMA_VERSION} from '../../src/modules/runtime-settings/registry.js';
import {ParserExecutionError,DocumentParserMachine,ParserMachineRedis} from '../../src/lib/document-parser-machine/index.js';
import {ParserMachineIdleMonitor,type MonitorEvents} from '../../src/lib/document-parser-machine/monitor.js';
import {ProcessingNodeJobs} from '../../src/modules/processing-nodes/jobs.js';
import {TaskEngine} from '../../src/modules/tasks/engine.js';
import {AliyunEcsPower,type EcsInstance,type EcsPowerPort} from '../../src/integrations/ecs-power.js';
import {insertFixtureUser,insertFixtureSession,testJwtEnv} from './jwt-fixture.js';
import {BillingService} from '../../src/modules/billing/service.js';
import {transaction} from '../../src/modules/identity/store.js';
import {AdminDocumentTrials} from '../../src/modules/admin/document-trials.js';
import {AdminService} from '../../src/modules/admin/service.js';
import {sampleExtraction} from '../support/document-extraction.js';
import type {FileContext} from '../../src/integrations/document-extraction.js';
import {DocumentCallbacks} from '../../src/modules/ingestion/document-callbacks.js';
import {defaultDocumentApi} from '../../src/config/document-extraction.js';

const database=process.env.TEST_DATABASE_MIGRATION_URL,redisUrl=process.env.REDIS_QUEUE_URL;
if(!database||!/^huahuo_test_/.test(new URL(database).pathname.slice(1))||!redisUrl||new URL(redisUrl).hostname!=='127.0.0.1'||Number(new URL(redisUrl).pathname.slice(1))<10)throw Error('ISOLATED_DEPENDENCIES_REQUIRED');
const env={...testJwtEnv,APP_ENV:'test',LOG_LEVEL:'silent',APP_PUBLIC_BASE_URL:'http://runtime-api.test',API_SERVICE_BASE_URL:'http://runtime-api.internal.test',ADMIN_PUBLIC_BASE_URL:'http://runtime-admin.test',APP_TOKEN_SECRET:'a'.repeat(48),ADMIN_SESSION_SECRET:'b'.repeat(48),REDIS_CACHE_URL:process.env.REDIS_CACHE_URL,REDIS_QUEUE_URL:redisUrl,REDIS_KEY_PREFIX:'runtime_'+randomUUID().replaceAll('-',''),PROCESSING_NODES_ENABLED:'true'};
const root=poolFor(loadConfig('migrate',{DATABASE_URL:database}));
const adminConfig=loadConfig('admin',{...env,DATABASE_URL:process.env.TEST_DATABASE_ADMIN_URL});
const workerConfig=loadConfig('worker',{...env,DATABASE_URL:process.env.TEST_DATABASE_WORKER_URL});
const adminPool=poolFor(adminConfig),workerPool=poolFor(workerConfig),redis=new Redis(redisUrl,{lazyConnect:true,maxRetriesPerRequest:0});redis.on('error',()=>undefined);
const nodes=new ProcessingNodes(workerPool,workerConfig);
const app=await buildAdminServer({config:adminConfig,dependencies:{pool:adminPool,check:async()=>({postgres:true,schema:true,redisCache:true,redisQueue:true}),close:async()=>undefined}});
let superCookie='',csrf='',operatorCookie='',operatorCsrf='';
const adminIds:string[]=[];
const baseNode=(extra:Partial<ProcessingNode>={}):ProcessingNode=>({id:randomUUID(),name:'Test CPU node',capabilities:['document','audio'],resourceClass:'cpu',mode:'always-on',regionId:null,instanceId:null,privateIp:null,baseUrl:'http://127.0.0.1:18000/'+randomUUID(),healthPath:'',tokenEnv:null,concurrency:1,idleSeconds:60,startupSeconds:10,queueSeconds:10,revision:1,...extra});
const request=()=>({requestId:randomUUID(),fingerprint:createHash('sha256').update('document/config').digest('hex')});
const headers=()=>({cookie:superCookie,origin:env.ADMIN_PUBLIC_BASE_URL,'x-csrf-token':csrf});
async function get(){const r=await app.inject({url:'/admin/api/v1/configuration',headers:{cookie:superCookie}});expect(r.statusCode,r.body).toBe(200);return r.json().data;}
async function save(category:string,values:Record<string,unknown>,revision?:number,custom=headers()){
 return app.inject({method:'PUT',url:'/admin/api/v1/configuration/'+category,headers:custom,payload:{revision:revision??(await get()).revision,values}});
}
async function nodeSave(node:ProcessingNode,revision=0){return app.inject({method:'PUT',url:'/admin/api/v1/processing-nodes/'+node.id,headers:headers(),payload:{node,revision}});}
// Test-only equivalent of publishing a reviewed catalog row; Admin cannot create nodes.
async function publishTestNode(node:ProcessingNode){const {id,revision,...config}=node;await root.query('INSERT INTO processing_nodes(id,config,revision) VALUES($1,$2,$3)',[id,JSON.stringify({...config,enabled:true}),revision]);}
let originalNodes:Record<string,unknown>[]=[];
beforeAll(async()=>{
 await migrate(loadConfig('migrate',{DATABASE_URL:database}));await redis.connect();originalNodes=(await root.query('SELECT * FROM processing_nodes')).rows;
 await root.query('UPDATE runtime_configuration SET "values"=\'{}\',revision=revision+1');await root.query('DELETE FROM processing_nodes');
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
 await root.query('UPDATE runtime_configuration SET "values"=\'{}\',revision=revision+1');await root.query('DELETE FROM processing_nodes');
 for(const row of originalNodes)await root.query('INSERT INTO processing_nodes(id,config,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5)',[row.id,JSON.stringify(row.config),row.revision,row.created_at,row.updated_at]);
 const keys=await redis.keys(env.REDIS_KEY_PREFIX+':*');if(keys.length)await redis.del(...keys);redis.disconnect();
 await Promise.all([root.end(),adminPool.end(),workerPool.end()]);
});

describe('categorized runtime configuration: real isolated PostgreSQL/Redis, no paid provider',()=>{
 it('requires admin sessions, denies App Bearer and isolates the API role',async()=>{
  expect((await app.inject({url:'/admin/api/v1/configuration',headers:{authorization:'Bearer app-token'}})).statusCode).toBe(401);
  const cfg=loadConfig('api-server',{...env,DATABASE_URL:process.env.TEST_DATABASE_API_URL});const api=await buildApiServer({config:cfg});
  try{expect((await api.inject('/admin/api/v1/configuration')).statusCode).toBe(404);}finally{await api.close();}
  const r=await app.inject({url:'/admin/api/v1/processing-nodes',headers:{cookie:operatorCookie}});expect(r.statusCode).toBe(200);
  expect(r.json().data.items).toEqual([]);
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
  const view=await get();expect(view.definitions.map((d:{category:string})=>d.category)).toEqual(expect.arrayContaining(['tasks','rag','storage','billing','features']));
  expect(JSON.stringify(view)).not.toContain('password_hash');
  // An ordinary edit must not add metadata unknown to pre-compatibility binaries
  // or persist this Admin version's complete set of defaults.
  expect((await root.query('SELECT "values" FROM runtime_configuration WHERE singleton=true')).rows[0].values).toEqual({'tasks.maxAttempts':view.values['tasks.maxAttempts']});
 });
 it('keeps a consistent per-request snapshot across concurrent edits and refreshes subsequent work',async()=>{
  await save('tasks',{'tasks.maxAttempts':4});const settings=new RuntimeSettings(workerPool,workerConfig);
  let release!:()=>void;let entered!:()=>void;const gate=new Promise<void>(r=>release=r),start=new Promise<void>(r=>entered=r);
  const first=settings.run(async()=>{expect(workerConfig.taskPolicy.maxAttempts).toBe(4);entered();await gate;expect(workerConfig.taskPolicy.maxAttempts).toBe(4);return currentRuntimeConfig()!.runtimeRevision;});
  await start;await save('tasks',{'tasks.maxAttempts':6});
  const second=await settings.run(async()=>{expect(workerConfig.taskPolicy.maxAttempts).toBe(6);return workerConfig.runtimeRevision;});
  release();expect(await first).toBeLessThan(second);expect(currentRuntimeConfig()).toBeUndefined();expect(workerConfig.taskPolicy.maxAttempts).toBe(3);
 });
 it('edits the database drain budget in the existing deployment category and preserves future fields',async()=>{
  const original=(await root.query('SELECT "values" FROM runtime_configuration WHERE singleton=true')).rows[0].values;
  const future={'deployment.futureOptional':{enabled:false}};
  try{
   await root.query('UPDATE runtime_configuration SET "values"=$1,revision=revision+1 WHERE singleton=true',[JSON.stringify({...original,...future})]);
   const response=await save('deployment',{'deployment.drainTimeoutMs':900000});expect(response.statusCode,response.body).toBe(200);
   expect(app.drainTimeoutSnapshotMs()).toBe(900000);
   expect(await app.readDrainTimeoutMs()).toBe(900000);
   expect((await root.query('SELECT "values" FROM runtime_configuration WHERE singleton=true')).rows[0].values).toEqual({...original,...future,'deployment.drainTimeoutMs':900000});
   expect((await save('deployment',{'deployment.drainTimeoutMs':599999})).statusCode).toBe(400);
   expect((await save('deployment',{'deployment.drainTimeoutMs':600000},undefined,{cookie:operatorCookie,origin:env.ADMIN_PUBLIC_BASE_URL,'x-csrf-token':operatorCsrf})).statusCode).toBe(403);
  }finally{await root.query('UPDATE runtime_configuration SET "values"=$1,revision=revision+1 WHERE singleton=true',[JSON.stringify(original)]);}
 });
 it('reads future optional fields safely and preserves them through a strict older Admin edit',async()=>{
  const original=(await root.query('SELECT "values" FROM runtime_configuration WHERE singleton=true')).rows[0].values;
  const stored={[RUNTIME_CONFIGURATION_SCHEMA_KEY]:RUNTIME_CONFIGURATION_SCHEMA_VERSION,'tasks.futureOptional':{enabled:false,weights:[1,2]},'tasks.maxAttempts':4};
  const settings=new RuntimeSettings(workerPool,workerConfig);
  try{
   await root.query('UPDATE runtime_configuration SET "values"=$1,revision=revision+1 WHERE singleton=true',[JSON.stringify(stored)]);
   const state=await get();expect(state.values['tasks.maxAttempts']).toBe(4);
   expect(Object.hasOwn(state.values,'tasks.futureOptional')).toBe(false);expect(state.values).not.toHaveProperty(RUNTIME_CONFIGURATION_SCHEMA_KEY);
   expect((await app.inject('/health/ready')).statusCode).toBe(200);
   await settings.run(async()=>{expect(workerConfig.taskPolicy.maxAttempts).toBe(4);});
   const result=await save('tasks',{'tasks.maxAttempts':6},state.revision);expect(result.statusCode,result.body).toBe(200);
   expect(Object.hasOwn(result.json().data.values,'tasks.futureOptional')).toBe(false);
   expect(result.json().data.values).not.toHaveProperty(RUNTIME_CONFIGURATION_SCHEMA_KEY);
   const persisted=(await root.query('SELECT revision,"values" FROM runtime_configuration WHERE singleton=true')).rows[0];
   expect(persisted.values).toEqual({...stored,'tasks.maxAttempts':6});
   for(const patch of [{'tasks.futureOptional':{enabled:true}},{[RUNTIME_CONFIGURATION_SCHEMA_KEY]:2}]){
    expect((await save('tasks',patch,Number(persisted.revision))).statusCode).toBe(400);
   }
   expect((await save('tasks',{'tasks.maxAttempts':5},state.revision)).statusCode).toBe(409);
   const unchanged=(await root.query('SELECT revision,"values" FROM runtime_configuration WHERE singleton=true')).rows[0];
   expect(unchanged).toEqual(persisted);
   await settings.run(async()=>{expect(workerConfig.taskPolicy.maxAttempts).toBe(6);});
  }finally{await root.query('UPDATE runtime_configuration SET "values"=$1,revision=revision+1 WHERE singleton=true',[JSON.stringify(original)]);}
 });
 it('refuses an incompatible configuration contract without executing work or overwriting it',async()=>{
  const original=(await root.query('SELECT "values" FROM runtime_configuration WHERE singleton=true')).rows[0].values;
  const stored={...original,[RUNTIME_CONFIGURATION_SCHEMA_KEY]:RUNTIME_CONFIGURATION_SCHEMA_VERSION+1};
  const settings=new RuntimeSettings(workerPool,workerConfig),execute=vi.fn(async()=>undefined);
  try{
   const state=(await root.query('UPDATE runtime_configuration SET "values"=$1,revision=revision+1 WHERE singleton=true RETURNING revision',[JSON.stringify(stored)])).rows[0];
   await expect(settings.load()).rejects.toMatchObject({code:'CONFIGURATION_VERSION_UNSUPPORTED',statusCode:503});
   await expect(settings.run(execute)).rejects.toMatchObject({code:'CONFIGURATION_VERSION_UNSUPPORTED'});expect(execute).not.toHaveBeenCalled();
   expect((await app.inject('/health/ready')).statusCode).toBe(503);expect((await app.inject('/health/live')).statusCode).toBe(200);
   const view=await app.inject({url:'/admin/api/v1/configuration',headers:{cookie:superCookie}});expect(view.statusCode,view.body).toBe(503);
   const rejected=await save('tasks',{'tasks.maxAttempts':5},Number(state.revision));expect(rejected.statusCode,rejected.body).toBe(503);
   expect(rejected.json().error.code).toBe('CONFIGURATION_VERSION_UNSUPPORTED');
   const unchanged=(await root.query('SELECT revision,"values" FROM runtime_configuration WHERE singleton=true')).rows[0];
   expect(unchanged).toEqual({revision:state.revision,values:stored});
   expect((await root.query("SELECT count(*)::int AS n FROM admin_audit_events WHERE action='configuration.update' AND trace_id=$1",[rejected.json().traceId])).rows[0].n).toBe(0);
  }finally{await root.query('UPDATE runtime_configuration SET "values"=$1,revision=revision+1 WHERE singleton=true',[JSON.stringify(original)]);}
  expect((await app.inject('/health/ready')).statusCode).toBe(200);
 });
 it('fails readiness for invalid known values and forbidden secrets even alongside compatible future fields',async()=>{
  const original=(await root.query('SELECT "values" FROM runtime_configuration WHERE singleton=true')).rows[0].values;
  const settings=new RuntimeSettings(workerPool,workerConfig),execute=vi.fn(async()=>undefined);
  try{
   for(const [patch,code] of [[{'tasks.maxAttempts':99},'CONFIGURATION_INVALID'],[{'tasks.futureOptional':{apiKey:'must-not-persist'}},'CONFIGURATION_SECRET_FORBIDDEN']] as const){
    await root.query('UPDATE runtime_configuration SET "values"=$1,revision=revision+1 WHERE singleton=true',[JSON.stringify({...original,'tasks.futureOptional':false,...patch})]);
    await expect(settings.run(execute)).rejects.toMatchObject({code});
    const response=await app.inject('/health/ready');expect(response.statusCode,response.body).toBe(503);expect(response.body).not.toContain('must-not-persist');
    expect((await app.inject('/health/live')).statusCode).toBe(200);
   }
   expect(execute).not.toHaveBeenCalled();
  }finally{await root.query('UPDATE runtime_configuration SET "values"=$1,revision=revision+1 WHERE singleton=true',[JSON.stringify(original)]);}
  expect((await app.inject('/health/ready')).statusCode).toBe(200);
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
 it('admits registered nodes regardless of the retired toggle and rejects it as an editable API field',async()=>{
  await root.query('DELETE FROM processing_nodes');const node=baseNode();await publishTestNode(node);
  await root.query(`UPDATE processing_nodes SET config=jsonb_set(config,'{enabled}','false') WHERE id=$1`,[node.id]);
  const id=randomUUID();expect((await nodes.bind(id,'document')).id).toBe(node.id);await nodes.settle(id);
  expect((await nodes.list())[0]).not.toHaveProperty('enabled');
  const response=await app.inject({method:'PUT',url:'/admin/api/v1/processing-nodes/'+node.id,headers:headers(),payload:{node:{...node,enabled:false},revision:1}});
  expect(response.statusCode).toBe(400);await root.query('DELETE FROM processing_nodes');
 });
 it('assigns by occupied capacity, preserves node affinity and shares document/audio occupancy',async()=>{
  const a=baseNode(),b=baseNode({documentApi:{...defaultDocumentApi(),mode:'async',timeoutSeconds:4000}});await publishTestNode(a);await publishTestNode(b);
  const first=await nodes.bind('first-'+a.id,'document'),second=await nodes.bind('second-'+a.id,'audio');expect(first.id).not.toBe(second.id);
  expect(first.documentApi).toMatchObject({mode:'async',parameters:null,timeoutSeconds:3120});
  expect(second.documentApi).toMatchObject({mode:'async',parameters:null,timeoutSeconds:4000});
  expect((await nodes.bind('first-'+a.id,'document')).id).toBe(first.id);
  await expect(nodes.bind('first-'+a.id,'audio')).rejects.toMatchObject({code:'PROCESSING_ASSIGNMENT_CONFLICT'});
  const disabled={...Object.fromEntries(Object.entries(first).reverse()),name:'Renamed node'} as ProcessingNode;expect((await nodeSave(disabled,1)).statusCode).toBe(200);
  expect((await nodes.assigned('first-'+a.id)).id).toBe(first.id);
  expect((await nodes.bind('third-'+a.id,'document')).id).toBe(first.id);
  const change={...disabled,baseUrl:'http://127.0.0.1:19000',revision:2};expect((await nodeSave(change,2)).statusCode).toBe(409);
  await nodes.settle('first-'+a.id);await nodes.settle('second-'+a.id);await nodes.settle('third-'+a.id);
  await root.query('DELETE FROM processing_nodes');
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
 it('refuses Admin node creation while retaining existing-node revision protection',async()=>{
  const existing=baseNode();await publishTestNode(existing);
  const count=Number((await root.query('SELECT count(*) AS n FROM processing_nodes')).rows[0].n);
  const created=await nodeSave({...existing,id:randomUUID(),revision:1});expect(created.statusCode).toBe(404);expect(created.json().error.code).toBe('PROCESSING_NODE_NOT_FOUND');
  expect(Number((await root.query('SELECT count(*) AS n FROM processing_nodes')).rows[0].n)).toBe(count);
  expect((await nodeSave({...existing,name:'stale'},0)).statusCode).toBe(409);
 });
 it('stores one JSON configuration per node and increments the existing row on edits',async()=>{
  const node=baseNode();await publishTestNode(node);
  const first=await nodeSave({...node,name:'Renamed CPU'},1);expect(first.statusCode,first.body).toBe(200);
  const next=await nodeSave({...first.json().data,name:'Shared document/audio CPU'},2);expect(next.statusCode,next.body).toBe(200);
  const rows=(await root.query('SELECT * FROM processing_nodes WHERE id=$1',[node.id])).rows;
  expect(rows).toHaveLength(1);expect(Object.keys(rows[0]).sort()).toEqual(['config','created_at','id','revision','updated_at']);
  expect(rows[0].revision).toBe(3);expect(rows[0].config).toMatchObject({name:'Shared document/audio CPU',capabilities:['document','audio'],enabled:true});
  expect(rows[0].config).not.toHaveProperty('revision');expect(rows[0].config).not.toHaveProperty('id');
  expect((await nodes.list()).find(n=>n.id===node.id)).toMatchObject({...node,name:'Shared document/audio CPU',revision:3});
  expect((await nodeSave({...node,name:'Stale edit'},1)).statusCode).toBe(409);
  await expect(root.query(`UPDATE processing_nodes SET config=jsonb_set(config,'{concurrency}','0') WHERE id=$1`,[node.id])).rejects.toMatchObject({code:'23514'});
 });
 it('retains ambiguous execution and resumes its original registered node',async()=>{
  const node=baseNode();await publishTestNode(node);const input={...request(),nodeId:node.id};
  await expect(nodes.withNode('document',input,async()=>{throw new ParserExecutionError('TEST_REMOTE_UNKNOWN');})).rejects.toMatchObject({code:'DOCUMENT_PARSER_EXECUTION_UNKNOWN'});
  expect((await root.query('SELECT settled FROM processing_node_assignments WHERE request_id=$1',[input.requestId])).rows[0].settled).toBe(false);
  const status=await(await nodes.runtime(node)).machine.state.status();expect(status?.uncertain).toBe(1);
  expect((await nodeSave({...node},1)).statusCode).toBe(200);
  expect(await nodes.withNode('document',{...input,resume:true},async ctx=>ctx.baseUrl)).toBe(node.baseUrl);
  expect((await root.query('SELECT settled FROM processing_node_assignments WHERE request_id=$1',[input.requestId])).rows[0].settled).toBe(true);
  await expect(nodes.withNode('document',input,async()=>{throw Error('must not run');})).rejects.toMatchObject({code:'PROCESSING_ASSIGNMENT_SETTLED'});
 });
 it('enforces shared Redis slots across capabilities and protects routing changes until drained',async()=>{
  const node=baseNode();await publishTestNode(node);const first={...request(),nodeId:node.id},second={...request(),nodeId:node.id};
  let release!:()=>void;let started!:()=>void;const gate=new Promise<void>(r=>release=r),start=new Promise<void>(r=>started=r);let audioStarted=false;
  const work=nodes.withNode('document',first,async()=>{started();await gate;});await start;
  const audio=nodes.withNode('audio',second,async()=>{audioStarted=true;});
  try{await new Promise(r=>setTimeout(r,80));expect(audioStarted).toBe(false);expect((await(await nodes.runtime(node)).machine.state.status())?.queued).toBe(1);expect((await nodeSave({...node,concurrency:2},1)).statusCode).toBe(409);}finally{release();await work;await audio;}
  const updated=await nodeSave({...node,concurrency:2},1);expect(updated.statusCode,updated.body).toBe(200);
 });
 it('keeps zero physical foreign keys and indexed ordinary node relationships',async()=>{
  expect((await root.query("SELECT count(*)::int AS n FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace")).rows[0].n).toBe(0);
  const indexes=(await root.query("SELECT indexname FROM pg_indexes WHERE tablename='processing_node_assignments'")).rows.map(r=>r.indexname);expect(indexes).toContain('processing_node_assignments_active');
  await expect(workerPool.query('UPDATE runtime_configuration SET revision=revision+1')).rejects.toMatchObject({code:'42501'});
 });
 it('blocks fresh admission if Redis loses durable remote occupancy',async()=>{
  await root.query('DELETE FROM processing_nodes');const node=baseNode();await publishTestNode(node);const previous=request();
  await expect(nodes.withNode('document',previous,async()=>{throw new ParserExecutionError('TEST_REMOTE_UNKNOWN');})).rejects.toMatchObject({code:'DOCUMENT_PARSER_EXECUTION_UNKNOWN'});
  const runtime=await nodes.runtime(node),keys=await redis.keys(runtime.machine.state.keyPrefix+':*');if(keys.length)await redis.del(...keys);
  let executed=false;await expect(nodes.withNode('audio',request(),async()=>{executed=true;})).rejects.toMatchObject({code:'PROCESSING_NODE_COORDINATION_UNCERTAIN'});expect(executed).toBe(false);
  expect((await root.query('SELECT started,settled FROM processing_node_assignments WHERE request_id=$1',[previous.requestId])).rows[0]).toMatchObject({started:true,settled:false});
 });
});


describe('manual startup: durable tasks, event notifications and mock cloud only',()=>{
 it('starts from outside the parser VPC, completes at Running and never calls the private API',async()=>{
  const node=baseNode({name:'Manual CPU node',mode:'ecs',capabilities:['document'],regionId:'cn-beijing',instanceId:'i-manual'+randomUUID().replaceAll('-','').slice(0,16),privateIp:'172.18.102.103',baseUrl:'http://172.18.102.103:8000',healthPath:'/health'});
  node.tokenEnv='PROCESSING_NODE_TOKEN_DOCUMENT';await publishTestNode(node);
  const externalAdmin={...adminConfig,processingNodes:{...adminConfig.processingNodes,enabled:false,cloudControlEnabled:true}};
  const externalWorker={...workerConfig,processingNodes:{...workerConfig.processingNodes,enabled:false,cloudControlEnabled:true}};
  const live=await buildAdminServer({config:externalAdmin,dependencies:{pool:adminPool,check:async()=>({postgres:true,schema:true,redisCache:true,redisQueue:true}),close:async()=>undefined}});
  const path=`/admin/api/v1/processing-nodes/${node.id}/start`;
  expect((await live.inject({method:'POST',url:path})).statusCode).toBe(401);
  expect((await live.inject({method:'POST',url:path,headers:{cookie:superCookie,origin:env.ADMIN_PUBLIC_BASE_URL}})).statusCode).toBe(403);
  expect((await live.inject({method:'POST',url:path,headers:{cookie:operatorCookie,origin:env.ADMIN_PUBLIC_BASE_URL,'x-csrf-token':operatorCsrf}})).statusCode).toBe(403);
  const first=await live.inject({method:'POST',url:path,headers:headers()}),second=await live.inject({method:'POST',url:path,headers:headers()});
  expect(first.statusCode,first.body).toBe(202);expect(second.json().data.taskId).toBe(first.json().data.taskId);
  const taskId=first.json().data.taskId as string;
  const instance:EcsInstance={instanceId:node.instanceId!,regionId:node.regionId!,instanceType:'ecs.c8y.16xlarge',status:'Stopped',stoppedMode:'StopCharging',chargeType:'PostPaid',networkType:'vpc',vpcId:'vpc-test',privateIps:[node.privateIp!],localStorageAmount:0,localStorageCapacity:0,operationLocked:false};
  const cloud:EcsPowerPort={describe:vi.fn(async()=>({...instance})),start:vi.fn(async()=>{instance.status='Starting';}),stopEconomically:vi.fn(async()=>undefined)};
  const workerHealth=vi.fn(async()=>false);
  const monitorErrors:unknown[]=[];
  const controlled=new ProcessingNodes(workerPool,externalWorker,cfg=>{
   const state=new ParserMachineRedis(redis,cfg,env.REDIS_KEY_PREFIX),machine=new DocumentParserMachine(state,cloud,cfg,workerHealth);
   let monitor:ParserMachineIdleMonitor|undefined;
   return {machine,connect:async()=>undefined,watch:async()=>()=>undefined,close:async()=>{await monitor?.close();},startIdleMonitor:async(events:MonitorEvents={})=>{
    if(cfg.mode!=='ecs'||monitor)return;
    const subscriber=redis.duplicate({lazyConnect:true});subscriber.on('error',()=>undefined);
    monitor=new ParserMachineIdleMonitor(machine,subscriber,state.eventsChannel,cfg.idleMs,events);await monitor.start();
   }};
  });
  const jobs=new ProcessingNodeJobs(workerPool,externalWorker,controlled),engine=new TaskEngine(workerPool,15000,undefined,undefined,undefined,undefined,undefined,undefined,jobs);
  const streamAbort=new AbortController();
  const describe=vi.spyOn(AliyunEcsPower.prototype,'describe').mockImplementation(async()=>({...instance})),originalFetch=globalThis.fetch;
  const privateRequest=vi.fn();const health=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{if(String(url).startsWith(node.baseUrl)){privateRequest();throw Error('PRIVATE_API_NOT_ALLOWED_OUTSIDE');}return originalFetch(url,options);});
  try{
   await live.listen({host:'127.0.0.1',port:0});const address=live.server.address();if(!address||typeof address==='string')throw Error('TEST_ADDRESS');
   const stream=await fetch(`http://127.0.0.1:${address.port}/admin/api/v1/processing-nodes/${node.id}/events`,{headers:{cookie:superCookie},signal:AbortSignal.any([streamAbort.signal,AbortSignal.timeout(6000)])});
   expect(stream.status).toBe(200);expect(stream.headers.get('content-type')).toContain('text/event-stream');
   const reader=stream.body!.getReader(),decoder=new TextDecoder();let body='';
   const until=async(state:string)=>{while(!body.includes(`"state":"${state}"`)){const chunk=await reader.read();expect(chunk.done).toBe(false);body+=decoder.decode(chunk.value,{stream:true});}};
   await until('starting');
   const run=async()=>{await root.query("UPDATE tasks SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[taskId]);const attempt=await engine.claim(taskId,randomUUID());expect(attempt).not.toBeNull();return engine.execute(attempt!);};
   expect(await run()).toBe(false);expect(cloud.start).toHaveBeenCalledTimes(1);
   expect((await root.query('SELECT state,lease_owner,external_state FROM tasks WHERE id=$1',[taskId])).rows[0]).toMatchObject({state:'waiting_external',lease_owner:null,external_state:'none'});
   expect(await run()).toBe(false);expect(cloud.start).toHaveBeenCalledTimes(1);
   instance.status='Running';expect(await run()).toBe(true);
   await until('online');expect(body).toContain('"serviceStatus":"not_checked"');expect(workerHealth).not.toHaveBeenCalled();expect(privateRequest).not.toHaveBeenCalled();
   const privateParse=vi.fn(async()=>undefined);await expect(controlled.withNode('document',request(),privateParse)).rejects.toMatchObject({code:'PROCESSING_NODES_DISABLED'});expect(privateParse).not.toHaveBeenCalled();
   expect((await live.inject({url:'/admin/api/v1/document-trials/capabilities',headers:{cookie:superCookie}})).json().data.structuredEnabled).toBe(false);
   expect((await root.query('SELECT state,attempt_no,resume_count FROM tasks WHERE id=$1',[taskId])).rows[0]).toMatchObject({state:'succeeded',attempt_no:3,resume_count:2});
   expect((await root.query('SELECT settled FROM processing_node_assignments WHERE request_id=$1',['manual:'+taskId])).rows[0].settled).toBe(true);
   expect((await root.query("SELECT config->'enabled' AS enabled FROM processing_nodes WHERE id=$1",[node.id])).rows[0].enabled).toBe(true);
   expect(cloud.start).toHaveBeenCalledTimes(1);expect(cloud.stopEconomically).not.toHaveBeenCalled();
   // Manual boots are monitored even with private API calls and automatic admission disabled.
   await controlled.startMonitors(error=>monitorErrors.push(error));
   const runtime=await controlled.runtime(node,false),started=await runtime.machine.state.status();
   expect(started).toMatchObject({phase:'ready',active:0,queued:0,uncertain:0});
   expect(await runtime.machine.tick()).toBe('busy');expect(cloud.stopEconomically).not.toHaveBeenCalled();
   await controlled.observe(node.id);
   expect((await runtime.machine.state.status())?.lastActivityMs).toBe(started?.lastActivityMs);
   const [seconds,micros]=await redis.time();
   await redis.hset(`${runtime.machine.state.keyPrefix}:state`,'lastActivity',Number(seconds)*1000+Math.floor(Number(micros)/1000)-node.idleSeconds*1000-1);
   await redis.publish(runtime.machine.state.eventsChannel,'changed');
   await vi.waitFor(()=>expect(cloud.stopEconomically).toHaveBeenCalledTimes(1),{interval:5});
   expect((await runtime.machine.state.status())?.phase).toBe('stopping');
   instance.status='Stopped';expect(await runtime.machine.tick()).toBe('stop_confirmed');
   expect((await runtime.machine.state.status())?.economicallyStopped).toBe(true);
   await until('offline');expect(body).toContain('"canStart":true');await reader.cancel();
   expect(monitorErrors).toEqual([]);expect(workerHealth).not.toHaveBeenCalled();expect(privateRequest).not.toHaveBeenCalled();
  }finally{streamAbort.abort();await live.close();await jobs.close();describe.mockRestore();health.mockRestore();}
 });
 it('keeps the deployment switch authoritative and does not queue a paid action while disabled',async()=>{
  const scope=await new AdminService(adminPool,adminConfig.adminSessionSecret!).authenticate(superCookie.split('=')[1]);
  const disabled=new ProcessingNodeJobs(adminPool,{...adminConfig,processingNodes:{...adminConfig.processingNodes,enabled:false,cloudControlEnabled:false}});
  const before=Number((await root.query("SELECT count(*) AS n FROM tasks WHERE kind='processing.node-start'")).rows[0].n);
  try{await expect(disabled.start(randomUUID(),scope,randomUUID())).rejects.toMatchObject({code:'PROCESSING_NODE_CLOUD_CONTROL_DISABLED'});expect(Number((await root.query("SELECT count(*) AS n FROM tasks WHERE kind='processing.node-start'")).rows[0].n)).toBe(before);}finally{await disabled.close();}
 });
});

describe('Admin-only document trial, no business ingestion',()=>{
 const counts=async()=>Object.fromEntries(await Promise.all(['notes','resources','rag_ingestion_versions','text_ingestion_jobs','kb_document_keyword_builds','kb_document_keyword_chunks','tasks','task_inputs','task_outbox','document_parse_callbacks','processing_node_assignments','admin_audit_events'].map(async table=>[table,Number((await root.query('SELECT count(*) AS n FROM '+table)).rows[0].n)])));
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
  expect((await root.query("SELECT count(*)::int AS n FROM admin_audit_events WHERE action='document-trial.start' AND target_id=$1",[id])).rows[0].n).toBe(0);
 });
 it('rejects unsupported names, unconfigured PDF and unsafe download links',async()=>{
  await root.query('DELETE FROM processing_nodes');
  for(const[fileName,expected]of [['../a.txt',400],['a.exe',400],['a.pdf',503]] as const){
   const r=await app.inject({method:'POST',url:'/admin/api/v1/document-trials/upload?'+new URLSearchParams({fileName,mimeType:'application/octet-stream'}),headers:{...headers(),'content-type':'application/octet-stream'},payload:Buffer.from('sample')});expect(r.statusCode,r.body).toBe(expected);
  }
  const url=await app.inject({method:'POST',url:'/admin/api/v1/document-trials',headers:headers(),payload:{fileUrl:'http://169.254.169.254/latest/meta-data/'}});expect(url.statusCode,url.body).toBe(400);
 });
 it('probes the configured parser API with in-memory results and zero trial database writes',async()=>{
  await root.query('DELETE FROM processing_nodes');const node=baseNode({capabilities:['document']});await publishTestNode(node);
  let context:FileContext;const jobId=randomUUID();
  const fetchDouble=vi.fn<typeof fetch>(async(url,options)=>{
   if(options?.method==='POST'){
    expect(String(url)).toBe(node.baseUrl+'/extract-async');const form=options.body as FormData;
    expect(form.has('config')).toBe(false);expect(form.has('callback_url')).toBe(false);
    context=(JSON.parse(String(form.get('file_contexts'))) as FileContext[])[0]!;
    return new Response(JSON.stringify({job_id:jobId}),{status:202});
   }
   if(String(url).endsWith('/result'))return new Response(JSON.stringify({job_id:jobId,state:'completed',result:sampleExtraction(context)}));
   return new Response(JSON.stringify({job_id:jobId,state:'completed',result_state:'available'}));
  });
  const service=new AdminDocumentTrials(adminPool,adminConfig,fetchDouble),scope=await new AdminService(adminPool,adminConfig.adminSessionSecret!).authenticate(superCookie.split('=')[1]);
  const before=await counts();
  try{
   const job=await service.start(scope,{file:{bytes:Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF'),fileName:'trial.pdf',contentType:'application/pdf',finalUrl:''}});
   await vi.waitFor(()=>expect(service.status(scope,job.id).state).toBe('completed'));
   expect(fetchDouble).toHaveBeenCalledTimes(3);expect(service.result(scope,job.id).result).toMatchObject({summary:{errors:0}});
   expect(()=>service.status({...scope,adminId:randomUUID()},job.id)).toThrow('ADMIN_TRIAL_NOT_FOUND');expect(await counts()).toEqual(before);
   await expect(adminPool.query('SELECT 1 FROM document_parse_callbacks LIMIT 1')).rejects.toMatchObject({code:'42501'});
   await service.close();expect(()=>service.status(scope,job.id)).toThrow('ADMIN_TRIAL_NOT_FOUND');
  }finally{await service.close();await root.query('UPDATE runtime_configuration SET "values"=\'{}\',revision=revision+1');await root.query('DELETE FROM processing_nodes');}
 });
 it('checks configured health before upload and reports service unready without submitting a PDF',async()=>{
  await root.query('DELETE FROM processing_nodes');const node=baseNode({capabilities:['document'],healthPath:'/health'});await publishTestNode(node);
  const fetchDouble=vi.fn<typeof fetch>(async()=>new Response('{}',{status:503}));
  const service=new AdminDocumentTrials(adminPool,adminConfig,fetchDouble),scope=await new AdminService(adminPool,adminConfig.adminSessionSecret!).authenticate(superCookie.split('=')[1]);
  try{
   const job=await service.start(scope,{file:{bytes:Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF'),fileName:'unready.pdf',contentType:'application/pdf',finalUrl:''}});
   await vi.waitFor(()=>expect(service.status(scope,job.id)).toMatchObject({state:'failed',error:'ADMIN_TRIAL_SERVICE_UNREACHABLE'}));
   expect(fetchDouble).toHaveBeenCalledTimes(1);expect(fetchDouble.mock.calls[0]![1]?.method).toBe('GET');expect(service.status(scope,job.id).remoteJobId).toBeUndefined();
  }finally{await service.close();await root.query('DELETE FROM processing_nodes');}
 });
 it('discards an interrupted probe on close without durable recovery or a second submission',async()=>{
  await root.query('DELETE FROM processing_nodes');const node=baseNode({capabilities:['document']});await publishTestNode(node);
  const fetchDouble=vi.fn<typeof fetch>(async(_url,options)=>new Promise<Response>((_resolve,reject)=>{
   options!.signal!.addEventListener('abort',()=>reject(new Error('probe interrupted')),{once:true});
  }));
  const service=new AdminDocumentTrials(adminPool,adminConfig,fetchDouble),replacement=new AdminDocumentTrials(adminPool,adminConfig,fetchDouble);
  const scope=await new AdminService(adminPool,adminConfig.adminSessionSecret!).authenticate(superCookie.split('=')[1]),before=await counts();
  try{
   const job=await service.start(scope,{file:{bytes:Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF'),fileName:'interrupt.pdf',contentType:'application/pdf',finalUrl:''}});
   await vi.waitFor(()=>expect(fetchDouble).toHaveBeenCalledTimes(1));await service.close();
   expect(()=>service.status(scope,job.id)).toThrow('ADMIN_TRIAL_NOT_FOUND');expect(()=>replacement.status(scope,job.id)).toThrow('ADMIN_TRIAL_NOT_FOUND');
   await new Promise(resolve=>setTimeout(resolve,20));expect(fetchDouble).toHaveBeenCalledTimes(1);expect(await counts()).toEqual(before);
  }finally{await service.close();await replacement.close();await root.query('DELETE FROM processing_nodes');}
 });
 it('uses the API service address for durable user-task callbacks while Admin listens independently',async()=>{
  const apiConfig=loadConfig('api-server',{...env,DATABASE_URL:process.env.TEST_DATABASE_API_URL});
  const api=await buildApiServer({config:apiConfig});
  const apiAddress=await api.listen({host:'127.0.0.1',port:0}),adminAddress=await app.listen({host:'127.0.0.1',port:0});
  const callbacks=new DocumentCallbacks(workerPool,{...workerConfig,apiServiceBaseUrl:apiAddress});
  const missing=new DocumentCallbacks(workerPool,{...workerConfig,apiServiceBaseUrl:undefined});
  const context={source_resource_id:randomUUID(),parse_run_id:randomUUID()},input={requestId:randomUUID(),fingerprint:'a'.repeat(64),taskId:randomUUID(),contexts:[context],timeoutMs:30000,maxResponseBytes:67108864};
  const userId=await insertFixtureUser(root),workspaceId=randomUUID();
  await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'callback fixture',true,$3)",[workspaceId,userId,randomUUID()]);
  await root.query("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,state) VALUES($1,$2,$3,'rag.document-ingest','content','queued')",[input.taskId,userId,workspaceId]);
  try{
   expect(apiAddress).not.toBe(adminAddress);
   const adminResponse=await fetch(adminAddress+'/admin/api/v1/me',{headers:{cookie:superCookie}});expect(adminResponse.status).toBe(200);await adminResponse.text();
   await expect(transaction(workerPool,tx=>missing.prepare(tx,input))).rejects.toMatchObject({code:'API_SERVICE_ADDRESS_REQUIRED'});
   expect((await root.query('SELECT count(*)::int n FROM document_parse_callbacks WHERE request_id=$1',[input.requestId])).rows[0].n).toBe(0);
   const prepared=await transaction(workerPool,tx=>callbacks.prepare(tx,input));
   expect(new URL(prepared.url).origin).toBe(apiAddress);expect(new URL(prepared.url).origin).not.toBe(env.APP_PUBLIC_BASE_URL);
   const body={event:'extraction.completed',event_id:randomUUID(),job_id:randomUUID(),state:'completed',result:sampleExtraction(context)};
   const response=await fetch(prepared.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
   expect(response.status).toBe(200);expect((await response.json()).data).toMatchObject({accepted:true,duplicate:false});
   expect((await callbacks.forRequest(input.requestId))?.terminal_state).toBe('completed');
   const forged=new URL(prepared.url);forged.pathname=forged.pathname.replace(/[^/]+$/,'x'.repeat(43));
   const denied=await fetch(forged,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});expect(denied.status).toBe(404);await denied.text();
  }finally{await api.close();await root.query('DELETE FROM document_parse_callbacks WHERE request_id=$1',[input.requestId]);await root.query('DELETE FROM tasks WHERE id=$1',[input.taskId]);}
 });
});
