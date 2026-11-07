import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { buildApiServer } from '../../src/apps/api-server.js';
import { loadConfig } from '../../src/config/config.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { AssetService } from '../../src/modules/assets/service.js';
import { DocumentIngestionService } from '../../src/modules/ingestion/service.js';
import { ManualTextIngestionJobs } from '../../src/modules/ingestion/jobs.js';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskEngine } from '../../src/modules/tasks/engine.js';
import { TaskScheduler, type Delivery } from '../../src/modules/tasks/scheduler.js';
import { QueuePublisher, TaskWorkers } from '../../src/modules/tasks/queue.js';
import { ConsistencyLevelEnum } from '@zilliz/milvus2-sdk-node';
import type { BoundVectorStoreAdapter, VectorRecord } from '../../src/lib/rag-indexing/index.js';
import { DeterministicEmbeddingClient } from '../../src/modules/rag/adapters/embedding.js';
import { createMilvusClient, MilvusError, MilvusRepository } from '../../src/modules/rag/adapters/milvus.js';
import { RagQueryService, type RagQueryMode } from '../../src/modules/rag/query-service.js';
import { createBusinessVectorStore } from '../../src/modules/rag/vector-store.js';
import { insertFixtureUser, insertFixtureSession, testJwtEnv } from './jwt-fixture.js';

