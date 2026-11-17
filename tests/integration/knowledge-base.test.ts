import {ProcessingNodes} from '../../src/modules/processing-nodes/service.js';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadTestConfig as loadConfig} from '../sms-fixture.js';
import {migrate} from '../../src/db/migrate.js';
import {poolFor} from '../../src/plugins/dependencies.js';
import {AssetService} from '../../src/modules/assets/service.js';
import {NoteIndexService} from '../../src/modules/ingestion/service.js';
import {NoteIndexJobs} from '../../src/modules/ingestion/jobs.js';
import {KnowledgeIndexJobs} from '../../src/modules/kb/jobs.js';
import {kbSnapshot,kbEmbedding} from '../../src/modules/kb/profile.js';
import {mockKnowledgeIndex} from '../support/kb-index.js';
import {mockOssUploadConfig} from '../support/oss-upload.js';
import type {KbBuild,KbSnapshot} from '../../src/modules/kb/types.js';
import {RagQueryService,ragImageKey,type RagImageRequest} from '../../src/modules/rag/query-service.js';
import {RagIngestionRepository} from '../../src/modules/rag/repository.js';
import {RagIngestionJobs} from '../../src/modules/rag/jobs.js';
import {storageFor} from '../../src/modules/storage/port.js';
import {TextIngestionService} from '../../src/modules/text-ingestion/service.js';
import {TextIngestionJobs} from '../../src/modules/text-ingestion/jobs.js';
import {TaskEngine} from '../../src/modules/tasks/engine.js';
import {createMilvusClient} from '../../src/integrations/search-index/milvus.js';
import {knowledgeIndex,type IndexFactory} from '../../src/modules/kb/profile.js';
import {requireIndexKind} from '../../src/lib/search-index/factory.js';
import type {KeywordIndex,KeywordPoint,SearchOptions} from '../../src/lib/search-index/types.js';
import {buildApiServer} from '../../src/apps/api-server.js';
import {insertFixtureUser,insertFixtureSession,testJwtEnv} from './jwt-fixture.js';
import { fixtureScopeHeaders } from './jwt-fixture.js';
import {RuntimeSettings} from '../../src/modules/runtime-settings/service.js';
import {configureTestMilvus} from '../support/milvus.js';
import {DataType} from '@zilliz/milvus2-sdk-node';
import * as markdownInput from '../../src/lib/markdown-images.js';
const url=process.env.TEST_DATABASE_MIGRATION_URL;
if(!url||!/^huahuo_test_/.test(new URL(url).pathname.slice(1)))throw new Error('ISOLATED_TEST_DB_REQUIRED');
const temp=await mkdtemp(join(tmpdir(),'kb-integration-'));
const env={...process.env,APP_ENV:'test',APP_PUBLIC_BASE_URL:'http://kb.test',ADMIN_PUBLIC_BASE_URL:'http://admin.kb.test',LOG_LEVEL:'silent',DATABASE_URL:process.env.TEST_DATABASE_API_URL,APP_TOKEN_SECRET:'kb-test-secret-'.repeat(4),ALLOW_MOCK_PROVIDERS:'true',RAG_PROVIDER_MODE:'mock',RAG_RERANK_PROVIDER:'disabled',STORAGE_DRIVER:'local',STORAGE_LOCAL_ROOT:temp,RAG_SOURCE_ALLOWED_HOSTS:'fixture.test',...testJwtEnv};
const config=loadConfig('api-server',env),workerConfig=loadConfig('worker',{...env,DATABASE_URL:process.env.TEST_DATABASE_WORKER_URL});
// Snapshots, jobs, queries and direct schema checks share the isolated target.
for(const cfg of [config,workerConfig])configureTestMilvus(cfg);
for(const cfg of [config,workerConfig]){cfg.kb.noteEnabled=true;Object.assign(cfg.rag,{embeddingBatchSize:2,embeddingMaxRetries:0});}
const root=poolFor(loadConfig('migrate',{DATABASE_URL:url})),pool=poolFor(config),wp=poolFor(workerConfig);
const memory=mockKnowledgeIndex();
const targets:string[]=[];
const factory:IndexFactory=(snapshot:KbSnapshot)=>{
 targets.push(snapshot.target.collection);
 return process.env.TEST_MILVUS_ADDRESS?knowledgeIndex(config,snapshot):snapshot.mode==='note-hybrid'?memory:memory.keyword;
};
const embeddings=vi.fn(async(s:KbSnapshot)=>kbEmbedding(config,s));
const deps={index:factory,embedding:(s:KbSnapshot)=>{const e=kbEmbedding(config,s);return {...e,model:s.embedding!.model,dimensions:1024,embed:vi.fn(async(texts:string[])=>{await embeddings(s);return e.embed(texts);})};}};
const queries=new RagQueryService(pool,config,{index:factory,embedding:{model:'qwen3.7-text-embedding-flash',dimensions:1024,embed:async texts=>kbEmbedding(config,kbSnapshot(config,'note-hybrid','markdown')).embed(texts)}});
const assets=new AssetService(pool,config.appTokenSecret!,config,queries);
const imageConfig=mockOssUploadConfig(config),imageAssets=new AssetService(pool,imageConfig.appTokenSecret!,imageConfig,queries);
const notes=new NoteIndexService(pool,config),jobs=new NoteIndexJobs(wp,workerConfig,deps),engine=new TaskEngine(wp,120000);
async function fixture(){const userId=await insertFixtureUser(root),sessionId=randomUUID(),workspaceId=randomUUID();const bearer=await insertFixtureSession(root,userId,sessionId);await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'KB',true,$3)",[workspaceId,userId,randomUUID()]);return {bearer,workspaceId,scope:{userId,sessionId,traceId:randomUUID()}};}
async function latest(id:string){return (await root.query<KbBuild>(`SELECT * FROM kb_note_hybrid_builds WHERE source_id=$1 AND source_revision=(SELECT part_revision_id::text FROM note_parts WHERE note_id=$1 AND part='raw' ORDER BY revision DESC LIMIT 1) ORDER BY created_at DESC LIMIT 1`,[id])).rows[0]!;}
async function runNote(id:string,indexer=jobs){const b=await latest(id);const a=await vi.waitFor(async()=>{const claim=await engine.claim(b.task_id,randomUUID());expect(claim).toBeTruthy();return claim!;},{interval:20,timeout:3000});const r=await indexer.execute(a);expect(await engine.finish(a,r.digest,r.bytes)).toBe(true);return b;}
async function create(body='PostgreSQL 数据库支持 MVCC 和 B-tree 索引。'){const f=await fixture();const note=await assets.createNote(f.scope,f.workspaceId,{title:'KB fixture',parts:{raw:body}},randomUUID());return {...f,note};}
beforeAll(async()=>{await migrate(loadConfig('migrate',{DATABASE_URL:url}));await root.query(`UPDATE runtime_configuration SET "values"="values"||'{"features.noteIndexing":true,"rag.embeddingBatchSize":2,"rag.embeddingMaxRetries":0}'::jsonb,revision=revision+1`);});
afterAll(async()=>{await queries.close();await root.query(`UPDATE runtime_configuration SET "values"="values"-'features.noteIndexing'-'rag.embeddingBatchSize'-'rag.embeddingMaxRetries',revision=revision+1`);await Promise.all([pool.end(),wp.end(),root.end()]);await rm(temp,{recursive:true,force:true});});
describe('two-mode knowledge indexing with real dependencies and deterministic model',()=>{
 it('refreshes cached recall parameters without closing a client still used by an earlier query',async()=>{
  // This cache-lifetime probe wraps the deterministic index; populate that same
  // index even when the rest of the suite uses the real ephemeral Milvus.
  const f=await create('runtimecache fixture body');await runNote(f.note.noteId,new NoteIndexJobs(wp,workerConfig,{...deps,index:()=>memory}));
  const original=(await root.query('SELECT "values" FROM runtime_configuration')).rows[0].values;
  const settings=new RuntimeSettings(pool,config),seen:{rrfK:number;closed:ReturnType<typeof vi.fn>}[]=[];
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),start=new Promise<void>(r=>entered=r);
  const q=new RagQueryService(pool,config,{index:()=>{
   const closed=vi.fn(async()=>{}),ordinal=seen.length;seen.push({rrfK:config.milvus.rrfK,closed});
   return {...memory,close:closed,searchKeyword:async(query,options)=>{if(ordinal===0){entered();await gate;}return memory.searchKeyword(query,options);}};
  }});
  const patch=async(rrfK:number)=>root.query(`UPDATE runtime_configuration SET "values"="values"||$1::jsonb,revision=revision+1`,[JSON.stringify({'rag.rrfK':rrfK})]);
  let first:Promise<unknown>|undefined;
  try{
   await patch(41);first=settings.run(()=>q.query(f.scope,{query:'runtimecache',mode:'keyword',topK:1,documentKey:f.note.noteId}));await start;
   await patch(73);expect((await settings.run(()=>q.query(f.scope,{query:'runtimecache',mode:'keyword',topK:1,documentKey:f.note.noteId}))).results).toHaveLength(1);
   expect(seen.map(s=>s.rrfK)).toEqual([41,73]);expect(seen[0]!.closed).not.toHaveBeenCalled();
   release();await first;expect(seen[0]!.closed).toHaveBeenCalledTimes(1);
   await settings.run(()=>q.query(f.scope,{query:'runtimecache',mode:'keyword',topK:1,documentKey:f.note.noteId}));expect(seen).toHaveLength(2);
  }finally{release();await first;await q.close();await root.query('UPDATE runtime_configuration SET "values"=$1,revision=revision+1',[JSON.stringify(original)]);}
 });
 it('keeps canonical rerank evidence and hydrates only deduplicated images of final topK on explicit request',async()=>{
  const f=await fixture(),a=randomUUID(),b=randomUUID();
  for(const id of [a,b])await root.query(`INSERT INTO resources(resource_id,user_id,file_name,mime_type,size_bytes,sha256,object_key,object_version,storage_driver,storage_bucket,status)
   VALUES($1,$2,'fixture.png','image/png',1,$3,$1,'fixture','aliyun-oss',$4,'ready')`,[id,f.scope.userId,'a'.repeat(64),imageConfig.storageAliyunOss!.bucket]);
  const first=await imageAssets.createNote(f.scope,f.workspaceId,{title:'A',parts:{raw:`imageselect ![A](asset://${a})`}},randomUUID());
  const inputBody=`imageselect ![B](asset://${b}) ![repeat](asset://${b})`;
  const second=await imageAssets.createNote(f.scope,f.workspaceId,{title:'B',parts:{raw:inputBody}},randomUUID());
  const body=second.parts.raw!.contentMarkdown;
  expect(body).toContain('<KBIMAGE');expect(body).not.toContain('![');
  await runNote(first.noteId);await runNote(second.noteId);
  const resolveImages=vi.fn(async(_scope:unknown,images:RagImageRequest[])=>new Map(images.map(image=>[ragImageKey(image),{url:`https://preview.test/${image.resourceId}`,expiresAt:'2099-01-01T00:00:00.000Z'}])));
  const rerank=vi.fn(async(_query:string,candidates:import('../../src/modules/rag/search.js').RagSearchCandidate[])=>{
   expect(candidates.every(c=>!c.content.includes('preview.test')&&!c.content.includes('playbackToken='))).toBe(true);
   return candidates.map(c=>({...c,rerankScore:c.documentKey===second.noteId?10:1}));
  });
  const q=new RagQueryService(pool,config,{index:factory,embedding:{model:'qwen3.7-text-embedding-flash',dimensions:1024,embed:async texts=>kbEmbedding(config,kbSnapshot(config,'note-hybrid','markdown')).embed(texts)},rerank:{rerank},resolveImages});
  try{
   const ids=await q.query(f.scope,{query:'imageselect',mode:'hybrid',topK:1});
   expect(ids.results[0]).toMatchObject({documentKey:second.noteId,content:body,evidence:{child:body},images:[{resourceId:b},{resourceId:b}]});
   expect(resolveImages).not.toHaveBeenCalled();expect(ids.results[0]).not.toHaveProperty('displayMarkdown');
   const links=await q.query(f.scope,{query:'imageselect',mode:'hybrid',topK:1,assetMode:'links'});
   expect(resolveImages).toHaveBeenCalledTimes(1);expect(resolveImages.mock.calls[0]![1]).toMatchObject([{sourceId:second.noteId,resourceId:b,workspaceId:f.workspaceId}]);
   expect(resolveImages.mock.calls[0]![1]).toHaveLength(1);
   expect(links.results[0]).toMatchObject({content:body,evidence:{child:body},sourceStart:0,sourceEnd:body.length});
   expect(links.results[0]!.displayMarkdown).toContain(`https://preview.test/${b}`);
   const imageSpans=links.results[0]!.images as Array<{sourceStart:number;sourceEnd:number}>;
   expect(imageSpans).toHaveLength(2);for(const span of imageSpans)expect(body.slice(span.sourceStart,span.sourceEnd)).toContain(`<KBIMAGE uuid="${b}"`);
  }finally{await q.close();}
 });
 it('never requests previews for a candidate deleted during reranking',async()=>{
  const f=await fixture(),id=randomUUID();
  await root.query(`INSERT INTO resources(resource_id,user_id,file_name,mime_type,size_bytes,sha256,object_key,object_version,storage_driver,storage_bucket,status)
   VALUES($1,$2,'fixture.png','image/png',1,$3,$1,'fixture','aliyun-oss',$4,'ready')`,[id,f.scope.userId,'a'.repeat(64),imageConfig.storageAliyunOss!.bucket]);
  const note=await imageAssets.createNote(f.scope,f.workspaceId,{title:'删除竞态',parts:{raw:`imagedelete ![图](asset://${id})`}},randomUUID());await runNote(note.noteId);
  const resolveImages=vi.fn(async()=>new Map());
  const q=new RagQueryService(pool,config,{index:factory,embedding:{model:'qwen3.7-text-embedding-flash',dimensions:1024,embed:async texts=>kbEmbedding(config,kbSnapshot(config,'note-hybrid','markdown')).embed(texts)},resolveImages,
   rerank:{rerank:async(_query,candidates)=>{await imageAssets.deleteNote(f.scope,f.workspaceId,note.noteId,note.etag,randomUUID());return candidates.map(c=>({...c,rerankScore:1}));}}});
  try{expect((await q.query(f.scope,{query:'imagedelete',mode:'hybrid',assetMode:'links',documentKey:note.noteId})).results).toEqual([]);expect(resolveImages).not.toHaveBeenCalled();}finally{await q.close();}
 });
 it('associates OCR-only chunks with their whole KBIMAGE without parsing input Markdown at query time',async()=>{
  const f=await fixture(),id=randomUUID();
  await root.query(`INSERT INTO resources(resource_id,user_id,file_name,mime_type,size_bytes,sha256,object_key,object_version,storage_driver,storage_bucket,status)
   VALUES($1,$2,'fixture.png','image/png',1,$3,$1,'fixture','aliyun-oss',$4,'ready')`,[id,f.scope.userId,'a'.repeat(64),imageConfig.storageAliyunOss!.bucket]);
  const tag=`<KBIMAGE uuid="${id}" page="1"><![CDATA[${'crossimage '.repeat(150)}]]></KBIMAGE>`;
  const body=`正文\n\n${tag}\n\n尾部`,start=body.indexOf('<KBIMAGE'),end=start+tag.length;
  const note=await imageAssets.createNote(f.scope,f.workspaceId,{title:'OCR范围',parts:{raw:body}},randomUUID());await runNote(note.noteId);
  const resolveImages=vi.fn(async(_scope:unknown,images:RagImageRequest[])=>new Map(images.map(image=>[ragImageKey(image),{url:`https://preview.test/${image.resourceId}`,expiresAt:'2099-01-01T00:00:00.000Z'}])));
  const q=new RagQueryService(pool,config,{index:factory,resolveImages});
  const parseInput=vi.spyOn(markdownInput,'inputImages').mockImplementation(()=>{throw new Error('QUERY_MUST_NOT_PARSE_INPUT_MARKDOWN');});
  try{
   const result=await q.query(f.scope,{query:'crossimage',mode:'keyword',topK:10,documentKey:note.noteId,assetMode:'links'});
   expect(result.results.length).toBeGreaterThan(1);
   expect(result.results.some(hit=>Number(hit.sourceStart)>start&&!String(hit.content).includes('<KBIMAGE'))).toBe(true);
   for(const hit of result.results){
    expect(hit.content).toBe(body.slice(Number(hit.sourceStart),Number(hit.sourceEnd)));
    expect(hit.evidence).toEqual({child:hit.content});
    expect(hit.images).toEqual([{resourceId:id,alt:'',sourceStart:start,sourceEnd:end,url:`https://preview.test/${id}`,expiresAt:'2099-01-01T00:00:00.000Z'}]);
    // A partial tag remains evidence; its image is exposed separately, never
    // repaired with invented markup or an offset into the signed view.
    expect(hit.displayMarkdown).toBe(hit.content);
   }
   expect(resolveImages).toHaveBeenCalledTimes(1);expect(resolveImages.mock.calls[0]![1]).toHaveLength(1);
   expect(parseInput).not.toHaveBeenCalled();
  }finally{parseInput.mockRestore();await q.close();}
 });
 it('initializes exactly four metadata tables with indexed associations and no physical FKs',async()=>{
  const cols=await root.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'kb_%'");
  expect(new Set(cols.rows.map(r=>r.table_name)).size).toBe(4);expect(cols.rows.some(r=>['content','embedding_text','embedding_vector'].includes(r.column_name))).toBe(false);
  expect(Number((await root.query("SELECT count(*) FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace")).rows[0].count)).toBe(0);
  for(const name of ['document_ingestion_chunks','rag_child_chunks','text_ingestion_chunks','rag_chunks','note_index_state','note_index_jobs'])expect((await root.query('SELECT to_regclass($1) name',[name])).rows[0].name).toBeNull();
 });
 it('automatically indexes real Note raw content and serves all recall modes through only the Note collection',async()=>{
  const f=await create();await runNote(f.note.noteId);const before=targets.length;
  for(const mode of ['keyword','dense','hybrid'] as const){const r=await queries.query(f.scope,{query:'MVCC',mode,documentKey:f.note.noteId});expect(r.results.length).toBeGreaterThan(0);expect(r.results[0]).toMatchObject({documentKey:f.note.noteId,part:'raw',partRevisionId:f.note.parts.raw!.partRevisionId,revisionId:f.note.noteRevisionId});}
  expect(new Set(targets.slice(before))).toEqual(new Set([config.kb.noteCollection]));
  expect((await root.query('SELECT * FROM kb_note_hybrid_chunks WHERE build_id=$1',[(await latest(f.note.noteId)).id])).rows.every(r=>r.index_status==='ready')).toBe(true);
 });
 it.each(['数据库','MVCC','B-tree 索引'])('recalls Chinese/English/mixed BM25 %s without any model calls',async query=>{
  const f=await create();await runNote(f.note.noteId);const embed=vi.fn(()=>{throw new Error('MODEL_CALLED');});
  const q=new RagQueryService(pool,{...config,rag:{...config.rag,embeddingApiKey:undefined}},{index:factory,embedding:{model:'qwen3.7-text-embedding-flash',dimensions:1024,embed},rerank:{rerank:async()=>{throw new Error('RERANK_CALLED');}}});
  try{expect((await q.query(f.scope,{query,mode:'keyword',documentKey:f.note.noteId})).results.length).toBeGreaterThan(0);expect(embed).not.toHaveBeenCalled();}finally{await q.close();}
 });
 it('uses the App search part/revision identity and preserves permission filters',async()=>{
  const f=await create();await runNote(f.note.noteId);const r=await assets.search(f.scope,f.workspaceId,{query:'MVCC',mode:'hybrid'});
  expect(r.results[0]).toMatchObject({part:'raw',revisionId:f.note.noteRevisionId,ownerRef:{id:f.note.noteId}});
  const read=await assets.notePart(f.scope,f.workspaceId,f.note.noteId,r.results[0]!.part);expect(read.partRevisionId).toBe(f.note.parts.raw!.partRevisionId);
  const other=await fixture();await expect(assets.search(other.scope,f.workspaceId,{query:'MVCC'})).rejects.toThrow();
  expect((await queries.query(other.scope,{query:'MVCC',documentKey:f.note.noteId})).results).toEqual([]);
 });
 it('requires trusted user/session scope and rejects retired credentials for the Agent contract',async()=>{
  const f=await create();await runNote(f.note.noteId);
  const api=await buildApiServer({config,ragQueryDependencies:{index:factory,embedding:{model:'qwen3.7-text-embedding-flash',dimensions:1024,embed:async t=>kbEmbedding(config,kbSnapshot(config,'note-hybrid','markdown')).embed(t)}}});
  try{
   const payload={query:'MVCC',mode:'keyword',topK:5};
   for(const headers of [{},{authorization:'Bearer '+f.bearer},{'x-huahuo-service-key':'retired-service-key'}])expect((await api.inject({method:'POST',url:'/internal/v1/rag/query',headers,payload})).statusCode).toBe(401);
   const r=await api.inject({method:'POST',url:'/internal/v1/rag/query',headers:fixtureScopeHeaders(f.bearer),payload});
   expect(r.statusCode,r.body).toBe(200);expect(r.json().data.results.some((r:{documentKey:string})=>r.documentKey===f.note.noteId)).toBe(true);
   const detail=await api.inject({method:'GET',url:`/api/v1/workspaces/${f.workspaceId}/notes/${f.note.noteId}?revisionId=${f.note.noteRevisionId}`,headers:{...fixtureScopeHeaders(f.bearer)}});
   expect(detail.statusCode,detail.body).toBe(200);expect(detail.json().data.noteRevisionId).toBe(f.note.noteRevisionId);
   const part=await api.inject({method:'GET',url:`/api/v1/workspaces/${f.workspaceId}/notes/${f.note.noteId}/parts/raw`,headers:{...fixtureScopeHeaders(f.bearer)}});
   expect(part.statusCode,part.body).toBe(200);expect(part.json().data.partRevisionId).toBe(f.note.parts.raw!.partRevisionId);
   const wrong=await api.inject({method:'GET',url:`/api/v1/workspaces/${f.workspaceId}/notes/${f.note.noteId}?revisionId=${randomUUID()}`,headers:{...fixtureScopeHeaders(f.bearer)}});expect(wrong.statusCode).toBe(409);

  }finally{await api.close();}
 });
 it('reuses unchanged physical points on local edit, hides invalid revision immediately, and retires old-only points',async()=>{
  const original='# Stable\n'+('stable MVCC 文本。'.repeat(30))+'\n\n# Edit\nchange A';const f=await create(original);const old=await runNote(f.note.noteId);
  const oldIds=(await root.query('SELECT point_id FROM kb_note_hybrid_chunks WHERE build_id=$1',[old.id])).rows.map(r=>r.point_id);
  const changed=await assets.updateNote(f.scope,f.workspaceId,f.note.noteId,{parts:{raw:original.replace('change A','change B')}},f.note.etag,randomUUID());
  expect((await queries.query(f.scope,{query:'MVCC',documentKey:f.note.noteId})).results).toEqual([]);
  const next=await runNote(f.note.noteId);const newIds=(await root.query('SELECT point_id FROM kb_note_hybrid_chunks WHERE build_id=$1',[next.id])).rows.map(r=>r.point_id);
  expect(newIds.some(id=>oldIds.includes(id))).toBe(true);expect(newIds.some(id=>!oldIds.includes(id))).toBe(true);
  expect((await queries.query(f.scope,{query:'MVCC',mode:'keyword',documentKey:f.note.noteId})).results[0]!.partRevisionId).toBe(changed.parts.raw!.partRevisionId);
  expect((await root.query('SELECT published FROM kb_note_hybrid_builds WHERE id=$1',[old.id])).rows[0].published).toBe(false);
 });
 it('deduplicates repeated source intent and never publishes a late task',async()=>{
  const f=await create('first revision');const first=await latest(f.note.noteId);
  await transactionForSchedule(f);expect((await latest(f.note.noteId)).id).toBe(first.id);
  const a=await engine.claim(first.task_id,randomUUID());await assets.updateNote(f.scope,f.workspaceId,f.note.noteId,{parts:{raw:'second revision'}},f.note.etag,randomUUID());
  await expect(jobs.execute(a!)).rejects.toThrow('KB_SOURCE_SUPERSEDED');await runNote(f.note.noteId);
  expect((await queries.query(f.scope,{query:'second',mode:'keyword',documentKey:f.note.noteId})).results.length).toBeGreaterThan(0);
 });
 it('retries partial batches by stable point ID and never exposes building rows',async()=>{
  const f=await create('# first\n'+('first 字。'.repeat(90))+'\n\n# second\n'+('second 字。'.repeat(90)));const b=await latest(f.note.noteId);const a=await engine.claim(b.task_id,randomUUID());
  const real=requireIndexKind(factory(b.snapshot),'hybrid');let writes=0;
  const flaky=new KnowledgeIndexJobs(wp,workerConfig,{...deps,index:()=>({...real,ensureReady:()=>real.ensureReady(),search:(...args)=>real.search(...args),searchKeyword:(...args)=>real.searchKeyword(...args),hybridSearch:(...args)=>real.hybridSearch(...args),deletePoints:ids=>real.deletePoints(ids),close:async()=>{},upsert:async(rows:readonly import('../../src/lib/search-index/types.js').VectorPoint[])=>{writes++;if(writes===2)throw Object.assign(new Error('batch failed'),{retryable:false});await real.upsert(rows);}})});
  try{await expect(flaky.executeBuild(b.id,a!,'note-hybrid')).rejects.toThrow();expect((await queries.query(f.scope,{query:'first',mode:'keyword',documentKey:f.note.noteId})).results).toEqual([]);await jobs.execute(a!);expect((await queries.query(f.scope,{query:'first',mode:'keyword',documentKey:f.note.noteId})).results.length).toBeGreaterThan(0);}finally{await real.close();}
 });
 it('deletion filters in-flight and future hits and cleanup protects no deleted points',async()=>{
  const f=await create();await runNote(f.note.noteId);await assets.deleteNote(f.scope,f.workspaceId,f.note.noteId,f.note.etag,randomUUID());
  expect((await queries.query(f.scope,{query:'MVCC',documentKey:f.note.noteId})).results).toEqual([]);
  const task=(await root.query("SELECT * FROM tasks WHERE user_id=$1 AND kind='kb.note-cleanup' ORDER BY created_at DESC LIMIT 1",[f.scope.userId])).rows[0];
  const a=await engine.claim(task.id,randomUUID());await jobs.executeCleanup(a!);
  expect((await root.query('SELECT count(*)::int n FROM kb_note_hybrid_builds WHERE source_id=$1 AND published',[f.note.noteId])).rows[0].n).toBe(0);
 });
 it('routes independent imported text to document keyword tables and remains usable with no embedding configuration',async()=>{
  const f=await fixture();const settings={...config,rag:{...config.rag,embeddingBaseUrl:undefined,embeddingApiKey:undefined}};
  const service=new TextIngestionService(pool,settings);const input=await service.create(f.scope,{source_type:'MANUAL_INPUT',raw_content:'  文档 keyword PostgreSQL MVCC 😀\n'},randomUUID());
  const row=(await root.query('SELECT current_task_id FROM text_ingestion_jobs WHERE id=$1',[input.id])).rows[0];const a=await engine.claim(row.current_task_id,randomUUID());
  const forbidden=()=>{throw new Error('MODEL_TOKENIZER_MUST_NOT_BE_USED');};
  await new TextIngestionJobs(wp,settings,{index:factory,embedding:forbidden,tokenizer:forbidden}).execute(a!);
  expect((await root.query('SELECT raw_content FROM text_ingestion_jobs WHERE id=$1',[input.id])).rows[0].raw_content).toBe('  文档 keyword PostgreSQL MVCC 😀\n');
  const q=new RagQueryService(pool,settings,{index:factory,embedding:{model:'qwen3.7-text-embedding-flash',dimensions:1024,embed:forbidden},rerank:{rerank:forbidden}});
  try{const before=targets.length;const r=await q.query(f.scope,{query:'MVCC',sourceType:'text',mode:'hybrid',documentKey:input.id});expect(r.mode).toBe('keyword');expect(r.results.length).toBeGreaterThan(0);expect(new Set(targets.slice(before))).toEqual(new Set([config.kb.documentCollection]));}finally{await q.close();}
 });
 it('plugs a keyword-only class backend into durable jobs and queries without Milvus or model methods',async()=>{
  class AlternateKeywordBackend implements KeywordIndex {
   readonly kind='keyword';private readonly delegate=mockKnowledgeIndex().keyword;
   async ensureReady(){await this.delegate.ensureReady();}
   async upsert(points:readonly KeywordPoint[]){await this.delegate.upsert(points);}
   async searchKeyword(query:string,options:SearchOptions){return this.delegate.searchKeyword(query,options);}
   async deletePoints(ids:readonly string[]){await this.delegate.deletePoints(ids);}
   async close(){await this.delegate.close();}
  }
  const backend=new AlternateKeywordBackend(),select=vi.fn(()=>backend),f=await fixture();
  const settings={...config,rag:{...config.rag,embeddingBaseUrl:undefined,embeddingApiKey:undefined}};
  const alternative:IndexFactory=snapshot=>knowledgeIndex(settings,snapshot,{keyword:select});
  const input=await new TextIngestionService(pool,settings).create(f.scope,{source_type:'MANUAL_INPUT',raw_content:'portable keyword needle'},randomUUID());
  const row=(await root.query('SELECT current_task_id FROM text_ingestion_jobs WHERE id=$1',[input.id])).rows[0];
  const a=await engine.claim(row.current_task_id,randomUUID());expect(a).not.toBeNull();
  const forbidden=()=>{throw new Error('KEYWORD_MUST_NOT_USE_MODEL');};
  const result=await new TextIngestionJobs(wp,settings,{index:alternative,embedding:forbidden,tokenizer:forbidden}).execute(a!);
  expect(await engine.finish(a!,result.digest,result.bytes)).toBe(true);
  const q=new RagQueryService(pool,settings,{index:alternative,embedding:{model:'unused',dimensions:1024,embed:forbidden}});
  try{
   const response=await q.query(f.scope,{query:'needle',sourceType:'text',documentKey:input.id});
   expect(response.results).toHaveLength(1);expect(response.results[0]!.content).toBe('portable keyword needle');
   expect(select).toHaveBeenCalled();expect(backend).not.toHaveProperty('hybridSearch');
  }finally{await q.close();}
 });
 it('accepts file intents without a deployment toggle and reports missing nodes at execution while manual text remains available',async()=>{
  const originalNodes=(await root.query('SELECT * FROM processing_nodes')).rows;await root.query('DELETE FROM processing_nodes');
  const f=await fixture(),api=await buildApiServer({config}),nodes=new ProcessingNodes(wp,workerConfig);
  try{
   for(const[fileName,mimeType]of [['document.txt','text/plain'],['document.md','text/markdown'],['document.csv','text/csv'],['document.pdf','application/pdf'],['document.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document']]){
    const headers={...fixtureScopeHeaders(f.bearer),'x-idempotency-key':randomUUID()};
    const result=await api.inject({method:'POST',url:'/api/v1/rag/ingestions',headers,payload:{ossUrl:'https://fixture.test/'+fileName,fileName,mimeType}});
    expect(result.statusCode,result.body).toBe(200);
    const text=await api.inject({method:'POST',url:'/api/v1/text-ingestions',headers,payload:{source_type:'FILE_UPLOAD',origin_resource_uri:'https://fixture.test/'+fileName}});
    expect(text.statusCode,text.body).toBe(200);
   }
   expect(Number((await root.query('SELECT count(*) FROM rag_ingestion_versions WHERE user_id=$1',[f.scope.userId])).rows[0].count)).toBe(5);
   expect(Number((await root.query('SELECT count(*) FROM text_ingestion_jobs WHERE created_by=$1',[f.scope.userId])).rows[0].count)).toBe(5);
   expect(Number((await root.query("SELECT count(*) FROM tasks WHERE user_id=$1 AND kind IN ('rag.document-ingest','text.ingest')",[f.scope.userId])).rows[0].count)).toBe(10);
   const execute=vi.fn();await expect(nodes.withNode('document',{requestId:randomUUID(),fingerprint:'f'.repeat(64)},execute)).rejects.toMatchObject({code:'PROCESSING_NODE_UNAVAILABLE'});expect(execute).not.toHaveBeenCalled();
   const manual=await api.inject({method:'POST',url:'/api/v1/text-ingestions',headers:{...fixtureScopeHeaders(f.bearer),'x-idempotency-key':randomUUID()},payload:{source_type:'MANUAL_INPUT',raw_content:'手动正文保持可用'}});
   expect(manual.statusCode,manual.body).toBe(200);expect(manual.json().data.raw_content).toBe('手动正文保持可用');
  }finally{await nodes.close();await api.close();for(const row of originalNodes)await root.query('INSERT INTO processing_nodes(id,config,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5)',[row.id,JSON.stringify(row.config),row.revision,row.created_at,row.updated_at]);}
 });
 it('resumes keyword indexing and TOC from persisted external canonical Markdown',async()=>{
  const f=await fixture();const settings=config;
  const repo=new RagIngestionRepository(pool,settings);
  const created=await repo.create(f.scope,{ossUrl:'https://fixture.test/document.md',fileName:'document.md',mimeType:'text/markdown'});
  const source=storageFor(config),canonical='# Document\n\nPostgreSQL MVCC 资料关键词。\n',data=Buffer.from(canonical),canonicalUri='fixture-extracted.md';
  await source.put(canonicalUri,Readable.from([data]),'text/markdown',1000);
  const sha=createHash('sha256').update(data).digest('hex');
  // The external parser already committed its output; this fixture covers indexing recovery only.
  await root.query("UPDATE rag_ingestion_versions SET canonical_content_uri=$2,raw_markdown_uri=$2,content_hash=$3,parser_provider='xberg',status='PARSED',current_stage='PARSED' WHERE id=$1",[created.documentVersionId,canonicalUri,sha]);
  const a=await engine.claim(created.jobId,randomUUID());expect(a).not.toBeNull();
  const pipeline=new RagIngestionJobs(wp,workerConfig,source,{kb:{index:factory,embedding:()=>{throw new Error('MODEL_CALLED');}}});
  try{
   await pipeline.execute(a!);
   expect((await root.query('SELECT * FROM kb_document_keyword_builds WHERE source_id=$1',[created.documentVersionId])).rows[0]).toMatchObject({published:true,status:'ready'});
   const saved=(await root.query('SELECT canonical_content_uri,content_hash,status,toc_status,toc FROM rag_ingestion_versions WHERE id=$1',[created.documentVersionId])).rows[0];
   expect(saved).toMatchObject({canonical_content_uri:canonicalUri,content_hash:sha,status:'SUCCEEDED',toc_status:'ready'});
   expect(saved.toc).toEqual(expect.arrayContaining([expect.objectContaining({title:'Document'})]));
  }finally{await pipeline.close();}
 });
 it('restores a deleted Note by recreating missing points rather than trusting retired metadata',async()=>{
  const f=await create();await runNote(f.note.noteId);await assets.deleteNote(f.scope,f.workspaceId,f.note.noteId,f.note.etag,randomUUID());
  const t=(await root.query("SELECT id FROM tasks WHERE user_id=$1 AND kind='kb.note-cleanup'",[f.scope.userId])).rows[0];
  // claim can legitimately return null until the persisted available_at is due;
  // use the same bounded readiness check as runNote instead of a non-null cast.
  const a=await vi.waitFor(async()=>{const claim=await engine.claim(t.id,randomUUID());expect(claim).toBeTruthy();return claim!;},{interval:20,timeout:3000});
  await jobs.executeCleanup(a);
  const deleted=await assets.getNote(f.scope,f.workspaceId,f.note.noteId);await assets.deleteNote(f.scope,f.workspaceId,f.note.noteId,deleted.etag,randomUUID(),true);await runNote(f.note.noteId);
  expect((await queries.query(f.scope,{query:'MVCC',mode:'keyword',documentKey:f.note.noteId})).results.length).toBeGreaterThan(0);
 });
 it('clears an empty edited body from recall immediately and schedules accurate point cleanup',async()=>{
  const f=await create();await runNote(f.note.noteId);await assets.updateNote(f.scope,f.workspaceId,f.note.noteId,{parts:{raw:'  \n'}},f.note.etag,randomUUID());
  expect((await queries.query(f.scope,{query:'MVCC',mode:'keyword',documentKey:f.note.noteId})).results).toEqual([]);
  const t=(await root.query("SELECT id FROM tasks WHERE user_id=$1 AND kind='kb.note-cleanup'",[f.scope.userId])).rows[0];expect(t).toBeTruthy();const a=await engine.claim(t.id,randomUUID());await jobs.executeCleanup(a!);
 });
 it('rechecks current revision after rerank so an in-flight hit cannot reveal superseded content',async()=>{
  const f=await create();await runNote(f.note.noteId);
  const q=new RagQueryService(pool,config,{index:factory,embedding:{model:'qwen3.7-text-embedding-flash',dimensions:1024,embed:async t=>kbEmbedding(config,kbSnapshot(config,'note-hybrid','markdown')).embed(t)},rerank:{rerank:async(_q,candidates)=>{await assets.updateNote(f.scope,f.workspaceId,f.note.noteId,{parts:{raw:'entirely replaced'}},f.note.etag,randomUUID());return candidates.map(c=>({...c,rerankScore:1}));}}});
  try{expect((await q.query(f.scope,{query:'MVCC',documentKey:f.note.noteId})).results).toEqual([]);}finally{await q.close();}
 });
 it('recovers a remote success before PG acknowledgement with the same IDs and fenced lease',async()=>{
  const f=await create();const b=await latest(f.note.noteId);const a=await engine.claim(b.task_id,randomUUID());let sabotaged=false;
  const flaky=new KnowledgeIndexJobs(wp,workerConfig,{...deps,index:snapshot=>{const real=requireIndexKind(factory(snapshot),'hybrid');return {kind:'hybrid',ensureReady:()=>real.ensureReady(),upsert:async rows=>{await real.upsert(rows);if(!sabotaged){sabotaged=true;await root.query("UPDATE tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[a!.task.id]);}},search:(...args)=>real.search(...args),searchKeyword:(...args)=>real.searchKeyword(...args),hybridSearch:(...args)=>real.hybridSearch(...args),deletePoints:ids=>real.deletePoints(ids),close:()=>real.close()};}});
  await expect(flaky.executeBuild(b.id,a!,'note-hybrid')).rejects.toThrow('KB_LEASE_LOST');
  expect((await queries.query(f.scope,{query:'MVCC',documentKey:f.note.noteId})).results).toEqual([]);
  const ids=(await root.query('SELECT point_id FROM kb_note_hybrid_chunks WHERE build_id=$1',[b.id])).rows;
  await root.query("UPDATE tasks SET state='retry_scheduled',version=version+1,lease_owner=NULL,lease_until=NULL,available_at=now() WHERE id=$1",[b.task_id]);
  await runNote(f.note.noteId);expect((await root.query('SELECT point_id FROM kb_note_hybrid_chunks WHERE build_id=$1',[b.id])).rows).toEqual(ids);
  expect((await queries.query(f.scope,{query:'MVCC',mode:'keyword',documentKey:f.note.noteId})).results.length).toBeGreaterThan(0);
 });
 it('does not let an old task publish or overwrite a replacement build with the same body revision',async()=>{
  const f=await create();const b=await latest(f.note.noteId);const a=await engine.claim(b.task_id,randomUUID());const taskId=randomUUID(),inputId=randomUUID();let replaced=false;
  const runner=new KnowledgeIndexJobs(wp,workerConfig,{...deps,index:snapshot=>{const real=requireIndexKind(factory(snapshot),'hybrid');return {kind:'hybrid',ensureReady:()=>real.ensureReady(),upsert:async rows=>{await real.upsert(rows);if(!replaced){replaced=true;await root.query('INSERT INTO task_inputs(id,user_id,workspace_id,body) VALUES($1,$2,$3,$4)',[inputId,f.scope.userId,f.workspaceId,JSON.stringify({buildId:b.id})]);await root.query("INSERT INTO tasks(trace_id,id,user_id,workspace_id,kind,queue,input_id,state) VALUES(gen_random_uuid()::text,$1,$2,$3,'kb.note-index','content',$4,'queued')",[taskId,f.scope.userId,f.workspaceId,inputId]);await root.query('UPDATE kb_note_hybrid_builds SET task_id=$2 WHERE id=$1',[b.id,taskId]);}},search:(...args)=>real.search(...args),searchKeyword:(...args)=>real.searchKeyword(...args),hybridSearch:(...args)=>real.hybridSearch(...args),deletePoints:ids=>real.deletePoints(ids),close:()=>real.close()};}});
  await expect(runner.executeBuild(b.id,a!,'note-hybrid')).rejects.toThrow('KB_SOURCE_SUPERSEDED');
  const current=(await root.query('SELECT task_id,status,published FROM kb_note_hybrid_builds WHERE id=$1',[b.id])).rows[0];expect(current).toEqual({task_id:taskId,status:'indexing',published:false});
  await runNote(f.note.noteId);expect((await queries.query(f.scope,{query:'MVCC',mode:'keyword',documentKey:f.note.noteId})).results.length).toBeGreaterThan(0);
 });
 it('preserves English keyword recall against Chinese analyzer chunks inside native hybrid RRF',async()=>{
  const f=await create('经济发展 economic 经济学数据与政策分析。');await runNote(f.note.noteId);
  const result=await queries.query(f.scope,{query:'economic',mode:'hybrid',documentKey:f.note.noteId});
  expect(result.results.length).toBeGreaterThan(0);
  if(process.env.TEST_MILVUS_ADDRESS)expect(Number(result.results[0]!.rrfScore)).toBeGreaterThan(1/61+0.001);
 });
 it('real Milvus schema contains no dense field in document collection, while note uses FP16/1024',async()=>{
  if(!process.env.TEST_MILVUS_ADDRESS)return;
  const c=createMilvusClient(config.milvus);
  try{await c.connectPromise;const doc=await c.describeCollection({collection_name:config.kb.documentCollection});expect(doc.schema.fields.some(f=>f.name==='dense_vector')).toBe(false);const note=await c.describeCollection({collection_name:config.kb.noteCollection});const dense=note.schema.fields.find(f=>f.name==='dense_vector')!;expect([DataType.Float16Vector,'Float16Vector']).toContain(dense.data_type);expect(dense.type_params.find(p=>p.key==='dim')!.value).toBe('1024');}finally{await c.closeConnection();}
 });
});
async function transactionForSchedule(f:Awaited<ReturnType<typeof create>>){const tx=await pool.connect();try{await tx.query('BEGIN');await notes.schedule(tx,f.scope,f.workspaceId,f.note.noteId);await tx.query('COMMIT');}finally{tx.release();}}
