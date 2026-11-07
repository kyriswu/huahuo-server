import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { loadConfig } from '../../src/config/config.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { RagIngestionRepository } from '../../src/modules/rag/repository.js';
import { RagIngestionJobs } from '../../src/modules/rag/jobs.js';
import { TaskEngine } from '../../src/modules/tasks/engine.js';
import { storageFor } from '../../src/modules/storage/port.js';
import { buildApiServer } from '../../src/apps/api-server.js';
import { insertFixtureUser, insertFixtureSession, testJwtEnv } from './jwt-fixture.js';
import type { RagQueryDependencies } from '../../src/modules/rag/query-service.js';
import { analyzeDocumentStructure } from '../../src/lib/document-processing/structure.js';
import { DeterministicEmbeddingClient } from '../../src/modules/rag/adapters/embedding.js';
import type { TocItem } from '../../src/lib/document-processing/types.js';
import type pg from 'pg';
import type { ParsedDocument } from '../../src/modules/rag/types.js';
import { MockMineruParser } from '../../src/modules/rag/adapters/mineru.js';

const migrationUrl=process.env.TEST_DATABASE_MIGRATION_URL;
if(!migrationUrl)throw new Error('TEST_DB_REQUIRED');
const root=poolFor(loadConfig('migrate',{...process.env,APP_ENV:'test',DATABASE_URL:migrationUrl}));
const config=loadConfig('worker',{...process.env,APP_ENV:'test',ALLOW_MOCK_PROVIDERS:'true',RAG_PROVIDER_MODE:'mock',RAG_SOURCE_ALLOWED_HOSTS:'127.0.0.1',DATABASE_URL:process.env.TEST_DATABASE_WORKER_URL,STORAGE_DRIVER:'local'});
const pool=poolFor(config);
const apiConfig=loadConfig('api-server',{...process.env,...testJwtEnv,HUAHUO_AGENT_TO_SERVER_API_KEY:'a'.repeat(43),HUAHUO_SERVER_TO_AGENT_API_KEY:'b'.repeat(43),APP_ENV:'test',ALLOW_MOCK_PROVIDERS:'true',RAG_PROVIDER_MODE:'mock',RAG_SOURCE_ALLOWED_HOSTS:'127.0.0.1',DATABASE_URL:process.env.TEST_DATABASE_API_URL,APP_TOKEN_SECRET:'rag-api-test-secret-'.repeat(2),APP_PUBLIC_BASE_URL:'http://rag.test'});
const apiPool=poolFor(apiConfig);
// Distinct paragraphs exercise preserved source offsets and document identity.
const structuredMarkdown='# 第一章\n\n'+Array.from({length:40},(_,index)=>`第${index}段：${'结构化段落内容。'.repeat(20)}`).join('\n\n');
const manualRaw='  # 手动文本\r\n\r\n重复段落😀。\r\n重复段落😀。  \r\n';
const fileChild='## 子章节😀\r\n\r\n保留这一段原文。  \r\n\r\n';
const fileParent='# 第一章\r\n\r\n'+'知识库😀。'.repeat(520)+'\r\n\r\n'+fileChild;
const filePreamble='前言😀\r\n\r\n';
const fileMarkdown=filePreamble+fileParent+'# 第二章\r\n\r\n继续阅读。';
const imageBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=','base64');
function assetDocument():ParsedDocument {
 const markdown='# 图片诊断\n\n![first](images/first.png)\n\n![second](images/second.png)\n\n![missing](images/missing.png)';
 return {
  source:{fileName:'diagnostics.pdf',mimeType:'application/pdf',sha256:createHash('sha256').update(markdown).digest('hex')},
  blocks:[],markdown,rawMarkdown:markdown,parserProvider:'mock-mineru',parserVersion:'mock-mineru-v1',
  artifacts:{
   assets:['first','second','orphan'].map(name=>({path:`images/${name}.png`,bytes:imageBytes,mimeType:'image/png',assetType:'image',sha256:createHash('sha256').update(imageBytes).digest('hex')})),
   contentListV2:[{type:'image',image_source:{path:'images/first.png'},caption:'绑定图片说明'}],
   model:[{image_path:'images/first.png',ocr_text:'已绑定图中文字'},{page_index:2,ocr_text:'未绑定文字甲😀'},{page_index:2,ocr_text:'未绑定文字乙'}],
  },
 };
}
async function storedText(storage:ReturnType<typeof storageFor>,key:string){const chunks:Buffer[]=[];for await(const chunk of await storage.read(key))chunks.push(Buffer.from(chunk));return Buffer.concat(chunks).toString('utf8');}
let sourceRequests=0;
let storageRoot:string;let server:ReturnType<typeof createServer>;let sourceUrl:string;
async function fixture(){
 const userId=await insertFixtureUser(root),sessionId=randomUUID(),workspaceId=randomUUID();
 const bearer=await insertFixtureSession(root,userId,sessionId,'rag-fixture');
 await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'rag',true,$3)",[workspaceId,userId,randomUUID()]);
 return {userId,sessionId,workspaceId,bearer,traceId:randomUUID()};
}
describe('OSS URL RAG ingestion',()=>{
 beforeAll(async()=>{
  await migrate(loadConfig('migrate',{...process.env,APP_ENV:'test',DATABASE_URL:migrationUrl}));
  storageRoot=await mkdtemp(`${tmpdir()}/huahuo-rag-`);config.storageLocalRoot=storageRoot;apiConfig.storageLocalRoot=storageRoot;
  server=createServer((req,res)=>{
   sourceRequests+=1;
   if(req.url?.includes('structured')){
    const markdown=req.url.includes('toc-structured')?fileMarkdown:structuredMarkdown;
    res.writeHead(200,{'content-type':'application/pdf'});res.end(Buffer.from(`%PDF-1.4\n${markdown}\n%%EOF`));
   }else{
    res.writeHead(200,{'content-type':'text/markdown'});
    res.end(req.url?.includes('raw')?manualRaw:'# RAG 标题\n\n第一段内容。第二段内容。');
   }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
  const address=server.address();if(!address||typeof address==='string')throw new Error('SERVER_ADDRESS');
  sourceUrl=`http://127.0.0.1:${address.port}/sample.md`;
 });
 afterAll(async()=>{server?.close();await rm(storageRoot,{recursive:true,force:true});await Promise.all([pool.end(),apiPool.end(),root.end()]);});
 it('creates an idempotent job and completes plain-text child indexing with mock providers',async()=>{
  const user=await fixture();const repo=new RagIngestionRepository(apiPool,apiConfig.rag,'test',apiConfig.milvus.collection,apiConfig);
  const scope={userId:user.userId,sessionId:user.sessionId,traceId:user.traceId};
  const first=await repo.create(scope,{ossUrl:sourceUrl,fileName:'sample.md',mimeType:'text/markdown'});
  const replay=await repo.create(scope,{ossUrl:sourceUrl,fileName:'sample.md',mimeType:'text/markdown'});
  expect(replay).toMatchObject({jobId:first.jobId,documentVersionId:first.documentVersionId,reused:true});
  const jobs=new RagIngestionJobs(pool,config,storageFor(config));const engine=new TaskEngine(pool,30_000,undefined,undefined,undefined,jobs);
  const attempt=await engine.claim(first.jobId,randomUUID());expect(attempt).toBeTruthy();expect(await engine.execute(attempt!)).toBe(true);
  const version=(await root.query('SELECT status,current_stage,mode,child_count,embedding_status,index_status,source_sha256,canonical_content_uri FROM rag_ingestion_versions WHERE id=$1',[first.documentVersionId])).rows[0];
  expect(version).toMatchObject({status:'SUCCEEDED',current_stage:'SUCCEEDED',mode:'plain_text',embedding_status:'ready',index_status:'ready'});
  expect(Number(version.child_count)).toBeGreaterThan(0);expect(version.source_sha256).toMatch(/^[a-f0-9]{64}$/);
  const child=(await root.query('SELECT embedding_status,index_status,parent_id,milvus_id FROM rag_child_chunks WHERE version_id=$1',[first.documentVersionId])).rows;
  expect(child.length).toBe(Number(version.child_count));
  expect(child.every(row=>row.embedding_status==='ready'&&row.index_status==='ready'&&row.parent_id===first.documentVersionId)).toBe(true);
  expect((await repo.detail(scope,first.jobId)).status).toBe('SUCCEEDED');
 });
 it('stores document diagnostics once while retaining every asset and unresolved OCR across replay',async()=>{
  const user=await fixture();
  const repo=new RagIngestionRepository(apiPool,apiConfig.rag,'test',apiConfig.milvus.collection,apiConfig);
  const created=await repo.create({userId:user.userId,sessionId:user.sessionId,traceId:user.traceId},{ossUrl:sourceUrl.replace('sample.md','asset-structured.pdf'),fileName:'diagnostics.pdf',mimeType:'application/pdf'});
  const parse=vi.spyOn(MockMineruParser.prototype,'parse').mockResolvedValue(assetDocument());
  const storage=storageFor(config),jobs=new RagIngestionJobs(pool,config,storage);
  const put=vi.spyOn(storage,'put');
  try{
   const engine=new TaskEngine(pool,30_000,undefined,undefined,undefined,jobs);
   const attempt=await engine.claim(created.jobId,randomUUID());expect(attempt).toBeTruthy();expect(await engine.execute(attempt!)).toBe(true);
   const version=(await root.query('SELECT asset_manifest_uri,canonical_content_uri FROM rag_ingestion_versions WHERE id=$1',[created.documentVersionId])).rows[0]!;
   const manifestText=await storedText(storage,version.asset_manifest_uri);
   const manifest=JSON.parse(manifestText);
   expect(manifest.assets).toHaveLength(3);
   expect(manifest.diagnostics).toEqual({missingRefs:['images/missing.png'],orphanAssets:['images/orphan.png'],duplicatePaths:[],unresolvedOcr:[{text:'未绑定文字甲😀',pageNo:3},{text:'未绑定文字乙',pageNo:3}]});
   expect(manifestText.split('未绑定文字甲😀')).toHaveLength(2);
   const rows=(await root.query('SELECT id,source_asset_key,object_key,sha256,ocr_text,metadata FROM rag_document_assets WHERE version_id=$1 ORDER BY source_asset_key',[created.documentVersionId])).rows;
   expect(rows).toHaveLength(3);expect(rows[0]).toMatchObject({source_asset_key:'images/first.png',ocr_text:'已绑定图中文字'});
   // Source-path identity and blob deduplication are separate: equal bytes must retain
   // all bindings (including the orphan), while sharing one immutable OSS object.
   expect(new Set(rows.map(row=>row.id)).size).toBe(3);
   expect(new Set(rows.map(row=>row.source_asset_key)).size).toBe(3);
   expect(new Set(rows.map(row=>row.object_key)).size).toBe(1);
   expect(new Set(rows.map(row=>row.sha256)).size).toBe(1);
   expect(put.mock.calls.filter(call=>call[2]==='image/png')).toHaveLength(1);
   for(const row of rows){expect(row.metadata).not.toHaveProperty('unresolvedOcr');expect(row.metadata).not.toHaveProperty('missingRefs');expect(row.metadata).not.toHaveProperty('orphanAssets');}
   const canonical=await storedText(storage,version.canonical_content_uri);
   for(const text of ['asset://images/first.png','asset://images/second.png','已绑定图中文字','未绑定文字甲😀','未绑定文字乙'])expect(canonical).toContain(text);
   await jobs.execute(attempt!);
   expect(parse).toHaveBeenCalledOnce();
   expect(await storedText(storage,version.asset_manifest_uri)).toBe(manifestText);
   expect((await root.query('SELECT count(*)::int n FROM rag_document_assets WHERE version_id=$1',[created.documentVersionId])).rows[0]!.n).toBe(3);
   expect(put.mock.calls.filter(call=>call[2]==='image/png')).toHaveLength(1);
  }finally{put.mockRestore();parse.mockRestore();await jobs.close();}
 });
 it('does not publish the canonical checkpoint when asset persistence fails and restores the same diagnostics on retry',async()=>{
  const user=await fixture();
  const repo=new RagIngestionRepository(apiPool,apiConfig.rag,'test',apiConfig.milvus.collection,apiConfig);
  const created=await repo.create({userId:user.userId,sessionId:user.sessionId,traceId:user.traceId},{ossUrl:sourceUrl.replace('sample.md','retry-asset-structured.pdf'),fileName:'diagnostics.pdf',mimeType:'application/pdf'});
  const parse=vi.spyOn(MockMineruParser.prototype,'parse').mockResolvedValue(assetDocument());
  let assetInserts=0,failed=false;
  const faultPool={
   query:pool.query.bind(pool),
   async connect(){
    const client=await pool.connect();
    return new Proxy(client,{get(target,key){
     if(key==='query')return async(sql:string,args?:unknown[])=>{
      if(sql.startsWith('INSERT INTO rag_document_assets')&&++assetInserts===2&&!failed){failed=true;throw new Error('explicit asset persistence fixture failure');}
      return target.query(sql,args);
     };
     const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
   },
  } as unknown as pg.Pool;
  const storage=storageFor(config),jobs=new RagIngestionJobs(faultPool,config,storage);
  try{
   const engine=new TaskEngine(pool,30_000),attempt=await engine.claim(created.jobId,randomUUID());expect(attempt).toBeTruthy();
   await expect(jobs.execute(attempt!)).rejects.toMatchObject({code:'RAG_INGEST_FAILED'});
   expect((await root.query('SELECT status,canonical_content_uri,asset_manifest_uri FROM rag_ingestion_versions WHERE id=$1',[created.documentVersionId])).rows[0]).toMatchObject({status:'FAILED',canonical_content_uri:null,asset_manifest_uri:null});
   expect((await root.query('SELECT count(*)::int n FROM rag_document_assets WHERE version_id=$1',[created.documentVersionId])).rows[0]!.n).toBe(0);
   await jobs.execute(attempt!);
   expect(parse).toHaveBeenCalledTimes(2);
   const version=(await root.query('SELECT status,canonical_content_uri,asset_manifest_uri FROM rag_ingestion_versions WHERE id=$1',[created.documentVersionId])).rows[0]!;
   expect(version.status).toBe('SUCCEEDED');
   expect((await root.query('SELECT count(*)::int n FROM rag_document_assets WHERE version_id=$1',[created.documentVersionId])).rows[0]!.n).toBe(3);
   const manifest=JSON.parse(await storedText(storage,version.asset_manifest_uri));
   expect(manifest.diagnostics.unresolvedOcr).toEqual([{text:'未绑定文字甲😀',pageNo:3},{text:'未绑定文字乙',pageNo:3}]);
   expect(await storedText(storage,version.canonical_content_uri)).toContain('未绑定文字甲😀');
  }finally{parse.mockRestore();await jobs.close();}
 });
 it('fails closed before downloading when a file task has no frozen processing snapshot',async()=>{
  const user=await fixture();const repo=new RagIngestionRepository(apiPool,apiConfig.rag,'test',apiConfig.milvus.collection,apiConfig);
  const created=await repo.create({userId:user.userId,sessionId:user.sessionId,traceId:user.traceId},{ossUrl:sourceUrl,fileName:'sample.md',mimeType:'text/markdown'});
  await root.query('UPDATE rag_ingestion_versions SET processing_snapshot=NULL WHERE id=$1',[created.documentVersionId]);
  const jobs=new RagIngestionJobs(pool,config,storageFor(config));const engine=new TaskEngine(pool,30_000);
  const attempt=await engine.claim(created.jobId,randomUUID());expect(attempt).toBeTruthy();
  const requests=sourceRequests;
  await expect(jobs.execute(attempt!)).rejects.toMatchObject({code:'RAG_PROFILE_UNAVAILABLE'});
  expect(sourceRequests).toBe(requests);
  expect((await root.query('SELECT status,error_code,processing_snapshot FROM rag_ingestion_versions WHERE id=$1',[created.documentVersionId])).rows[0]).toMatchObject({status:'FAILED',error_code:'RAG_PROFILE_UNAVAILABLE',processing_snapshot:null});
  expect((await root.query('SELECT count(*)::int n FROM rag_child_chunks WHERE version_id=$1',[created.documentVersionId])).rows[0].n).toBe(0);
 });
 it('exposes the scoped asynchronous HTTP entrypoint without Note or Resource IDs',async()=>{const user=await fixture();const app=await buildApiServer({config:apiConfig});try{const headers={authorization:`Bearer ${user.bearer}`,'x-idempotency-key':randomUUID()};const created=await app.inject({method:'POST',url:'/api/v1/rag/ingestions',headers,payload:{ossUrl:sourceUrl,fileName:'sample.md',mimeType:'text/markdown'}});expect(created.statusCode,created.body).toBe(200);expect(created.json().data).toMatchObject({status:'RECEIVED',reused:false});const jobId=created.json().data.jobId;const read=await app.inject({method:'GET',url:`/api/v1/rag/ingestions/${jobId}`,headers:{authorization:headers.authorization}});expect(read.statusCode,read.body).toBe(200);expect(read.json().data).toMatchObject({jobId,status:'RECEIVED',mode:'plain_text'});}finally{await app.close();}});
 it('builds the Markdown TOC for a direct text import and replays without reparsing',async()=>{
  const user=await fixture();const repo=new RagIngestionRepository(apiPool,apiConfig.rag,'test',apiConfig.milvus.collection,apiConfig);
  const scope={userId:user.userId,sessionId:user.sessionId,traceId:user.traceId};
  const created=await repo.create(scope,{ossUrl:sourceUrl.replace('sample.md','raw.md'),fileName:'raw.md',mimeType:'text/markdown'});
  const storage=storageFor(config);const jobs=new RagIngestionJobs(pool,config,storage);const engine=new TaskEngine(pool,30_000,undefined,undefined,undefined,jobs);
  const attempt=await engine.claim(created.jobId,randomUUID());expect(attempt).toBeTruthy();expect(await engine.execute(attempt!)).toBe(true);
  const version=(await root.query<{canonical_content:string;canonical_content_uri:string;toc_status:string;content_hash:string}>('SELECT canonical_content,canonical_content_uri,toc_status,content_hash FROM rag_ingestion_versions WHERE id=$1',[created.documentVersionId])).rows[0]!;
  expect(version).toMatchObject({canonical_content:manualRaw,toc_status:'ready',content_hash:createHash('sha256').update(manualRaw).digest('hex')});
  const detail=await repo.detail(scope,created.jobId);
  expect(detail.toc).toMatchObject([{kind:'heading',title:'手动文本'}]);
  await expect(repo.section(scope,created.jobId,detail.toc![0]!.sectionId,storage)).resolves.toMatchObject({format:'markdown',content:manualRaw});
  const parts:Buffer[]=[];for await(const part of await storage.read(version.canonical_content_uri))parts.push(Buffer.from(part));expect(Buffer.concat(parts).toString('utf8')).toBe(manualRaw);
  const query='SELECT id,chunk_key,content,char_start,char_end,parent_id,source_type,source_revision FROM rag_child_chunks WHERE version_id=$1 ORDER BY ordinal';
  const children=(await root.query<{id:string;chunk_key:string;content:string;char_start:number;char_end:number;parent_id:string;source_type:string;source_revision:string}>(query,[created.documentVersionId])).rows;
  expect(children).toHaveLength(1);expect(children[0]).toMatchObject({content:manualRaw,parent_id:created.documentVersionId,source_type:'file',source_revision:version.content_hash});
  for(const child of children)expect(manualRaw.slice(child.char_start,child.char_end)).toBe(child.content);
  const requests=sourceRequests;await jobs.execute(attempt!);expect(sourceRequests).toBe(requests);
  expect((await root.query(query,[created.documentVersionId])).rows).toEqual(children);
  await jobs.close();
 });
 it('keeps plain text readable through a single body entry',async()=>{
  const user=await fixture();
  const repo=new RagIngestionRepository(apiPool,apiConfig.rag,'test',apiConfig.milvus.collection,apiConfig);
  const scope={userId:user.userId,sessionId:user.sessionId,traceId:user.traceId};
  const created=await repo.create(scope,{ossUrl:sourceUrl.replace('sample.md','raw.txt'),fileName:'raw.txt',mimeType:'text/plain'});
  const storage=storageFor(config);
  const jobs=new RagIngestionJobs(pool,config,storage);
  const engine=new TaskEngine(pool,30_000,undefined,undefined,undefined,jobs);
  try{
   const attempt=await engine.claim(created.jobId,randomUUID());expect(attempt).toBeTruthy();expect(await engine.execute(attempt!)).toBe(true);
   expect(await repo.detail(scope,created.jobId)).toMatchObject({tocStatus:'ready',toc:[{sectionId:'section-body',kind:'body',sourceStart:0,sourceEnd:manualRaw.length}]});
   await expect(repo.section(scope,created.jobId,'section-body',storage)).resolves.toMatchObject({format:'text',content:manualRaw});
  }finally{await jobs.close();}
 });
 it('reads exact UTF-8 ranges for nested file sections and enforces the 2000-character cap',async()=>{
  const user=await fixture(),foreign=await fixture();
  const app=await buildApiServer({config:{...apiConfig,rag:{...apiConfig.rag,childTargetTokens:2800,childMaxTokens:3200}}});
  const jobs=new RagIngestionJobs(pool,config,storageFor(config));
  const engine=new TaskEngine(pool,30_000,undefined,undefined,undefined,jobs);
  const auth={authorization:`Bearer ${user.bearer}`};
  try{
   const accepted=await app.inject({
    method:'POST',url:'/api/v1/rag/ingestions',headers:auth,
    payload:{ossUrl:sourceUrl.replace('sample.md','toc-structured.pdf'),fileName:'chapter.pdf',mimeType:'application/pdf'},
   });
   expect(accepted.statusCode,accepted.body).toBe(200);
   const {jobId,documentVersionId}=accepted.json().data;
   const base=`/api/v1/rag/ingestions/${jobId}`;
   expect((await app.inject({url:`${base}/sections/section-preamble`,headers:auth})).statusCode).toBe(409);
   const attempt=await engine.claim(jobId,randomUUID());expect(attempt).toBeTruthy();expect(await engine.execute(attempt!)).toBe(true);
   const detail=await app.inject({url:base,headers:auth});expect(detail.statusCode,detail.body).toBe(200);
   const {toc}=detail.json().data;
   expect(detail.json().data).toMatchObject({documentVersionId,tocStatus:'ready',offsetUnit:'utf16'});
   expect(toc[0]).toMatchObject({kind:'preamble',sourceStart:0,sourceEnd:filePreamble.length});
   expect(toc[1]).not.toHaveProperty('byteStart');
   for(const [section,content] of [[toc[0],filePreamble],[toc[1],fileParent],[toc[1].children[0],fileChild]]){
    const read=await app.inject({url:`${base}/sections/${section.sectionId}`,headers:auth});expect(read.statusCode,read.body).toBe(200);
    expect(read.json().data).toMatchObject({sectionId:section.sectionId,documentVersion:documentVersionId,sourceStart:section.sourceStart,sourceEnd:section.sourceEnd,offsetUnit:'utf16',format:'markdown',content});
   }
   const chunks=(await root.query('SELECT content,char_start,char_end,char_count FROM rag_child_chunks WHERE version_id=$1 ORDER BY ordinal',[documentVersionId])).rows;
   expect(chunks.filter(chunk=>chunk.char_start>=filePreamble.length&&chunk.char_end<=filePreamble.length+fileParent.length-fileChild.length).length).toBeGreaterThan(1);
   expect(Math.max(...chunks.map(chunk=>chunk.char_count))).toBeGreaterThan(1800);
   for(const chunk of chunks){
    expect(Array.from(chunk.content).length).toBe(chunk.char_count);
    expect(chunk.char_count).toBeLessThanOrEqual(2000);
    expect(chunk.content).toBe(fileMarkdown.slice(chunk.char_start,chunk.char_end));
   }
   const sectionUrl=`${base}/sections/${toc[1].children[0].sectionId}`;
   expect((await app.inject({url:sectionUrl,headers:{authorization:`Bearer ${foreign.bearer}`}})).statusCode).toBe(404);
   const deleted=await app.inject({method:'POST',url:`${base}/delete`,headers:auth,payload:{}});expect(deleted.statusCode,deleted.body).toBe(200);
   expect((await app.inject({url:sectionUrl,headers:auth})).statusCode).toBe(404);
  }finally{await app.close();await jobs.close();}
 });
 it('continues indexing without failed structure hints and retries only TOC after indexing succeeded',async()=>{
  const user=await fixture();const repo=new RagIngestionRepository(apiPool,apiConfig.rag,'test',apiConfig.milvus.collection,apiConfig);
  const scope={userId:user.userId,sessionId:user.sessionId,traceId:user.traceId};
  const created=await repo.create(scope,{ossUrl:sourceUrl.replace('sample.md','structured.pdf'),fileName:'structured.pdf',mimeType:'application/pdf'});
  const analyze=vi.fn<typeof analyzeDocumentStructure>().mockRejectedValueOnce(new Error('explicit structure fixture failure')).mockImplementation(analyzeDocumentStructure);
  const embed=vi.spyOn(DeterministicEmbeddingClient.prototype,'embed');
  const jobs=new RagIngestionJobs(pool,config,storageFor(config),{analyze});
  try{
   const engine=new TaskEngine(pool,30_000,undefined,undefined,undefined,jobs);const attempt=await engine.claim(created.jobId,randomUUID());
   expect(attempt).toBeTruthy();expect(await engine.execute(attempt!)).toBe(true);
   const readVersion=async()=>(await root.query('SELECT status,toc_status,toc,embedding_status,index_status FROM rag_ingestion_versions WHERE id=$1',[created.documentVersionId])).rows[0];
   const failedToc=await readVersion();expect(failedToc).toMatchObject({status:'SUCCEEDED',toc_status:'failed',embedding_status:'ready',index_status:'ready'});
   const query='SELECT id,chunk_key,embedding_status,index_status,metadata,updated_at FROM rag_child_chunks WHERE version_id=$1 ORDER BY ordinal';
   const before=(await root.query(query,[created.documentVersionId])).rows;expect(before.length).toBeGreaterThan(1);expect(before.every(row=>row.metadata.structureHintsUsed===false)).toBe(true);
   const requests=sourceRequests,calls=embed.mock.calls.length;
   const retry=await repo.action(scope,created.jobId,'retry-toc');
   const retryAttempt=await engine.claim(retry.jobId,randomUUID());expect(retryAttempt).toBeTruthy();expect(await engine.execute(retryAttempt!)).toBe(true);
   const repaired=await readVersion();expect(repaired).toMatchObject({status:'SUCCEEDED',toc_status:'ready',embedding_status:'ready',index_status:'ready'});
   expect(repaired.toc).toHaveLength(1);expect(analyze).toHaveBeenCalledTimes(2);
   expect(embed).toHaveBeenCalledTimes(calls);expect(sourceRequests).toBe(requests);
   expect((await root.query(query,[created.documentVersionId])).rows).toEqual(before);
  }finally{embed.mockRestore();await jobs.close();}
 });
 it('keeps successful chunks when TOC persistence fails and repairs only the TOC write',async()=>{
  const user=await fixture();const repo=new RagIngestionRepository(apiPool,apiConfig.rag,'test',apiConfig.milvus.collection,apiConfig);
  const scope={userId:user.userId,sessionId:user.sessionId,traceId:user.traceId};
  const created=await repo.create(scope,{ossUrl:sourceUrl.replace('sample.md','structured.pdf'),fileName:'structured.pdf',mimeType:'application/pdf'});
  const saveToc=vi.fn<(id:string,toc:TocItem[])=>Promise<void>>().mockRejectedValueOnce(new Error('explicit TOC repository failure')).mockImplementation(async(id,toc)=>{
   await root.query("UPDATE rag_ingestion_versions SET toc=$2::jsonb,toc_status='ready',toc_error=NULL WHERE id=$1",[id,JSON.stringify(toc)]);
  });
  const embed=vi.spyOn(DeterministicEmbeddingClient.prototype,'embed');const jobs=new RagIngestionJobs(pool,config,storageFor(config),{saveToc});
  try{
   const engine=new TaskEngine(pool,30_000,undefined,undefined,undefined,jobs);const attempt=await engine.claim(created.jobId,randomUUID());
   expect(attempt).toBeTruthy();expect(await engine.execute(attempt!)).toBe(true);
   const read=async()=>(await root.query('SELECT status,toc_status,toc_error,toc,embedding_status,index_status,processing_info FROM rag_ingestion_versions WHERE id=$1',[created.documentVersionId])).rows[0];
   expect(await read()).toMatchObject({status:'SUCCEEDED',toc_status:'failed',toc_error:'TOC_SAVE_FAILED',embedding_status:'ready',index_status:'ready',processing_info:{structureHintsUsed:true}});
   const query='SELECT id,chunk_key,metadata,embedding_status,index_status,updated_at FROM rag_child_chunks WHERE version_id=$1 ORDER BY ordinal';
   const before=(await root.query(query,[created.documentVersionId])).rows;expect(before.length).toBeGreaterThan(1);
   const calls=embed.mock.calls.length,requests=sourceRequests;
   await jobs.execute(attempt!);
   const repaired=await read();expect(repaired).toMatchObject({status:'SUCCEEDED',toc_status:'ready',toc_error:null,embedding_status:'ready',index_status:'ready'});
   expect(repaired.toc).toHaveLength(1);expect(saveToc).toHaveBeenCalledTimes(2);
   expect(embed).toHaveBeenCalledTimes(calls);expect(sourceRequests).toBe(requests);
   expect((await root.query(query,[created.documentVersionId])).rows).toEqual(before);
  }finally{embed.mockRestore();await jobs.close();}
 });
 it('runs structured Mock MinerU with document TOC and serves every hybrid route without chapter backtracking',async()=>{
  const user=await fixture();
  const repo=new RagIngestionRepository(apiPool,apiConfig.rag,'test',apiConfig.milvus.collection,apiConfig);
  const scope={userId:user.userId,sessionId:user.sessionId,traceId:user.traceId};
  const created=await repo.create(scope,{ossUrl:sourceUrl.replace('sample.md','structured.pdf'),fileName:'structured.pdf',mimeType:'application/pdf'});
  const jobs=new RagIngestionJobs(pool,config,storageFor(config));
  const engine=new TaskEngine(pool,30_000,undefined,undefined,undefined,jobs);
  const attempt=await engine.claim(created.jobId,randomUUID());
  expect(attempt).toBeTruthy();expect(await engine.execute(attempt!)).toBe(true);
  const version=(await root.query<{status:string;mode:string;child_count:number;document_key:string;embedding_profile:string;index_build_id:string;content_hash:string;toc:unknown[];toc_status:string;canonical_content_uri:string}>(
   'SELECT status,mode,child_count,document_key,embedding_profile,index_build_id,content_hash,toc,toc_status,canonical_content_uri FROM rag_ingestion_versions WHERE id=$1',[created.documentVersionId],
  )).rows[0]!;
  expect(version).toMatchObject({status:'SUCCEEDED',mode:'structured_document',toc_status:'ready'});
  expect(version.toc).toHaveLength(1);expect(Number(version.child_count)).toBeGreaterThan(1);
  const contentParts:Buffer[]=[];for await(const part of await storageFor(config).read(version.canonical_content_uri))contentParts.push(Buffer.from(part));
  const canonical=Buffer.concat(contentParts).toString('utf8');expect(canonical).toBe(structuredMarkdown);
  const children=(await root.query<{chunk_key:string;content:string;ordinal:number;parent_id:string;source_type:string;source_revision:string;char_start:number;char_end:number}>(
   `SELECT c.chunk_key,c.content,c.ordinal,c.parent_id,c.source_type,c.source_revision,c.char_start,c.char_end
      FROM rag_child_chunks c
     WHERE c.version_id=$1 ORDER BY c.ordinal`,[created.documentVersionId],
  )).rows;
  expect(children.every(row=>row.parent_id===created.documentVersionId&&row.source_type==='file'&&row.source_revision===version.content_hash)).toBe(true);
  for(const child of children)expect(canonical.slice(child.char_start,child.char_end)).toBe(child.content);
  expect(Number(children.at(-1)?.char_end)).toBeGreaterThan(Number(children[0]?.char_end));
  const siblings=children.slice(0,2);
  expect(siblings).toHaveLength(2);
  const [first,second]=siblings;
  if(!first||!second)throw new Error('STRUCTURED_CHUNK_FIXTURE_MISSING');
  const nativeScores=[0.0317,0.0241];
  type VectorIndex=NonNullable<RagQueryDependencies['milvus']>;
  const milvus={
   ensureReady:vi.fn<VectorIndex['ensureReady']>().mockResolvedValue(undefined),
   close:vi.fn<VectorIndex['close']>().mockResolvedValue(undefined),
   search:vi.fn<VectorIndex['search']>().mockRejectedValue(new Error('Hybrid must not request a separate dense list')),
   searchKeyword:vi.fn<VectorIndex['searchKeyword']>().mockRejectedValue(new Error('Hybrid must not request a separate keyword list')),
   hybridSearch:vi.fn<VectorIndex['hybridSearch']>().mockResolvedValue([
    ...siblings.map((child,index)=>({chunkKey:child.chunk_key,score:nativeScores[index]!,state:'ready',text:'untrusted index text'})),
    {chunkKey:first.chunk_key,score:0.001,state:'ready',text:'duplicate index text'},
   ]),
  };
  const vector=Array.from({length:apiConfig.rag.embeddingDimensions},()=>0.25);
  const embedding={model:'explicit-query-embedding-mock',dimensions:vector.length,embed:vi.fn<NonNullable<RagQueryDependencies['embedding']>['embed']>().mockResolvedValue([vector])};
  const rerank=vi.fn<NonNullable<RagQueryDependencies['rerank']>['rerank']>().mockImplementation(async(_query,candidates)=>
   [...candidates].reverse().map((candidate,index)=>({...candidate,rerankScore:0.95-index*0.1})),
  );
  const app=await buildApiServer({config:apiConfig,ragQueryDependencies:{milvus,embedding,rerank:{rerank}}});
  const payload={query:'结构化段落内容',mode:'hybrid',topK:5,documentKey:version.document_key};
  try{
   const routes=['/api/v1/rag/query','/api/v1/huahuo_rag/query','/internal/v1/rag/query'];
   for(const url of routes){
    const headers={authorization:`Bearer ${user.bearer}`,...(url.startsWith('/internal/')?{'x-huahuo-service-key':'a'.repeat(43)}:{})};
    const response=await app.inject({method:'POST',url,headers,payload});
    expect(response.statusCode,response.body).toBe(200);
    const results=response.json().data.results;
    expect(results).toHaveLength(2);
    expect(results.map((row:{chunkKey:string})=>row.chunkKey)).toEqual([second.chunk_key,first.chunk_key]);
    expect(results[0]).toMatchObject({content:second.content,evidence:{child:second.content},rrfScore:nativeScores[1],rerankScore:0.95,parentId:created.documentVersionId,context:null});
    expect(results[1]).toMatchObject({content:first.content,evidence:{child:first.content},rrfScore:nativeScores[0],rerankScore:0.85,parentId:created.documentVersionId,context:null});
    for(const result of results){expect(result).not.toHaveProperty('parentChunkKey');expect(result).not.toHaveProperty('parentUniqKey');}
    expect(response.body).not.toContain('untrusted index text');
   }
   expect(milvus.hybridSearch).toHaveBeenCalledTimes(3);
   for(const call of milvus.hybridSearch.mock.calls)expect(call).toEqual([vector,payload.query,expect.objectContaining({scope:{userId:user.userId,workspaceId:user.workspaceId,sourceType:'file',versions:[{documentId:version.document_key,versionId:created.documentVersionId,embeddingProfile:version.embedding_profile,indexBuildId:version.index_build_id}]}})]);
   expect(milvus.search).not.toHaveBeenCalled();expect(milvus.searchKeyword).not.toHaveBeenCalled();
   expect(embedding.embed).toHaveBeenCalledTimes(3);
   expect(rerank).toHaveBeenCalledTimes(3);
   for(const [query,candidates] of rerank.mock.calls){
    expect(query).toBe(payload.query);
    expect(candidates.map(candidate=>({chunkKey:candidate.chunkKey,content:candidate.content,rrfScore:candidate.rrfScore}))).toEqual(siblings.map((child,index)=>({chunkKey:child.chunk_key,content:child.content,rrfScore:nativeScores[index]})));
   }
   const other=await fixture();
   const foreign=await app.inject({method:'POST',url:'/internal/v1/rag/query',headers:{authorization:`Bearer ${other.bearer}`,'x-huahuo-service-key':'a'.repeat(43)},payload});
   expect(foreign.statusCode).toBe(404);expect(foreign.json().error.code).toBe('RAG_DOCUMENT_NOT_FOUND');
   for(const headers of [{authorization:`Bearer ${user.bearer}`},{'x-huahuo-service-key':'a'.repeat(43)}]){
    const rejected=await app.inject({method:'POST',url:'/internal/v1/rag/query',headers,payload});
    expect(rejected.statusCode).toBe(401);
   }
   expect(milvus.hybridSearch).toHaveBeenCalledTimes(3);expect(embedding.embed).toHaveBeenCalledTimes(3);expect(rerank).toHaveBeenCalledTimes(3);
  }finally{await app.close();}
  expect(milvus.close).toHaveBeenCalledOnce();
 });
 it('hydrates explicit Mock BM25 hits from PostgreSQL only inside the authenticated workspace',async()=>{
  const user=await fixture();
  const repo=new RagIngestionRepository(apiPool,apiConfig.rag,'test',apiConfig.milvus.collection,apiConfig);
  const scope={userId:user.userId,sessionId:user.sessionId,traceId:user.traceId};
  const created=await repo.create(scope,{ossUrl:sourceUrl,fileName:'sample.md',mimeType:'text/markdown'});
  const jobs=new RagIngestionJobs(pool,config,storageFor(config));
  const engine=new TaskEngine(pool,30_000,undefined,undefined,undefined,jobs);
  const attempt=await engine.claim(created.jobId,randomUUID());
  expect(attempt).toBeTruthy();expect(await engine.execute(attempt!)).toBe(true);
  const version=(await root.query<{document_key:string;embedding_profile:string;index_build_id:string}>('SELECT document_key,embedding_profile,index_build_id FROM rag_ingestion_versions WHERE id=$1',[created.documentVersionId])).rows[0]!;
  const children=(await root.query<{chunk_key:string}>('SELECT chunk_key FROM rag_child_chunks WHERE version_id=$1 ORDER BY ordinal',[created.documentVersionId])).rows;
  type VectorIndex=NonNullable<RagQueryDependencies['milvus']>;
  const milvus={
   ensureReady:vi.fn<VectorIndex['ensureReady']>().mockResolvedValue(undefined),
   close:vi.fn<VectorIndex['close']>().mockResolvedValue(undefined),
   search:vi.fn<VectorIndex['search']>().mockRejectedValue(new Error('Unexpected dense search in keyword fixture')),
   hybridSearch:vi.fn<VectorIndex['hybridSearch']>().mockRejectedValue(new Error('Unexpected hybrid search in keyword fixture')),
   searchKeyword:vi.fn<VectorIndex['searchKeyword']>().mockResolvedValue(children.map((child,index)=>({chunkKey:child.chunk_key,score:1/(index+1),state:'ready'}))),
  };
  const app=await buildApiServer({config:apiConfig,ragQueryDependencies:{milvus}});
  try{
   const headers={authorization:`Bearer ${user.bearer}`};
   const payload={query:'第一段内容',mode:'keyword',topK:5,documentKey:version.document_key};
   const hit=await app.inject({method:'POST',url:'/api/v1/rag/query',headers,payload});
   expect(hit.statusCode,hit.body).toBe(200);
   expect(hit.json().data.results[0]).toMatchObject({chunkKey:children[0]!.chunk_key,documentVersionId:created.documentVersionId});
   expect(hit.json().data.results[0].content).toContain('第一段内容');
   expect(milvus.searchKeyword).toHaveBeenCalledWith('第一段内容',expect.objectContaining({scope:{userId:user.userId,workspaceId:user.workspaceId,sourceType:'file',versions:[{documentId:version.document_key,versionId:created.documentVersionId,embeddingProfile:version.embedding_profile,indexBuildId:version.index_build_id}]}}));
   const publicAlias=await app.inject({method:'POST',url:'/api/v1/huahuo_rag/query',headers,payload});
   expect(publicAlias.statusCode,publicAlias.body).toBe(200);
   expect(publicAlias.json().data.results[0]).toMatchObject({chunkKey:children[0]!.chunk_key,documentVersionId:created.documentVersionId});
   expect(milvus.searchKeyword).toHaveBeenCalledTimes(2);
   const other=await fixture();
   const foreign=await app.inject({method:'POST',url:'/api/v1/huahuo_rag/query',headers:{authorization:`Bearer ${other.bearer}`},payload});
   expect(foreign.statusCode).toBe(404);expect(foreign.json().error.code).toBe('RAG_DOCUMENT_NOT_FOUND');
   const unauth=await app.inject({method:'POST',url:'/api/v1/huahuo_rag/query',payload});
   expect(unauth.statusCode).toBe(401);expect(milvus.searchKeyword).toHaveBeenCalledTimes(2);
  }finally{await app.close();}
  expect(milvus.close).toHaveBeenCalledOnce();
 });
 it('requires user JWT and the directional service key for the internal RAG route',async()=>{const user=await fixture();const app=await buildApiServer({config:apiConfig});try{const payload={query:'第一段内容',mode:'keyword',topK:5};const valid={authorization:`Bearer ${user.bearer}`,'x-huahuo-service-key':'a'.repeat(43)};expect((await app.inject({method:'POST',url:'/internal/v1/rag/query',headers:valid,payload})).statusCode).not.toBe(401);expect((await app.inject({method:'POST',url:'/internal/v1/rag/query',headers:{authorization:`Bearer ${user.bearer}`},payload})).statusCode).toBe(401);expect((await app.inject({method:'POST',url:'/internal/v1/rag/query',headers:{'x-huahuo-service-key':'a'.repeat(43)},payload})).statusCode).toBe(401);expect((await app.inject({method:'POST',url:'/internal/v1/rag/query',headers:{authorization:'Bearer '+'a'.repeat(43),'x-user-id':user.userId,'x-huahuo-service-key':'a'.repeat(43)},payload})).statusCode).toBe(401);}finally{await app.close();}});
});