const migrationUrl=process.env.TEST_DATABASE_MIGRATION_URL;
if(!migrationUrl||!/^huahuo_test_[a-z0-9_]+$/.test(new URL(migrationUrl).pathname.slice(1)))throw new Error('TEST_DB_REQUIRED');
const environment={...process.env,APP_ENV:'test',LOG_LEVEL:'silent',ALLOW_MOCK_PROVIDERS:'true',RAG_PROVIDER_MODE:'mock',RAG_EMBEDDING_MODEL:'manual-test-model',RAG_EMBEDDING_DIMENSIONS:'8',RAG_INGEST_BATCH_SIZE:'2',RAG_EMBEDDING_MAX_RETRIES:'0',MANUAL_TEXT_ENABLED:'true',MANUAL_TEXT_MILVUS_DATABASE:'default',MANUAL_TEXT_MILVUS_COLLECTION:'manual_text_test',...testJwtEnv};
const root=poolFor(loadConfig('migrate',{...environment,DATABASE_URL:migrationUrl}));
const config=loadConfig('api-server',{...environment,APP_TOKEN_SECRET:'ingestion-test-secret-'.repeat(2),APP_PUBLIC_BASE_URL:'http://ingestion.test',DATABASE_URL:process.env.TEST_DATABASE_API_URL});
const workerConfig=loadConfig('worker',{...environment,DATABASE_URL:process.env.TEST_DATABASE_WORKER_URL});
const pool=poolFor(config),workerPool=poolFor(workerConfig);
const assets=new AssetService(pool,config.appTokenSecret!);
const ingestion=new DocumentIngestionService(pool,config.appTokenSecret!,config);
const jobs=new ManualTextIngestionJobs(workerPool,workerConfig),engine=new TaskEngine(workerPool,15000);
async function run(jobId:string|null){expect(jobId).toBeTruthy();const attempt=await engine.claim(jobId!,randomUUID());expect(attempt).toBeTruthy();const result=await jobs.execute(attempt!);expect(await engine.finish(attempt!,result.digest,result.bytes)).toBe(true);}
async function fixture(){
 const userId=await insertFixtureUser(root),sessionId=randomUUID(),workspaceId=randomUUID();
 const bearer=await insertFixtureSession(root,userId,sessionId,'ingestion-fixture');
 await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'ingestion',true,$3)",[workspaceId,userId,randomUUID()]);
 return {workspaceId,bearer,scope:{userId,sessionId,traceId:randomUUID()}};
}
beforeAll(()=>migrate(loadConfig('migrate',{...environment,DATABASE_URL:migrationUrl})));
afterAll(async()=>{await jobs.close();await Promise.all([pool.end(),workerPool.end(),root.end()]);});
describe('manual text orchestration',()=>{
 it('concurrent requests with different transport keys reuse one source revision and task',async()=>{
  const user=await fixture();const note=await assets.createNote(user.scope,user.workspaceId,{title:'concurrent',parts:{raw:'one immutable original body'}},randomUUID());
  const [left,right]=await Promise.all([
   ingestion.ingestNote(user.scope,user.workspaceId,note.noteId,{},randomUUID()),
   ingestion.ingestNote(user.scope,user.workspaceId,note.noteId,{},randomUUID()),
  ]);
  expect(left.jobId).toBe(right.jobId);expect(left.idempotencyKey).toBe(right.idempotencyKey);
  expect((await root.query('SELECT count(*)::int n FROM note_index_jobs WHERE document_id=$1',[note.noteId])).rows[0].n).toBe(1);
 });
 it('preserves exact raw text and indexes source-owned chunks with heading context',async()=>{
  const user=await fixture(),raw='  # 主题\r\n\r\n第一段。😀第二段。\n尾部  ';
  const note=await assets.createNote(user.scope,user.workspaceId,{title:'入库素材',parts:{raw}},randomUUID());
  const first=await ingestion.ingestNote(user.scope,user.workspaceId,note.noteId,{maxTokens:16,overlapTokens:2},randomUUID());
  expect(first).toMatchObject({documentId:note.noteId,status:'processing',chunkerVersion:'langchain-recursive'});
  expect((await root.query('SELECT canonical_content FROM note_index_jobs WHERE idempotency_key=$1',[first.idempotencyKey])).rows[0].canonical_content).toBe(raw);
  await run(first.jobId);
  const version=(await root.query('SELECT status,processing_snapshot,toc_status,toc FROM note_index_jobs WHERE idempotency_key=$1',[first.idempotencyKey])).rows[0];
  expect(version).toMatchObject({status:'ready',toc_status:'ready',toc:[{kind:'heading',title:'主题',sourceStart:0,sourceEnd:raw.length}]});
  expect(version.processing_snapshot).toMatchObject({profileVersion:'manual-text',sourceType:'note',parentId:note.noteId,sourceRevision:first.documentVersion,split:{respectSections:true,targetSourceChars:300,maxSourceChars:500},vectorTarget:{database:'default',collection:'manual_text_test'}});
  const chunks=(await root.query('SELECT * FROM document_ingestion_chunks WHERE document_id=$1 ORDER BY chunk_index',[note.noteId])).rows;
  expect(chunks.length).toBeGreaterThan(0);
  for(const chunk of chunks){expect(chunk.document_id).toBe(note.noteId);expect(chunk.heading_path).toEqual(['主题']);expect(chunk.index_status).toBe('ready');expect(raw.slice(chunk.start_offset,chunk.end_offset)).toBe(chunk.text);}
  await expect(ingestion.ingestNote(user.scope,user.workspaceId,note.noteId,{content:'unsupported binary placeholder',mimeType:'application/pdf'},randomUUID())).rejects.toMatchObject({statusCode:400,code:'DOCUMENT_PARSE_FAILED'});
 });
 it('fails closed without generating chunks or choosing current defaults when the task snapshot is missing',async()=>{
  const user=await fixture(),note=await assets.createNote(user.scope,user.workspaceId,{title:'missing snapshot',parts:{raw:'original body stays available'}},randomUUID());
  const version=await ingestion.ingestNote(user.scope,user.workspaceId,note.noteId,{},randomUUID());
  await root.query('UPDATE note_index_jobs SET processing_snapshot=NULL WHERE idempotency_key=$1',[version.idempotencyKey]);
  const attempt=await engine.claim(version.jobId!,randomUUID());expect(attempt).toBeTruthy();
  await expect(jobs.execute(attempt!)).rejects.toMatchObject({code:'INGEST_SNAPSHOT_UNAVAILABLE'});
  expect((await root.query('SELECT canonical_content,processing_snapshot FROM note_index_jobs WHERE idempotency_key=$1',[version.idempotencyKey])).rows[0]).toMatchObject({canonical_content:'original body stays available',processing_snapshot:null});
  expect((await root.query('SELECT count(*)::int n FROM document_ingestion_chunks WHERE document_id=$1',[note.noteId])).rows[0].n).toBe(0);
 });
 it('reuses the fixed source revision, content and target for repeated requests',async()=>{
  const user=await fixture(),note=await assets.createNote(user.scope,user.workspaceId,{title:'幂等',parts:{raw:'stable text'}},randomUUID());
  const first=await ingestion.ingestNote(user.scope,user.workspaceId,note.noteId,{},randomUUID());await run(first.jobId);
  const before=(await root.query('SELECT chunk_id FROM document_ingestion_chunks WHERE document_id=$1 ORDER BY chunk_index',[note.noteId])).rows;
  const reused=await ingestion.ingestNote(user.scope,user.workspaceId,note.noteId,{},randomUUID());expect(reused.reused).toBe(true);expect(reused.idempotencyKey).toBe(first.idempotencyKey);
  expect((await root.query('SELECT chunk_id FROM document_ingestion_chunks WHERE document_id=$1 ORDER BY chunk_index',[note.noteId])).rows).toEqual(before);
 });
 it('serves version-scoped TOC and exact nested Note sections through authenticated routes',async()=>{
  const user=await fixture(),app=await buildApiServer({config});
  try{
   const auth={authorization:`Bearer ${user.bearer}`};
   const child='## 子章节\r\n\r\n字😀。  \r\n\r\n';
   const parent='# 标题😀\r\n\r\n父章节正文\r\n\r\n'+child;
   const preamble='前言😀\r\n\r\n';
   const raw=preamble+parent+'# 标题😀\r\n\r\n最后一节';
   const note=await assets.createNote(user.scope,user.workspaceId,{title:'HTTP 入库',parts:{raw}},randomUUID());
   const url=`/api/v1/workspaces/${user.workspaceId}/notes/${note.noteId}/document-ingestion`;
   const request={method:'POST' as const,url,headers:{...auth,'x-idempotency-key':randomUUID()},payload:{}};
   const accepted=await app.inject(request);expect(accepted.statusCode,accepted.body).toBe(200);expect(accepted.json().data.status).toBe('processing');
   const replay=await app.inject(request);expect(replay.statusCode).toBe(200);expect(replay.json().data).toEqual(accepted.json().data);
   const {jobId,documentVersion}=accepted.json().data;
   const detailUrl=`${url}/${jobId}`;
   const pending=await app.inject({url:detailUrl,headers:auth});expect(pending.statusCode,pending.body).toBe(200);
   expect(pending.json().data).toMatchObject({jobId,tocStatus:'pending',toc:null});
   const early=await app.inject({url:`${detailUrl}/sections/section-preamble`,headers:auth});expect(early.statusCode,early.body).toBe(409);
   await run(jobId);
   const listed=await app.inject({url,headers:auth});expect(listed.statusCode,listed.body).toBe(200);
   expect(listed.json().data.items[0]).toMatchObject({jobId,status:'ready',tocStatus:'ready'});
   const detail=await app.inject({url:detailUrl,headers:auth});expect(detail.statusCode,detail.body).toBe(200);
   const {toc}=detail.json().data;
   expect(detail.json().data).toMatchObject({jobId,documentVersion,tocStatus:'ready',offsetUnit:'utf16'});
   expect(toc.map((item:{kind:string})=>item.kind)).toEqual(['preamble','heading','heading']);
   expect(toc[1].sectionId).not.toBe(toc[2].sectionId);
   for(const [section,content] of [[toc[0],preamble],[toc[1],parent],[toc[1].children[0],child]]){
    const read=await app.inject({url:`${detailUrl}/sections/${section.sectionId}`,headers:auth});expect(read.statusCode,read.body).toBe(200);
    expect(read.json().data).toMatchObject({sectionId:section.sectionId,documentVersion,sourceStart:section.sourceStart,sourceEnd:section.sourceEnd,offsetUnit:'utf16',format:'markdown',content});
   }
   const foreign=await fixture();
   const sectionUrl=`${detailUrl}/sections/${toc[1].sectionId}`;
   expect((await app.inject({url:sectionUrl})).statusCode).toBe(401);
   expect((await app.inject({url:sectionUrl,headers:{authorization:`Bearer ${foreign.bearer}`}})).statusCode).toBe(404);
   expect((await app.inject({url:`${detailUrl}/sections/section-body`,headers:auth})).statusCode).toBe(404);
  }finally{await app.close();}
 });
 it('automatically schedules Note creation and raw edits in the same business transaction without a second ingestion request',async()=>{
  const user=await fixture(),app=await buildApiServer({config});
  try{
   const url=`/api/v1/workspaces/${user.workspaceId}/notes`,auth={authorization:`Bearer ${user.bearer}`};
   const firstSentence='  # 手动标题\r\n\r\n'+'长'.repeat(390)+'。';
   const raw=firstSentence+'保留原始😀正文。'.repeat(90)+'  ',createKey=randomUUID();
   const createRequest={method:'POST' as const,url,headers:{...auth,'x-idempotency-key':createKey},payload:{title:'自动入库',parts:{raw}}};
   const created=await app.inject(createRequest);expect(created.statusCode,created.body).toBe(200);const note=created.json().data;
   expect((await app.inject(createRequest)).json().data).toEqual(note);
   const first=(await root.query('SELECT task_id,canonical_content,processing_snapshot FROM note_index_jobs WHERE document_id=$1',[note.noteId])).rows;
   expect(first).toHaveLength(1);expect(first[0].canonical_content).toBe(raw);expect(first[0].processing_snapshot).toMatchObject({sourceType:'note',parentId:note.noteId,sourceRevision:note.noteRevisionId,split:{respectSections:true,targetSourceChars:300,maxSourceChars:500}});
   await run(first[0].task_id);
   const chunks=(await root.query('SELECT text,start_offset,end_offset FROM document_ingestion_chunks WHERE document_id=$1 ORDER BY chunk_index',[note.noteId])).rows;
   expect(chunks.length).toBeGreaterThan(1);
   expect(chunks[0].text).toBe(firstSentence);
   for(const chunk of chunks){
    expect(Array.from(chunk.text).length).toBeLessThanOrEqual(500);
    expect(chunk.text).toBe(raw.slice(chunk.start_offset,chunk.end_offset));
   }
   const secondRaw='\n新的完整原文，仍然保留首尾空白。\n ',updateKey=randomUUID();
   const updateRequest={method:'PATCH' as const,url:`${url}/${note.noteId}`,headers:{...auth,'if-match':note.etag,'x-idempotency-key':updateKey},payload:{parts:{raw:secondRaw}}};
   const edited=await app.inject(updateRequest);expect(edited.statusCode,edited.body).toBe(200);expect((await app.inject(updateRequest)).json().data).toEqual(edited.json().data);
   const versions=(await root.query('SELECT task_id,canonical_content,document_version,status FROM note_index_jobs WHERE document_id=$1 ORDER BY created_at',[note.noteId])).rows;
   expect(versions).toHaveLength(2);expect(versions[0].status).toBe('ready');expect(versions[1]).toMatchObject({canonical_content:secondRaw,document_version:edited.json().data.noteRevisionId,status:'processing'});
   await run(versions[1].task_id);
   expect((await root.query('SELECT status FROM note_index_jobs WHERE task_id=$1',[versions[1].task_id])).rows[0].status).toBe('ready');
   expect((await root.query("SELECT count(*)::int n FROM tasks WHERE kind='document.text-index' AND user_id=$1",[user.scope.userId])).rows[0].n).toBe(2);
  }finally{await app.close();}
 });
 it('replaces current chunks and keeps job section snapshots readable',async()=>{
  const user=await fixture(),note=await assets.createNote(user.scope,user.workspaceId,{title:'版本',parts:{raw:'first revision'}},randomUUID());
  const first=await ingestion.ingestNote(user.scope,user.workspaceId,note.noteId,{},randomUUID());await run(first.jobId);
  const updated=await assets.updateNote(user.scope,user.workspaceId,note.noteId,{parts:{raw:'second revision'}},note.etag,randomUUID());
  const second=await ingestion.ingestNote(user.scope,user.workspaceId,note.noteId,{},randomUUID());
  expect((await root.query('SELECT status FROM note_index_jobs WHERE idempotency_key=$1',[first.idempotencyKey])).rows[0].status).toBe('ready');
  await run(second.jobId);
  expect(second.documentVersion).toBe(updated.noteRevisionId);
  expect((await root.query('SELECT canonical_content FROM note_index_state WHERE document_id=$1',[note.noteId])).rows[0]).toMatchObject({canonical_content:'second revision'});
  expect((await root.query('SELECT text FROM document_ingestion_chunks WHERE document_id=$1',[note.noteId])).rows).toEqual([{text:'second revision'}]);
  await expect(ingestion.noteSection(user.scope,user.workspaceId,note.noteId,first.jobId!,'section-body')).resolves.toMatchObject({documentVersion:first.documentVersion,content:'first revision'});
  await expect(ingestion.noteSection(user.scope,user.workspaceId,note.noteId,second.jobId!,'section-body')).resolves.toMatchObject({documentVersion:second.documentVersion,content:'second revision'});
 });
 it('allows a pending original-text task after a title-only edit without scheduling duplicate indexing',async()=>{
  const user=await fixture(),automaticAssets=new AssetService(pool,config.appTokenSecret!,config);
  const note=await automaticAssets.createNote(user.scope,user.workspaceId,{title:'before title',parts:{raw:'  unchanged complete original text  '}},randomUUID());
  const version=(await root.query('SELECT idempotency_key,task_id,processing_snapshot FROM note_index_jobs WHERE document_id=$1',[note.noteId])).rows[0];expect(version.processing_snapshot.expectedRawRevision).toBeTruthy();
  const edited=await automaticAssets.updateNote(user.scope,user.workspaceId,note.noteId,{title:'after title'},note.etag,randomUUID());expect(edited.noteRevisionId).not.toBe(note.noteRevisionId);
  expect((await root.query("SELECT count(*)::int n FROM tasks WHERE kind='document.text-index' AND user_id=$1",[user.scope.userId])).rows[0].n).toBe(1);
  await run(version.task_id);
  expect((await root.query('SELECT status,canonical_content FROM note_index_jobs WHERE idempotency_key=$1',[version.idempotency_key])).rows[0]).toMatchObject({status:'ready',canonical_content:'  unchanged complete original text  '});
 });
 it('rejects stale edit/deleted-note tasks before publishing or indexing another user source',async()=>{
  const user=await fixture(),note=await assets.createNote(user.scope,user.workspaceId,{title:'stale',parts:{raw:'old source'}},randomUUID());
  const first=await ingestion.ingestNote(user.scope,user.workspaceId,note.noteId,{},randomUUID());
  await assets.updateNote(user.scope,user.workspaceId,note.noteId,{parts:{raw:'new source'}},note.etag,randomUUID());
  const attempt=await engine.claim(first.jobId!,randomUUID());expect(attempt).toBeTruthy();await expect(jobs.execute(attempt!)).rejects.toMatchObject({code:'INGEST_SOURCE_SUPERSEDED'});
  expect((await root.query('SELECT count(*)::int n FROM document_ingestion_chunks WHERE document_id=$1',[note.noteId])).rows[0].n).toBe(0);
  const foreign=await fixture();await expect(ingestion.ingestNote(foreign.scope,user.workspaceId,note.noteId,{},randomUUID())).rejects.toMatchObject({code:'NOTE_NOT_FOUND'});
 });
 it('retries failed batches only and preserves successful chunks and the fixed target',async()=>{
  const user=await fixture(),note=await assets.createNote(user.scope,user.workspaceId,{title:'partial',parts:{raw:Array.from({length:24},(_,i)=>`paragraph ${i} text\n`).join('')}},randomUUID());
  const version=await ingestion.ingestNote(user.scope,user.workspaceId,note.noteId,{maxTokens:32,overlapTokens:2},randomUUID());
  let fail = true;
  let observedPartial = false;
  const writes = new Map<string, number>();
  const retryJobs = new ManualTextIngestionJobs(workerPool, workerConfig, {
   vectorStore: snapshot => ({
    target: snapshot.vectorTarget,
    async upsert(rows) {
     if (fail) { fail = false; throw new Error('EXPLICIT_VECTOR_MOCK_FAILURE'); }
     if (writes.size) {
      const counts = (await root.query<{ready: number; total: number}>(
       "SELECT count(*) FILTER (WHERE index_status='ready')::int AS ready,count(*)::int AS total FROM document_ingestion_chunks WHERE document_id=$1",
       [note.noteId],
      )).rows[0]!;
      if (counts.ready > 0 && counts.ready < counts.total) observedPartial = true;
     }
     for (const row of rows) writes.set(row.id, (writes.get(row.id) ?? 0) + 1);
    },
    async delete() {},
   }),
  });
  const first=await engine.claim(version.jobId!,randomUUID());expect(first).toBeTruthy();await expect(retryJobs.execute(first!)).rejects.toMatchObject({code:'INGEST_INDEX_PARTIAL_FAILURE',retryable:true});
  const ready=(await root.query<{chunk_id:string}>("SELECT chunk_id FROM document_ingestion_chunks WHERE document_id=$1 AND index_status='ready'",[note.noteId])).rows;
  expect(ready.length).toBeGreaterThan(0);expect((await root.query('SELECT status FROM note_index_jobs WHERE idempotency_key=$1',[version.idempotencyKey])).rows[0].status).toBe('failed');
  await expect(ingestion.noteSection(user.scope,user.workspaceId,note.noteId,version.jobId!,'section-body')).resolves.toMatchObject({content:expect.stringContaining('paragraph 23 text')});
  await engine.fail(first!,'INGEST_INDEX_PARTIAL_FAILURE',true);await root.query("UPDATE tasks SET available_at=now()-interval '1 second' WHERE id=$1",[version.jobId]);
  const second=await engine.claim(version.jobId!,randomUUID());expect(second).toBeTruthy();const result=await retryJobs.execute(second!);expect(await engine.finish(second!,result.digest,result.bytes)).toBe(true);
  for(const row of ready)expect(writes.get(row.chunk_id)).toBe(1);
  expect(observedPartial).toBe(true);
  expect((await root.query('SELECT status FROM note_index_jobs WHERE idempotency_key=$1',[version.idempotencyKey])).rows[0].status).toBe('ready');
 });
 it('deletes vectors in their original binding and prevents a deleted-note pending task from publishing',async()=>{
  const user=await fixture(),note=await assets.createNote(user.scope,user.workspaceId,{title:'delete',parts:{raw:'retained original text'}},randomUUID());
  const stored=new Set<string>();
  const deletingJobs=new ManualTextIngestionJobs(workerPool,workerConfig,{vectorStore:snapshot=>({target:snapshot.vectorTarget,async upsert(rows){for(const row of rows)stored.add(row.id);},async delete(selector){if(!('ids'in selector)||!selector.ids)throw new Error('EXPECTED_IDS');for(const id of selector.ids)stored.delete(id);},async close(){}})});
  const version=await ingestion.ingestNote(user.scope,user.workspaceId,note.noteId,{},randomUUID());
  const indexAttempt=await engine.claim(version.jobId!,randomUUID());expect(indexAttempt).toBeTruthy();const indexed=await deletingJobs.execute(indexAttempt!);expect(await engine.finish(indexAttempt!,indexed.digest,indexed.bytes)).toBe(true);expect(stored.size).toBeGreaterThan(0);
  await assets.deleteNote(user.scope,user.workspaceId,note.noteId,note.etag,randomUUID());
  await expect(ingestion.noteSection(user.scope,user.workspaceId,note.noteId,version.jobId!,'section-body')).rejects.toMatchObject({statusCode:404});
  const cleanupTask=(await root.query<{id:string}>("SELECT id FROM tasks WHERE user_id=$1 AND kind='document.text-cleanup' ORDER BY created_at DESC LIMIT 1",[user.scope.userId])).rows[0];expect(cleanupTask).toBeTruthy();
  const cleanupAttempt=await engine.claim(cleanupTask!.id,randomUUID());expect(cleanupAttempt).toBeTruthy();const cleaned=await deletingJobs.executeCleanup(cleanupAttempt!);expect(await engine.finish(cleanupAttempt!,cleaned.digest,cleaned.bytes)).toBe(true);expect(stored.size).toBe(0);
  expect((await root.query('SELECT count(*)::int n FROM document_ingestion_chunks WHERE document_id=$1',[note.noteId])).rows[0].n).toBe(0);
  const pendingNote=await assets.createNote(user.scope,user.workspaceId,{title:'pending delete',parts:{raw:'pending original'}},randomUUID());const pending=await ingestion.ingestNote(user.scope,user.workspaceId,pendingNote.noteId,{},randomUUID());await assets.deleteNote(user.scope,user.workspaceId,pendingNote.noteId,pendingNote.etag,randomUUID());const stale=await engine.claim(pending.jobId!,randomUUID());expect(stale).toBeTruthy();await expect(deletingJobs.execute(stale!)).rejects.toMatchObject({code:'INGEST_SOURCE_SUPERSEDED'});
 });
});

interface ChunkRow {
 chunk_id: string;
 block_id: string;
 chunk_index: number;
 start_offset: number;
 end_offset: number;
 core_start: number;
 core_end: number;
 text: string;
 embedding_text: string;
 embedding_token_count: number;
 index_status: string;
 heading_path: string[];
}

const modes: RagQueryMode[] = ['dense', 'keyword', 'hybrid'];
const milvusAddress = process.env.TEST_MILVUS_ADDRESS;
if (milvusAddress && !/^127\.0\.0\.1:\d+$/.test(milvusAddress)) throw new Error('TEST_MILVUS_LOOPBACK_REQUIRED');
const editEnvironment = {
 ...environment, RAG_INGEST_BATCH_SIZE: '1', MANUAL_TEXT_OVERLAP_TOKENS: '0', REDIS_KEY_PREFIX: 'note-edit-' + randomUUID(), WORKER_QUEUES: 'content',
 ...(milvusAddress ? { MILVUS_ADDRESS: milvusAddress, MILVUS_USERNAME: 'root', MILVUS_PASSWORD: 'Milvus', MILVUS_TLS: 'false', MILVUS_CREATE_IF_MISSING: 'true' } : {}),
};
const editConfig = loadConfig('api-server', { ...editEnvironment, DATABASE_URL: process.env.TEST_DATABASE_API_URL, APP_TOKEN_SECRET: config.appTokenSecret, APP_PUBLIC_BASE_URL: config.appPublicBaseUrl });
const editWorker = loadConfig('worker', { ...editEnvironment, DATABASE_URL: process.env.TEST_DATABASE_WORKER_URL });
const rawAssets = new AssetService(pool, config.appTokenSecret!, editConfig);
const alternateAssets = (settings: Record<string, string>) => new AssetService(pool, config.appTokenSecret!, loadConfig('api-server', { ...editEnvironment, DATABASE_URL: process.env.TEST_DATABASE_API_URL, APP_TOKEN_SECRET: config.appTokenSecret, APP_PUBLIC_BASE_URL: config.appPublicBaseUrl, ...settings }));
const editEngine = new TaskEngine(workerPool, 60000);
const sorted = (ids: readonly string[]) => [...ids].sort();
function latch() {
 let resolve!: () => void;
 const promise = new Promise<void>(done => { resolve = done; });
 return { promise, resolve };
}
const ids = (rows: ChunkRow[]) => rows.map(row => row.chunk_id);
const patch = (raw: string, start: number, end: number, replacement = '') => raw.slice(0, start) + replacement + raw.slice(end);
const section = (heading: string, body: string) => `# ${heading}\n\n${body}\n\n`;
const oldSections = [section('开头', 'alphaquartz 原文甲。'), section('中部', 'basaltmeadow 原文乙。'), section('尾部', 'cedarwindow 原文丙。')];
const replaceBody = oldSections.join('');
const longBody = Array.from({ length: 5200 }, (_, index) => String.fromCharCode(0x4e00 + index)).join('');
const matrixRaw = section('开头', 'alphaquartz ' + '甲'.repeat(280) + '。') + section('正文', longBody + '。') + section('尾部', 'cedarwindow ' + '丙'.repeat(280) + '。');

function assertOffsets(raw: string, chunks: ChunkRow[]) {
 let covered = 0;
 const boundaries = new Set([raw.length, ...Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(raw), part => part.index)]);
 for (const [index, chunk] of chunks.entries()) {
  expect(chunk.chunk_index).toBe(index);
  expect(chunk.core_start).toBeGreaterThanOrEqual(covered);
  expect(raw.slice(covered, chunk.core_start).trim()).toBe('');
  expect(chunk.start_offset).toBeLessThanOrEqual(chunk.core_start);
  expect(chunk.core_end).toBeGreaterThan(chunk.core_start);
  expect(chunk.end_offset).toBe(chunk.core_end);
  expect(raw.slice(chunk.start_offset, chunk.end_offset)).toBe(chunk.text);
  for (const offset of [chunk.start_offset, chunk.core_start, chunk.core_end]) expect(boundaries.has(offset)).toBe(true);
  expect([...chunk.text].length).toBeLessThanOrEqual(500);
  expect(chunk.embedding_token_count).toBeLessThanOrEqual(editConfig.manualText.maxEmbeddingTokens);
  expect(chunk.index_status).toBe('ready');
  covered = chunk.core_end;
 }
 expect(raw.slice(covered).trim()).toBe('');
 expect(new Set(ids(chunks)).size).toBe(chunks.length);
 expect(new Set(chunks.map(chunk => chunk.block_id)).size).toBe(chunks.length);
}

async function editFixture(realMilvus = false) {
 const user = await fixture();
 const binding = { ...editWorker.milvus, database: editWorker.manualText.database!, collection: editWorker.manualText.collection! };
 const repository = realMilvus ? new MilvusRepository(binding) : undefined;
 const client = realMilvus ? createMilvusClient(binding) : undefined;
 const written: string[] = [], deleted: string[] = [];
 const stored = new Map<string, VectorRecord>();
 let beforeWrite: (() => Promise<void>) | undefined;
 let afterWrite: (() => Promise<void>) | undefined;
 let beforeDelete: (() => Promise<void>) | undefined;
 let duringRecall: (() => Promise<void>) | undefined;
 let duringRerank: (() => Promise<void>) | undefined;
 const indexing = new ManualTextIngestionJobs(workerPool, editWorker, {
  vectorStore(snapshot) {
   // The test uses deterministic embeddings, with an opt-in real Milvus transport.
   const remote = realMilvus ? createBusinessVectorStore({ ...editWorker, rag: { ...editWorker.rag, providerMode: 'live' } }, snapshot.vectorTarget) : undefined;
   return {
    target: snapshot.vectorTarget,
    async upsert(rows, options) {
     written.push(...rows.map(row => row.id));
     await beforeWrite?.();
     await remote?.upsert(rows, options);
     for (const row of rows) stored.set(row.id, row);
     await afterWrite?.();
    },
    async delete(selector, options) {
     if (!selector.ids) throw new Error('EXPECTED_NOTE_POINT_IDS');
     deleted.push(...selector.ids);
     await beforeDelete?.();
     await remote?.delete(selector, options);
     for (const id of selector.ids) stored.delete(id);
    },
    async close() { await remote?.close(); },
   } satisfies BoundVectorStoreAdapter & { close(): Promise<void> };
  },
 });
 const recall = vi.fn(async (query: string | undefined, options: { scope: Parameters<MilvusRepository['searchKeyword']>[1]['scope'] }) => {
  const hits = [...stored.values()].filter(row => options.scope.sourceType === 'note' && options.scope.note.chunkIds.includes(row.id)
   && (query === undefined || String(row.metadata.content).includes(query)));
  await duringRecall?.();
  return hits.map(row => ({ chunkKey: row.id, score: 1, state: 'ready' }));
 });
 const index = repository ?? {
  async ensureReady() {}, async close() {},
  search: (_vector: number[], options: Parameters<MilvusRepository['search']>[1]) => recall(undefined, options),
  searchKeyword: (query: string, options: Parameters<MilvusRepository['searchKeyword']>[1]) => recall(query, options),
  hybridSearch: (_vector: number[], _query: string, options: Parameters<MilvusRepository['hybridSearch']>[2]) => recall(undefined, options),
 };
 const rag = new RagQueryService(pool, editConfig, { milvus: index });
 const reranked = new RagQueryService(pool, editConfig, { milvus: index, rerank: { async rerank(_query, candidates) { await duringRerank?.(); return candidates.map(candidate => ({ ...candidate, rerankScore: 1 })); } } });
 const embedding = vi.spyOn(DeterministicEmbeddingClient.prototype, 'embed');
 const task = async (noteId: string) => {
  const row = (await root.query<{ task_id: string }>(`SELECT task_id FROM note_index_jobs WHERE document_id=$1 AND workspace_id=$2
    ORDER BY created_at DESC,idempotency_key DESC LIMIT 1`, [noteId, user.workspaceId])).rows[0];
  expect(row?.task_id).toBeTruthy();
  return row!.task_id;
 };
 const claim = async (taskId: string) => {
  let attempt = await editEngine.claim(taskId, randomUUID());
  for (let retries = 0; !attempt && retries < 40; retries += 1) {
   const { rows: [task] } = await root.query('SELECT state FROM tasks WHERE id=$1', [taskId]);
   if (!['queued', 'retry_scheduled'].includes(task?.state)) break;
   await delay(50);
   attempt = await editEngine.claim(taskId, randomUUID());
  }
  if (!attempt) {
   const { rows } = await root.query('SELECT state,available_at,clock_timestamp() AS current_time FROM tasks WHERE id=$1', [taskId]);
   throw new Error('Task could not be claimed: ' + JSON.stringify(rows));
  }
  return attempt;
 };
 const finish = async (attempt: Awaited<ReturnType<typeof claim>>, cleanup = false) => {
  const result = cleanup ? await indexing.executeCleanup(attempt) : await indexing.execute(attempt);
  expect(await editEngine.finish(attempt, result.digest, result.bytes)).toBe(true);
 };
 const chunks = async (noteId: string) => (await root.query<ChunkRow>(
  'SELECT * FROM document_ingestion_chunks WHERE document_id=$1 AND workspace_id=$2 ORDER BY chunk_index', [noteId, user.workspaceId])).rows;
 const reset = () => { written.length = 0; deleted.length = 0; embedding.mockClear(); recall.mockClear(); };
 const assertPoints = async (noteId: string, current: ChunkRow[]) => {
  const physical = client ? (await client.query({
   collection_name: binding.collection,
   filter: `source_type == "note" && doc_id == ${JSON.stringify(noteId)}`,
   output_fields: ['id', 'text'], consistency_level: ConsistencyLevelEnum.Strong,
  })) : undefined;
  if (physical) expect(physical.status.error_code).toBe('Success');
  const actual = physical?.data.map(row => [row.id, row.text] as const) ?? [...stored.values()].filter(row => row.metadata.parent_id === noteId)
   .map(row => [row.id, row.metadata.content] as const);
  expect(actual).toHaveLength(current.length);
  expect(new Map(actual)).toEqual(new Map(current.map(chunk => [chunk.chunk_id, chunk.text])));
 };
 const query = (noteId: string, term: string, mode: RagQueryMode) => (duringRerank ? reranked : rag).query(user.scope, { sourceType: 'note', documentId: noteId, query: term, mode, topK: 50 });
 const assertEdit = async (noteId: string, raw: string, before: ChunkRow[], after: ChunkRow[]) => {
  assertOffsets(raw, after);
  expect(sorted(written)).toEqual(sorted(ids(after).filter(id => !ids(before).includes(id))));
  expect(sorted(deleted)).toEqual(sorted(ids(before).filter(id => !ids(after).includes(id))));
  expect(sorted(embedding.mock.calls.flatMap(([texts]) => texts))).toEqual(sorted(after.filter(row => written.includes(row.chunk_id)).map(row => row.embedding_text)));
  const available = before.filter(row => row.index_status === 'ready').map(row => [row.text, row.embedding_text]);
  for (const row of after) {
   const match = available.findIndex(([text, input]) => text === row.text && input === row.embedding_text);
   if (match < 0) continue;
   expect(written).not.toContain(row.chunk_id);
   available.splice(match, 1);
  }
  await assertPoints(noteId, after);
 };
 const create = async (raw: string, assets = rawAssets) => assets.createNote(user.scope, user.workspaceId, { title: 'Note 差分矩阵', parts: { raw } }, randomUUID());
 const save = (note: Awaited<ReturnType<typeof create>>, raw: string, assets = rawAssets, key = randomUUID()) => assets.updateNote(user.scope, user.workspaceId, note.noteId, { parts: { raw } }, note.etag, key);
 const execute = async (noteId: string) => finish(await claim(await task(noteId)));
 const retry = async (attempt: Awaited<ReturnType<typeof claim>>, code: string) => {
  expect(await editEngine.fail(attempt, code, true)).toBe(true);
  await root.query("UPDATE tasks SET available_at=now()-interval '1 second' WHERE id=$1", [attempt.task.id]);
  return claim(attempt.task.id);
 };
 return { user, create, save, execute, task, claim, finish, indexing, retry, chunks, reset, written, deleted, stored, embedding, assertEdit, assertPoints, query, recall,
  onWrite: (hook?: typeof beforeWrite) => { beforeWrite = hook; },
  onWritten: (hook?: typeof afterWrite) => { afterWrite = hook; },
  onDelete: (hook?: typeof beforeDelete) => { beforeDelete = hook; },
  onRecall: (hook?: typeof duringRecall) => { duringRecall = hook; },
  onRerank: (hook?: typeof duringRerank) => { duringRerank = hook; },
  async close() { embedding.mockRestore(); await Promise.all([rag.close(), indexing.close(), client?.closeConnection()]); },
 };
}

type EditFixture = Awaited<ReturnType<typeof editFixture>>;
async function inEditFixture(operation: (fixture: EditFixture) => Promise<void>, realMilvus = false) {
 const f = await editFixture(realMilvus);
 try { await operation(f); } finally { await f.close(); }
}

const interior = (rows: ChunkRow[]) => rows.filter(row => row.heading_path[0] === '正文');
const middle = (row: ChunkRow) => Math.floor((row.core_start + row.core_end) / 2);
type EditCase = {
 name: string;
 next: (raw: string, rows: ChunkRow[]) => string;
 affected: (rows: ChunkRow[]) => ChunkRow[];
 keepLogical?: boolean;
};
const deltaCases: EditCase[] = [
 { name: 'E01 identical save', next: raw => raw, affected: () => [] },
 ...(['replace one', 'insert', 'longer replacement'] as const).map(operation => ({
  name: `E02 ${operation}`,
  next: (raw: string, rows: ChunkRow[]) => {
   const offset = middle(rows[0]!);
   return patch(raw, offset, offset + Number(operation !== 'insert'), operation === 'replace one' ? 'Z' : '新增文本');
  },
  affected: (rows: ChunkRow[]) => [rows[0]!], keepLogical: true,
 })),
 ...(['front', 'back', 'middle'] as const).map(side => ({
  name: `E03 half deletion from ${side}`,
  next: (raw: string, rows: ChunkRow[]) => {
   const row = interior(rows)[1]!, quarter = Math.floor((row.core_end - row.core_start) / 4);
   return side === 'front' ? patch(raw, row.core_start, middle(row)) : side === 'back' ? patch(raw, middle(row), row.core_end)
    : patch(raw, row.core_start + quarter, row.core_end - quarter);
  },
  affected: (rows: ChunkRow[]) => [interior(rows)[1]!], keepLogical: true,
 })),
 ...[['E05 append', (raw: string) => raw + '新增末句。'], ['E05 remove end', (raw: string) => raw.slice(0, -5)],
  ['E05 append over cap', (raw: string) => raw + '长'.repeat(600)], ['E06 insert at cut', (raw: string, rows: ChunkRow[]) => patch(raw, interior(rows)[1]!.core_end, interior(rows)[1]!.core_end, '边界标记🧩')],
 ] .map(([name, next]) => ({ name, next, affected: (rows: ChunkRow[]) => name === 'E05 remove end' ? [rows.at(-1)!] : [] }) as EditCase),
 ...['', '短文', '较长的跨块替换。'.repeat(90)].map((text, index) => ({
  name: index === 0 ? 'E09 cross-boundary deletion' : `E10 cross-boundary replacement ${index}`,
  next: (raw: string, rows: ChunkRow[]) => {
   const block = interior(rows)[1]!;
   return patch(raw, block.core_end - 12, block.core_end + 12, text);
  },
  affected: (rows: ChunkRow[]) => interior(rows).slice(1, 3),
 })),
 { name: 'E10 spans three blocks', next: (raw, rows) => patch(raw, middle(interior(rows)[1]!), middle(interior(rows)[3]!), '跨三个块'),
  affected: rows => interior(rows).slice(1, 4) },
 { name: 'E11 multiple distant edits', next: raw => raw.replace('alphaquartz', 'firstnew').replace(longBody.slice(780, 785), 'midnew').replace('cedarwindow', 'lastnew'),
  affected: rows => rows.filter(row => row.text.includes('alphaquartz') || row.text.includes(longBody.slice(780, 785)) || row.text.includes('cedarwindow')) },
 { name: 'F01 large replacement with shifted suffix', next: raw => raw.replace(longBody, '丁'.repeat(5221)), affected: interior },
 { name: 'F04 replaces entire body', next: () => section('重写', '全新正文。'.repeat(240)), affected: rows => rows },
];

async function assertSearch(f: EditFixture, noteId: string, rows: ChunkRow[], expectedTerm: string, retired: ChunkRow[] = []) {
 for (const mode of modes) {
  const { results } = await f.query(noteId, expectedTerm, mode);
  expect(results.some(hit => String(hit.content).includes(expectedTerm)), `${mode} did not return ${expectedTerm}`).toBe(true);
  for (const hit of results) {
   const row = rows.find(chunk => chunk.chunk_id === hit.chunkId);
   expect(row).toBeTruthy();
   expect(hit).toMatchObject({ content: row!.text, parentId: noteId, chunkIndex: row!.chunk_index });
   expect(ids(retired)).not.toContain(hit.chunkId);
  }
 }
}

async function runEditCase(f: EditFixture, test: EditCase, search?: { hit: string; retired?: string; original?: string }) {
 const original = search?.original ?? matrixRaw;
 const note = await f.create(original);
 await f.execute(note.noteId);
 const before = await f.chunks(note.noteId);
 expect(interior(before).length).toBeGreaterThan(4);
 f.reset();
 const raw = test.next(original, before);
 await f.save(note, raw);
 await f.execute(note.noteId);
 const after = await f.chunks(note.noteId);
 await f.assertEdit(note.noteId, raw, before, after);
 expect(sorted(f.deleted)).toEqual(sorted(ids(test.affected(before))));
 if (test.name.startsWith('E06')) {
  expect(f.written).toHaveLength(1);
  expect(after.filter(row => row.text.includes('边界标记🧩'))).toHaveLength(1);
 }
 if (test.keepLogical) {
  expect(f.written).toHaveLength(1);
  expect(after.find(row => row.chunk_id === f.written[0])?.block_id).toBe(test.affected(before)[0]!.block_id);
 }
 if (search) {
  await assertSearch(f, note.noteId, after, search.hit, test.affected(before));
  if (search.retired) {
   expect(before.some(row => row.text.includes(search.retired!))).toBe(true);
   expect((await f.query(note.noteId, search.retired, 'keyword')).results).toEqual([]);
  }
 }
}

async function clearAndRestore(f: EditFixture, empty: string, real = false) {
 let note = await f.create(replaceBody);
 await f.execute(note.noteId);
 const before = await f.chunks(note.noteId);
 f.reset();
 note = await f.save(note, empty);
 await f.execute(note.noteId);
 await f.assertEdit(note.noteId, empty, before, []);
 expect(await f.chunks(note.noteId)).toEqual([]);
 for (const mode of modes) expect((await f.query(note.noteId, 'basaltmeadow', mode)).results).toEqual([]);
 f.reset();
 await f.save(note, section('恢复', 'restoredkeyword 新内容。'));
 await f.execute(note.noteId);
 const after = await f.chunks(note.noteId);
 await f.assertEdit(note.noteId, section('恢复', 'restoredkeyword 新内容。'), [], after);
 if (real) await assertSearch(f, note.noteId, after, 'restoredkeyword', before);
}

async function searchDuringSync(f: EditFixture) {
 const note = await f.create(replaceBody);
 await f.execute(note.noteId);
 const before = await f.chunks(note.noteId);
 await assertSearch(f, note.noteId, before, 'alphaquartz');
 f.reset();
 const changed = replaceBody.replace('alphaquartz', 'fuchsiaquasar').replace('basaltmeadow', 'granitefable');
 await f.save(note, changed);
 for (const mode of modes) expect((await f.query(note.noteId, 'cedarwindow', mode)).results).toEqual([]);
 let observed = false;
 f.onWrite(async () => {
  if (f.written.length !== 2) return;
  const partial = await f.chunks(note.noteId);
  expect(partial.filter(row => row.index_status === 'pending')).toHaveLength(1);
  expect(partial.filter(row => row.index_status === 'ready')).toHaveLength(2);
  const ready = partial.filter(row => row.index_status === 'ready');
  await f.assertPoints(note.noteId, ready);
  for (const mode of modes) expect((await f.query(note.noteId, 'fuchsiaquasar', mode)).results).toEqual([]);
  observed = true;
 });
 await f.execute(note.noteId);
 expect(observed).toBe(true);
 expect(f.recall).not.toHaveBeenCalled();
 const after = await f.chunks(note.noteId);
 await f.assertEdit(note.noteId, changed, before, after);
 await assertSearch(f, note.noteId, after, 'granitefable', before.slice(0, 2));
 expect((await f.query(note.noteId, 'basaltmeadow', 'keyword')).results).toEqual([]);
}

describe('Note raw edit matrix', () => {
 it.each(deltaCases)('$name', test => inEditFixture(f => runEditCase(f, test)));
 it.each(['', '  ', '\n\n'])('E16 clears and restores %j', empty => inEditFixture(f => clearAndRestore(f, empty)));
 it('S09/S12 hides a queued and partially written Note in all three modes', () => inEditFixture(searchDuringSync));

 it.each(['中文', '😀', ''] as const)('E04 moves retained offsets by the UTF-16 delta for %j', start => inEditFixture(async f => {
  const raw = '开头句。\n\n' + replaceBody;
  const note = await f.create(raw);
  await f.execute(note.noteId);
  const before = await f.chunks(note.noteId);
  f.reset();
  const next = start ? start + raw : raw.slice(2);
  await f.save(note, next);
  await f.execute(note.noteId);
  const after = await f.chunks(note.noteId);
  await f.assertEdit(note.noteId, next, before, after);
  for (const old of before.slice(1)) {
   const shift = next.length - raw.length;
   expect(after.find(row => row.chunk_id === old.chunk_id)).toMatchObject({
    block_id: old.block_id, start_offset: old.start_offset + shift, end_offset: old.end_offset + shift,
    core_start: old.core_start + shift, core_end: old.core_end + shift,
   });
  }
 }));

 it.each([[0], [1], [2], [0, 1]].map(removed => ({ removed })))('E07/E08 deletes exactly whole sections $removed', ({ removed }) => inEditFixture(async f => {
  const note = await f.create(replaceBody);
  await f.execute(note.noteId);
  const before = await f.chunks(note.noteId);
  f.reset();
  const raw = oldSections.filter((_, index) => !removed.includes(index)).join('');
  await f.save(note, raw);
  await f.execute(note.noteId);
  const after = await f.chunks(note.noteId);
  await f.assertEdit(note.noteId, raw, before, after);
  expect(ids(after)).toEqual(ids(before.filter((_, index) => !removed.includes(index))));
  expect(f.written).toEqual([]);
 }));

 it.each([499, 500, 501])('E13 respects source limits at %i code points', length => inEditFixture(async f => {
  const note = await f.create('甲'.repeat(300));
  await f.execute(note.noteId);
  const before = await f.chunks(note.noteId);
  f.reset();
  const raw = '甲'.repeat(length - 1) + '😀';
  await f.save(note, raw);
  await f.execute(note.noteId);
  const after = await f.chunks(note.noteId);
  await f.assertEdit(note.noteId, raw, before, after);
  expect(after).toHaveLength(length <= 500 ? 1 : 2);
 }));

 it.each([[2, 0, 1], [0, 2, 1]])('E14 reorders intact sections %j without writing points', (...order) => inEditFixture(async f => {
  const note = await f.create(replaceBody);
  await f.execute(note.noteId);
  const before = await f.chunks(note.noteId);
  const raw = order.map(index => oldSections[index]).join('');
  f.reset();
  await f.save(note, raw);
  await f.execute(note.noteId);
  const after = await f.chunks(note.noteId);
  await f.assertEdit(note.noteId, raw, before, after);
  expect(after.map(row => [row.chunk_id, row.block_id])).toEqual(order.map(index => [before[index]!.chunk_id, before[index]!.block_id]));
 }));

 it('E15 keeps duplicate sections as distinct physical references', () => inEditFixture(async f => {
  const raw = replaceBody;
  let note = await f.create(raw);
  await f.execute(note.noteId);
  for (const next of [raw + oldSections[1]!, raw + oldSections[1]!.replace('basaltmeadow', 'duplicatechange'), raw]) {
   const before = await f.chunks(note.noteId);
   f.reset();
   note = await f.save(note, next);
   await f.execute(note.noteId);
   const after = await f.chunks(note.noteId);
   await f.assertEdit(note.noteId, next, before, after);
   expect(after).toHaveLength(next === raw ? 3 : 4);
  }
 }));

 it.each([
  ['M01 splits paragraphs', '开头正文。继续正文。', '开头正文。\n\n继续正文。'],
  ['M01 joins paragraphs', '开头正文。\n\n继续正文。', '开头正文。继续正文。'],
  ['M02 renames heading', '# 标题\n\n正文。', '# 改名\n\n正文。'],
  ['M02 changes heading level', '# 标题\n\n## 子节\n\n正文。', '# 标题\n\n### 子节\n\n正文。'],
  ['M02 removes heading', '# 标题\n\n正文。', '正文。'],
  ['M03 moves text to another heading', '# 甲\n\n被移动的句子。\n\n# 乙\n\n另一句。', '# 甲\n\n# 乙\n\n另一句。\n\n被移动的句子。'],
  ['M04 edits fenced code', '```md\n# 伪标题\n```', '```md\n# 新伪标题\n```'],
  ['M04 edits a list', '- # 伪标题\n  - 文本', '- # 新伪标题\n  - 文本'],
  ['M04 edits a quote', '> # 伪标题', '> # 新伪标题'],
  ['M06 changes image URL', '![图](https://example.test/old.png)', '![图](https://example.test/new.png)'],
  ['M06 changes link', '[参考](https://example.test/old)', '[参考](https://example.test/new)'],
  ['M06 changes attachment', '![图](asset://before)', '![图](asset://after)'],
  ['M07 edits combining marks and emoji', '混合 e\u0301👩‍💻 以前 😀。', '混合 e\u0300👩‍💻 现在 😀。'],
  ['M08 adds CRLF and whitespace', '中文\nEnglish\n结尾', ' \t中文\r\nEnglish\r\n结尾  '],
  ['M08 removes CRLF and whitespace', ' \t中文\r\nEnglish\r\n结尾  ', '中文\nEnglish\n结尾'],
 ])('%s', (name, beforeText, afterText) => inEditFixture(async f => {
  const tail = '\n\n' + section('固定尾部', 'cedarwindow。');
  const note = await f.create(beforeText + tail);
  await f.execute(note.noteId);
  const before = await f.chunks(note.noteId);
  f.reset();
  await f.save(note, afterText + tail);
  await f.execute(note.noteId);
  const after = await f.chunks(note.noteId);
  await f.assertEdit(note.noteId, afterText + tail, before, after);
  expect(after.at(-1)!.chunk_id).toBe(before.at(-1)!.chunk_id);
  if (name.startsWith('M04')) {
   const { rows: [row] } = await root.query('SELECT toc FROM note_index_jobs WHERE task_id=$1', [await f.task(note.noteId)]);
   expect(JSON.stringify(row.toc)).not.toContain('伪标题');
  }
  if (name.includes('URL') || name.includes('link')) expect(after[0]!.embedding_text).toBe(before[0]!.embedding_text);
 }));

 it.each(['title', 'folder', 'outline', 'germination', 'tags'] as const)('M09 ignores %s changes', field => inEditFixture(async f => {
  const note = await f.create(replaceBody);
  await f.execute(note.noteId);
  const before = await f.chunks(note.noteId);
  const firstTask = await f.task(note.noteId);
  f.reset();
  const { scope, workspaceId } = f.user;
  if (field === 'tags') {
   const tagState = await rawAssets.noteTags(scope, workspaceId, note.noteId);
   await rawAssets.addNoteTag(scope, workspaceId, note.noteId, '新标签', tagState.tagEtag, randomUUID());
  } else {
   const folder = field === 'folder' ? await rawAssets.createFolder(scope, workspaceId, { displayName: '新文件夹' }, randomUUID()) : undefined;
   const body = field === 'title' ? { title: '新标题' } : folder ? { folderId: folder.folderId } : { parts: { [field]: '非原文内容' } };
   await rawAssets.updateNote(scope, workspaceId, note.noteId, body, note.etag, randomUUID());
  }
  expect(await f.task(note.noteId)).toBe(firstTask);
  await f.assertEdit(note.noteId, replaceBody, before, await f.chunks(note.noteId));
 }));

 it('F08 reconstructs corrupt stored offsets and reuses the unchanged point', () => inEditFixture(async f => {
  const note = await f.create(replaceBody);
  await f.execute(note.noteId);
  const before = await f.chunks(note.noteId);
  await root.query('UPDATE document_ingestion_chunks SET end_offset=end_offset+1,core_end=core_end+1 WHERE chunk_id=$1', [before[1]!.chunk_id]);
  const raw = replaceBody.replace('alphaquartz', 'neworiginal');
  f.reset();
  await f.save(note, raw);
  await f.execute(note.noteId);
  const after = await f.chunks(note.noteId);
  await f.assertEdit(note.noteId, raw, before, after);
  expect(ids(after.slice(1))).toEqual(ids(before.slice(1)));
 }));

 it('F09 accepts exactly the configured input limit and rejects the next code point atomically', () => inEditFixture(async f => {
  const raw = '甲'.repeat(editConfig.rag.plainTextMaxChars - 1) + '😀';
  const note = await f.create(raw);
  await f.execute(note.noteId);
  const before = await f.chunks(note.noteId), initial = await f.task(note.noteId);
  assertOffsets(raw, before);
  f.reset();
  await expect(f.save(note, raw + '新')).rejects.toMatchObject({ statusCode: 413, code: 'RAG_PLAIN_TEXT_TOO_LARGE' });
  expect(await f.task(note.noteId)).toBe(initial);
  expect((await rawAssets.notePart(f.user.scope, f.user.workspaceId, note.noteId, 'raw')).contentMarkdown).toBe(raw);
  await f.assertEdit(note.noteId, raw, before, await f.chunks(note.noteId));
 }));

 it('S01 deduplicates an HTTP save replay and rejects duplicate task claims', () => inEditFixture(async f => {
  const note = await f.create(replaceBody);
  await f.execute(note.noteId);
  const before = await f.chunks(note.noteId);
  f.reset();
  const raw = replaceBody.replace('alphaquartz', 'replayed'), key = randomUUID();
  const app = await buildApiServer({ config: editConfig });
  try {
   const request = { method: 'PATCH' as const, url: `/api/v1/workspaces/${f.user.workspaceId}/notes/${note.noteId}`,
    headers: { authorization: `Bearer ${f.user.bearer}`, 'x-idempotency-key': key, 'if-match': note.etag }, payload: { parts: { raw } } };
   const first = await app.inject(request), replay = await app.inject(request);
   expect(first.statusCode, first.body).toBe(200);
   expect(replay.json().data).toEqual(first.json().data);
   const job = await f.task(note.noteId);
   const { rows: deliveries } = await root.query<Delivery>(`SELECT o.id,o.task_id,t.queue,o.attempts FROM task_outbox o
     JOIN tasks t ON t.id=o.task_id WHERE o.task_id=$1`, [job]);
   expect(deliveries).toHaveLength(1);
   const delivery = deliveries[0]!;
   const publisher = new QueuePublisher(editWorker);
   const run = f.indexing.execute.bind(f.indexing);
   const workerExecute = vi.spyOn(ManualTextIngestionJobs.prototype, 'execute').mockImplementation(run);
   const workers = new TaskWorkers(workerPool, editWorker);
   try {
    const queue = publisher.queues.get('content')!;
    await queue.waitUntilReady();
    const duplicate = { ...delivery, id: randomUUID() };
    await Promise.all([publisher.publish(delivery), publisher.publish(duplicate)]);
    await vi.waitFor(async () => {
     expect(await queue.getJobState(delivery.id)).toBe('completed');
     expect(await queue.getJobState(duplicate.id)).toBe('completed');
    }, { timeout: 3000, interval: 50 });
    expect(workerExecute).toHaveBeenCalledTimes(1);
    expect((await root.query('SELECT count(*)::int n FROM task_results WHERE task_id=$1', [job])).rows[0].n).toBe(1);
   } finally {
    await workers.close();
    workerExecute.mockRestore();
    await publisher.close();
   }
   expect((await root.query('SELECT count(*)::int n FROM note_index_jobs WHERE document_id=$1', [note.noteId])).rows[0].n).toBe(2);
   await f.assertEdit(note.noteId, raw, before, await f.chunks(note.noteId));
  } finally { await app.close(); }
 }));

 it('S02 indexes the last accepted save and rejects a concurrent stale etag', () => inEditFixture(async f => {
  let note = await f.create(replaceBody);
  await f.execute(note.noteId);
  const before = await f.chunks(note.noteId);
  f.reset();
  // A stepped-back database clock must not sort the completed job ahead of later saves.
  await root.query("UPDATE note_index_jobs SET created_at=clock_timestamp()+interval '1 hour' WHERE task_id=$1", [await f.task(note.noteId)]);
  const stale: string[] = [];
  for (const replacement of ['pendingfirst', 'pendingsecond', 'pendingthird']) {
   note = await f.save(note, replaceBody.replace('alphaquartz', replacement));
   stale.push(await f.task(note.noteId));
  }
  const changes = ['windowone', 'windowtwo'];
  const edits = await Promise.allSettled(changes.map(value => f.save(note, replaceBody.replace('alphaquartz', value))));
  expect(edits.filter(edit => edit.status === 'fulfilled')).toHaveLength(1);
  expect(edits.find(edit => edit.status === 'rejected')).toMatchObject({ reason: { statusCode: 412 } });
  for (const taskId of stale) await expect(f.indexing.execute(await f.claim(taskId))).rejects.toMatchObject({ code: 'INGEST_SOURCE_SUPERSEDED' });
  await f.execute(note.noteId);
  const raw = replaceBody.replace('alphaquartz', changes[edits.findIndex(edit => edit.status === 'fulfilled')]!);
  await f.assertEdit(note.noteId, raw, before, await f.chunks(note.noteId));
 }));

 it('S04 undo before indexing does no vector work; completed undo and redo reconcile IDs', () => inEditFixture(async f => {
  let note = await f.create(replaceBody);
  await f.execute(note.noteId);
  const changed = replaceBody.replace('alphaquartz', 'undoredo');
  const old = await f.chunks(note.noteId);
  f.reset();
  note = await f.save(note, changed);
  const undoneTask = await f.task(note.noteId);
  note = await f.save(note, replaceBody);
  await expect(f.indexing.execute(await f.claim(undoneTask))).rejects.toMatchObject({ code: 'INGEST_SOURCE_SUPERSEDED' });
  await f.execute(note.noteId);
  await f.assertEdit(note.noteId, replaceBody, old, await f.chunks(note.noteId));
  expect(f.written).toEqual([]);
  for (const raw of [changed, replaceBody, changed]) {
   const before = await f.chunks(note.noteId);
   f.reset();
   note = await f.save(note, raw);
   await f.execute(note.noteId);
   await f.assertEdit(note.noteId, raw, before, await f.chunks(note.noteId));
  }
 }));

 it.each(['embedding', 'upsert', 'ack', 'postgres', 'delete'] as const)('S05–S07 resumes exact plan after %s failure', failure => inEditFixture(async f => {
  const note = await f.create(replaceBody);
  await f.execute(note.noteId);
  const before = await f.chunks(note.noteId);
  f.reset();
  const raw = replaceBody.replace('alphaquartz', 'fuchsiaquasar').replace('basaltmeadow', 'granitefable');
  await f.save(note, raw);
  const attempt = await f.claim(await f.task(note.noteId));
  let injected = false;
  const error = new MilvusError('TEST_RETRYABLE', 'injected transient failure');
  if (failure === 'embedding') f.embedding.mockRejectedValueOnce(error);
  if (failure === 'upsert' || failure === 'ack') {
   const once = async () => { if (!injected && f.written.length === 2) { injected = true; throw error; } };
   if (failure === 'upsert') f.onWrite(once); else f.onWritten(once);
  }
  if (failure === 'delete') f.onDelete(async () => { throw error; });
  if (failure === 'postgres') {
   f.onWritten(async () => {
    if (injected || f.written.length !== 2) return;
    injected = true;
    // Reject this Note's PG acknowledgement after the adapter accepted the point.
    await root.query(`ALTER TABLE document_ingestion_chunks ADD CONSTRAINT test_reject_point_confirmation
      CHECK (document_id <> '${note.noteId}'::uuid OR chunk_index <> 1 OR index_status <> 'ready') NOT VALID`);
   });
  }
  try {
   await expect(f.indexing.execute(attempt)).rejects.toMatchObject({ code: failure === 'delete' ? 'INGEST_CLEANUP_FAILED'
    : failure === 'postgres' ? '23514' : 'INGEST_INDEX_PARTIAL_FAILURE' });
  } finally {
   f.onDelete();
   if (failure === 'postgres') await root.query('ALTER TABLE document_ingestion_chunks DROP CONSTRAINT IF EXISTS test_reject_point_confirmation');
  }
  const staged = await f.chunks(note.noteId);
  const ready = staged.filter(row => row.index_status === 'ready');
  const nextAttempt = await f.retry(attempt, 'TEST_RETRYABLE');
  f.reset();
  await f.finish(nextAttempt);
  const after = await f.chunks(note.noteId);
  expect(ids(after)).toEqual(ids(staged));
  expect(sorted(f.written)).toEqual(sorted(ids(staged).filter(id => !ids(ready).includes(id))));
  expect(sorted(f.deleted)).toEqual(failure === 'delete' ? sorted(ids(before.slice(0, 2))) : []);
  expect(sorted(f.embedding.mock.calls.flatMap(([texts]) => texts))).toEqual(sorted(after.filter(row => f.written.includes(row.chunk_id)).map(row => row.embedding_text)));
  assertOffsets(raw, after);
  await f.assertPoints(note.noteId, after);
  await assertSearch(f, note.noteId, after, 'granitefable', before.slice(0, 2));
 }));

 it('S09 discards a reused hit if a save commits while Milvus recall is in flight', () => inEditFixture(async f => {
  const note = await f.create(replaceBody);
  await f.execute(note.noteId);
  const raw = replaceBody.replace('basaltmeadow', 'duringrecall');
  let fired = false;
  f.onRecall(async () => { fired = true; await f.save(note, raw); });
  expect((await f.query(note.noteId, 'cedarwindow', 'keyword')).results).toEqual([]);
  expect(fired).toBe(true);
  f.onRecall();
  await f.execute(note.noteId);
  await assertSearch(f, note.noteId, await f.chunks(note.noteId), 'duringrecall');
 }));

 it('E12 reindexes the following chunk when only its overlap changes', () => inEditFixture(async f => {
  const assets = alternateAssets({ MANUAL_TEXT_OVERLAP_TOKENS: '12' });
  const raw = '短句子。'.repeat(145);
  const note = await f.create(raw, assets);
  await f.execute(note.noteId);
  const before = await f.chunks(note.noteId);
  const following = before.find(row => row.start_offset < row.core_start)!;
  expect(following).toBeTruthy();
  const next = patch(raw, following.core_start - 2, following.core_start - 1, '改');
  f.reset();
  await f.save(note, next, assets);
  await f.execute(note.noteId);
  const after = await f.chunks(note.noteId);
  await f.assertEdit(note.noteId, next, before, after);
  const newFollowing = after.find(row => row.core_start === following.core_start)!;
  expect(next.slice(newFollowing.core_start, newFollowing.core_end)).toBe(raw.slice(following.core_start, following.core_end));
  expect(newFollowing.block_id).toBe(following.block_id);
  expect(newFollowing.embedding_text).not.toBe(following.embedding_text);
  expect(f.deleted).toContain(following.chunk_id);
  expect(f.written).toContain(newFollowing.chunk_id);
 }));

 it.each(['header', 'cell'] as const)('M05 updates a long table %s and preserves the following section', edit => inEditFixture(async f => {
  const table = '| 列甲 | 列乙 |\n| --- | --- |\n' + Array.from({ length: 65 }, (_, index) => `| 内容编号${index} | ${'详情'.repeat(10)} |\n`).join('');
  const suffix = '\n' + section('表格外', 'outsidekeyword。');
  const note = await f.create(table + suffix);
  await f.execute(note.noteId);
  const before = await f.chunks(note.noteId);
  expect(before.length).toBeGreaterThan(3);
  const next = (edit === 'header' ? table.replace('列甲', '新列') : table.replace('内容编号10', '更新编号10')) + suffix;
  f.reset();
  await f.save(note, next);
  await f.execute(note.noteId);
  const after = await f.chunks(note.noteId);
  await f.assertEdit(note.noteId, next, before, after);
  expect(after.at(-1)!.chunk_id).toBe(before.at(-1)!.chunk_id);
  if (edit === 'header') {
   for (const row of before.filter(row => row.embedding_text.includes('列甲'))) expect(f.deleted).toContain(row.chunk_id);
  } else {
   expect(f.deleted).toEqual(ids(before.filter(row => row.text.includes('内容编号10 '))));
  }
 }));

 it.each(['embedding', 'second batch'] as const)('S03 converges after another save during %s', timing => inEditFixture(async f => {
  const note = await f.create(replaceBody);
  await f.execute(note.noteId);
  const old = await f.chunks(note.noteId);
  const intermediate = replaceBody.replace('alphaquartz', 'supersededfirst').replace('basaltmeadow', 'supersededsecond');
  const latest = replaceBody.replace('alphaquartz', 'acceptedfirst');
  const edited = await f.save(note, intermediate);
  const stale = await f.claim(await f.task(note.noteId));
  f.reset();
  let fired = false;
  const saveLatest = async () => { fired = true; await f.save(edited, latest); };
  if (timing === 'second batch') {
   f.onWrite(async () => { if (f.written.length === 2) await saveLatest(); });
  } else {
   const original = f.embedding.getMockImplementation()!;
   f.embedding.mockImplementationOnce(async texts => { await saveLatest(); return original.call(new DeterministicEmbeddingClient(8), texts); });
  }
  await expect(f.indexing.execute(stale)).rejects.toMatchObject({ code: 'INGEST_SOURCE_SUPERSEDED' });
  expect(fired).toBe(true);
  expect((await f.query(note.noteId, 'cedarwindow', 'keyword')).results).toEqual([]);
  expect(await editEngine.fail(stale, 'INGEST_SOURCE_SUPERSEDED', false)).toBe(true);
  f.onWrite();
  const staged = await f.chunks(note.noteId);
  f.reset();
  await f.execute(note.noteId);
  const after = await f.chunks(note.noteId);
  await f.assertEdit(note.noteId, latest, staged, after);
  expect(after.at(-1)!.chunk_id).toBe(old.at(-1)!.chunk_id);
  await assertSearch(f, note.noteId, after, 'acceptedfirst', staged.slice(0, 2));
 }));

 it('S08 waits for a timed-out write before a successor can retire its ID', () => inEditFixture(async f => {
  let note = await f.create(replaceBody);
  await f.execute(note.noteId);
  const original = await f.chunks(note.noteId);
  const middleRaw = replaceBody.replace('alphaquartz', 'latekeyword');
  const latest = replaceBody.replace('alphaquartz', 'successorkeyword');
  note = await f.save(note, middleRaw);
  const task = await f.task(note.noteId);
  await root.query("UPDATE note_index_jobs SET processing_snapshot=jsonb_set(processing_snapshot,'{indexing,timeoutMs}','100') WHERE task_id=$1", [task]);
  const stale = await f.claim(task);
  f.reset();
  const entered = latch(), release = latch();
  f.onWrite(async () => { if (f.written.length === 1) { entered.resolve(); await release.promise; } });
  const late = f.indexing.execute(stale).then(() => null, (error: unknown) => error);
  let next: Promise<void> | undefined;
  try {
   await entered.promise;
   const lateId = f.written[0]!;
   note = await f.save(note, latest);
   await root.query("UPDATE tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [stale.task.id]);
   next = f.execute(note.noteId);
   void next.catch(() => undefined);
   await delay(220);
   expect(f.deleted).not.toContain(lateId);
   expect((await f.query(note.noteId, 'latekeyword', 'keyword')).results).toEqual([]);
   release.resolve();
   expect(await late).toMatchObject({ code: 'INGEST_SOURCE_SUPERSEDED' });
   expect(await editEngine.finish(stale, 'invalid-old-result', 0)).toBe(false);
   await next;
   const after = await f.chunks(note.noteId);
   expect(f.deleted).toContain(lateId);
   expect(after.slice(1).map(row => row.chunk_id)).toEqual(ids(original.slice(1)));
   expect(f.stored.has(lateId)).toBe(false);
   assertOffsets(latest, after);
   await f.assertPoints(note.noteId, after);
   await assertSearch(f, note.noteId, after, 'successorkeyword');
  } finally { release.resolve(); await Promise.allSettled([late, next]); }
 }));

 it('S08 recovers an abandoned Worker attempt with the same saved plan', () => inEditFixture(async f => {
  const note = await f.create(replaceBody);
  await f.execute(note.noteId);
  const raw = replaceBody.replace('alphaquartz', 'recoverfirst').replace('basaltmeadow', 'recoversecond');
  await f.save(note, raw);
  const taskId = await f.task(note.noteId), abandoned = await f.claim(taskId);
  f.reset();
  f.onWrite(async () => { if (f.written.length === 2) throw new MilvusError('WORKER_INTERRUPTED', 'injected'); });
  await expect(f.indexing.execute(abandoned)).rejects.toMatchObject({ code: 'INGEST_INDEX_PARTIAL_FAILURE' });
  const staged = await f.chunks(note.noteId);
  const pending = staged.filter(row => row.index_status !== 'ready');
  await root.query("UPDATE tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [taskId]);
  await new TaskScheduler(root, { async publish() {} }).recover();
  await expect(f.indexing.execute(abandoned)).rejects.toMatchObject({ code: 'INGEST_SOURCE_SUPERSEDED' });
  f.onWrite();
  f.reset();
  await f.finish(await f.claim(taskId));
  const after = await f.chunks(note.noteId);
  expect(ids(after)).toEqual(ids(staged));
  expect(f.written).toEqual(ids(pending));
  expect(f.deleted).toEqual([]);
  assertOffsets(raw, after);
  await f.assertPoints(note.noteId, after);
 }));

 it('S09 discards hits when the Note is saved during reranking', () => inEditFixture(async f => {
  const note = await f.create(replaceBody);
  await f.execute(note.noteId);
  const raw = replaceBody.replace('basaltmeadow', 'duringrerank');
  f.onRerank(async () => { await f.save(note, raw); });
  expect((await f.query(note.noteId, 'cedarwindow', 'keyword')).results).toEqual([]);
  f.onRerank();
  await f.execute(note.noteId);
  await assertSearch(f, note.noteId, await f.chunks(note.noteId), 'duringrerank');
 }));

 it.each(['clear', 'delete'] as const)('S10 removes partially written points after a concurrent %s', operation => inEditFixture(async f => {
  const note = await f.create(replaceBody);
  await f.execute(note.noteId);
  const edited = await f.save(note, replaceBody.replace('alphaquartz', 'staleone').replace('basaltmeadow', 'staletwo'));
  const attempt = await f.claim(await f.task(note.noteId));
  f.reset();
  f.onWrite(async () => {
   if (f.written.length !== 2) return;
   if (operation === 'clear') await f.save(edited, '');
   else await rawAssets.deleteNote(f.user.scope, f.user.workspaceId, note.noteId, edited.etag, randomUUID());
  });
  await expect(f.indexing.execute(attempt)).rejects.toMatchObject({ code: 'INGEST_SOURCE_SUPERSEDED' });
  const staged = await f.chunks(note.noteId);
  f.reset();
  if (operation === 'clear') await f.execute(note.noteId);
  else {
   const { rows: [task] } = await root.query("SELECT id FROM tasks WHERE kind='document.text-cleanup' AND user_id=$1", [f.user.scope.userId]);
   await f.finish(await f.claim(task.id), true);
  }
  await f.assertEdit(note.noteId, '', staged, await f.chunks(note.noteId));
  expect(f.stored.size).toBe(0);
  for (const mode of modes) expect((await f.query(note.noteId, 'staleone', mode)).results).toEqual([]);
 }));

 it.each(['same', 'different'] as const)('S11 isolates concurrent edits in %s workspaces', relation => inEditFixture(async f => {
  const noteA = await f.create(replaceBody);
  const workspaceB = relation === 'same' ? f.user.workspaceId : randomUUID();
  if (relation === 'different') await root.query("INSERT INTO workspaces(id,user_id,display_name,bootstrap_receipt_id) VALUES($1,$2,'second',$3)", [workspaceB, f.user.scope.userId, randomUUID()]);
  const noteB = await rawAssets.createNote(f.user.scope, workspaceB, { title: 'Note B', parts: { raw: replaceBody } }, randomUUID());
  const taskB = async () => (await root.query("SELECT task_id FROM note_index_jobs WHERE document_id=$1 ORDER BY created_at DESC,idempotency_key DESC LIMIT 1", [noteB.noteId])).rows[0].task_id as string;
  await f.execute(noteA.noteId);
  await f.finish(await f.claim(await taskB()));
  const rowsB = async () => (await root.query<ChunkRow>('SELECT * FROM document_ingestion_chunks WHERE document_id=$1 ORDER BY chunk_index', [noteB.noteId])).rows;
  const beforeA = await f.chunks(noteA.noteId), beforeB = await rowsB();
  expect(ids(beforeA).some(id => ids(beforeB).includes(id))).toBe(false);
  const unrelated = { ...f.stored.get(beforeA[0]!.chunk_id)!, id: 'unrelated-knowledge', metadata: { parent_id: randomUUID(), source_type: 'file' } };
  f.stored.set(unrelated.id, unrelated);
  f.reset();
  const nextA = replaceBody.replace('alphaquartz', 'firstnote');
  const nextB = replaceBody.replace('basaltmeadow', 'secondnote');
  await Promise.all([f.save(noteA, nextA), rawAssets.updateNote(f.user.scope, workspaceB, noteB.noteId, { parts: { raw: nextB } }, noteB.etag, randomUUID())]);
  await Promise.all([f.execute(noteA.noteId), f.claim(await taskB()).then(attempt => f.finish(attempt))]);
  const afterA = await f.chunks(noteA.noteId), afterB = await rowsB();
  expect(sorted(f.written)).toEqual(sorted([afterA[0]!.chunk_id, afterB[1]!.chunk_id]));
  expect(sorted(f.deleted)).toEqual(sorted([beforeA[0]!.chunk_id, beforeB[1]!.chunk_id]));
  expect(f.stored.get(unrelated.id)).toBe(unrelated);
  assertOffsets(nextA, afterA);
  assertOffsets(nextB, afterB);
  await f.assertPoints(noteA.noteId, afterA);
  await f.assertPoints(noteB.noteId, afterB);
  await assertSearch(f, noteA.noteId, afterA, 'firstnote');
  await assertSearch(f, noteB.noteId, afterB, 'secondnote');
 }));
});

describe.runIf(!!milvusAddress)('Note edit matrix with isolated real Milvus', () => {
 const half = deltaCases.find(test => test.name === 'E03 half deletion from back')!;
 const cross = deltaCases.find(test => test.name === 'E10 cross-boundary replacement 1')!;
 const large = deltaCases.find(test => test.name.startsWith('F01'))!;
 const halfBody = patch(patch(longBody, 910, 930, ' halfobsolete '), 540, 560, ' halfremaining ');
 it('E03 half deletion keeps the remaining keyword and retires the removed one', () => inEditFixture(f => runEditCase(f, half, {
  original: matrixRaw.replace(longBody, halfBody), hit: 'halfremaining', retired: 'halfobsolete',
 }), true), 60000);
 it('E10 cross-boundary replacement returns the new keyword in all recall modes', () => inEditFixture(f => runEditCase(f, {
  ...cross, next: (raw, rows) => cross.next(raw, rows).replace('短文', ' xqmark '),
 }, { hit: 'xqmark' }), true), 60000);
 it('F01 fallback indexes the new chapter and preserves end points', () => inEditFixture(f => runEditCase(f, {
  ...large, next: raw => large.next(raw, []).replace('丁'.repeat(20), ' changedchapter '),
 }, { hit: 'changedchapter' }), true), 60000);
 it('E16 clears physical points and restores all recall modes', () => inEditFixture(f => clearAndRestore(f, '', true), true), 60000);
 it('S09/S12 hides a partially written Note while ready points are physically present', () => inEditFixture(searchDuringSync, true), 60000);
});
