import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildApiServer} from '../../src/apps/api-server.js';
import {insertFixtureUser,insertFixtureSession,testJwtEnv} from './jwt-fixture.js';
import { fixtureScopeHeaders } from './jwt-fixture.js';
import type {TagExtractor} from '../../src/modules/assets/tag-extractor.js';
import {loadConfig} from '../../src/config/config.js';
import {poolFor} from '../../src/plugins/dependencies.js';
import {migrate} from '../../src/db/migrate.js';
import {AssetService} from '../../src/modules/assets/service.js';
import {DeterministicTagExtractor} from '../../src/modules/assets/tag-extractor.js';
import {TaskEngine} from '../../src/modules/tasks/engine.js';
import {TaskService} from '../../src/modules/tasks/service.js';
type GraphEdge={source:string;target:string;relationType:string;evidence?:{sharedTags?:Array<{tagName:string}>}};const edgeList=(graph:{edges:readonly unknown[]})=>graph.edges as GraphEdge[];
const migrationUrl=process.env.TEST_DATABASE_MIGRATION_URL;if(!migrationUrl)throw new Error('TEST_DB_REQUIRED');
const root=poolFor(loadConfig('migrate',{...process.env,APP_ENV:'test',DATABASE_URL:migrationUrl}));const cfg=loadConfig('api-server',{...process.env,...testJwtEnv,APP_ENV:'test',LOG_LEVEL:'silent',APP_TOKEN_SECRET:'asset-test-'.repeat(8),APP_PUBLIC_BASE_URL:'http://assets.test',DATABASE_URL:process.env.TEST_DATABASE_API_URL});const pool=poolFor(cfg),worker=poolFor({...cfg,role:'worker',databaseUrl:process.env.TEST_DATABASE_WORKER_URL!});const assets=new AssetService(pool,cfg.appTokenSecret!);const engine=new TaskEngine(worker,15000,undefined,undefined,new DeterministicTagExtractor());
async function fixture(){
 const userId=await insertFixtureUser(root),sessionId=randomUUID(),workspaceId=randomUUID();
 const bearer=await insertFixtureSession(root,userId,sessionId,'fixture-fixture');
 await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'fixture',true,$3)",[workspaceId,userId,randomUUID()]);
 return {userId,workspaceId,bearer,scope:{userId,sessionId,traceId:randomUUID()}};
}
async function makeNote(u:Awaited<ReturnType<typeof fixture>>){return assets.createNote(u.scope,u.workspaceId,{title:'素材',parts:{raw:'正文 alpha'}},randomUUID());}
async function jobFor(noteId:string){return String((await root.query('SELECT task_id FROM content_jobs WHERE note_id=$1',[noteId])).rows[0].task_id);}
describe('P06 personal assets, revisions and search',()=>{beforeAll(()=>migrate(loadConfig('migrate',{...process.env,APP_ENV:'test',DATABASE_URL:migrationUrl})));afterAll(async()=>{await Promise.all([pool.end(),root.end(),worker.end()]);});
it('creates Note tag jobs alongside plain-text task inputs under hash-join query plans',async()=>{
 const f=await fixture(),isolated=poolFor({...cfg,poolMax:1});
 try{
  // One connection keeps these planner settings local to this test's service.
  await isolated.query("SELECT set_config('enable_nestloop','off',false),set_config('enable_mergejoin','off',false)");
  const text='plain task input is not JSON';
  const plain=await new TaskService(isolated,cfg.appTokenSecret!).create(f.scope,{workspaceId:f.workspaceId,text},randomUUID());
  const note=await new AssetService(isolated,cfg.appTokenSecret!).createNote(f.scope,f.workspaceId,{title:'mixed task inputs',parts:{raw:'readable Note body'}},randomUUID());
  expect(note.parts.raw!.contentMarkdown).toBe('readable Note body');
  expect((await root.query('SELECT count(*)::int n FROM content_jobs WHERE note_id=$1',[note.noteId])).rows[0].n).toBe(1);
  expect((await root.query('SELECT i.body FROM task_inputs i JOIN tasks t ON t.input_id=i.id WHERE t.id=$1',[plain.task.taskId])).rows[0].body).toBe(text);
 }finally{await isolated.end();}
});
it('validates folder, Note and tag relationship targets within the owning workspace',async()=>{
 const a=await fixture(),b=await fixture(),noteA=await makeNote(a),noteB=await makeNote(b);
 const foreignFolder=await assets.createFolder(b.scope,b.workspaceId,{displayName:'foreign'},randomUUID());
 await expect(assets.createFolder(a.scope,a.workspaceId,{displayName:'missing parent',parentFolderId:randomUUID()},randomUUID())).rejects.toMatchObject({code:'PARENT_FOLDER_NOT_FOUND'});
 await expect(assets.createNote(a.scope,a.workspaceId,{title:'foreign folder',folderId:foreignFolder.folderId,parts:{raw:'body'}},randomUUID())).rejects.toMatchObject({code:'FOLDER_NOT_FOUND'});
 await expect(assets.createRelation(a.scope,a.workspaceId,noteA.noteId,{targetNoteId:noteB.noteId,relationType:'references',rationale:'foreign'},randomUUID())).rejects.toMatchObject({code:'NOTE_NOT_FOUND'});
 await expect(assets.createRelation(a.scope,a.workspaceId,noteA.noteId,{targetNoteId:randomUUID(),relationType:'references',rationale:'absent'},randomUUID())).rejects.toMatchObject({code:'NOTE_NOT_FOUND'});
 const tagsB=await assets.addNoteTag(b.scope,b.workspaceId,noteB.noteId,'foreign label',`"tags-${noteB.noteId}-0"`,randomUUID());
 await expect(assets.removeNoteTag(a.scope,a.workspaceId,noteA.noteId,tagsB.tags[0]!.tagId,`"tags-${noteA.noteId}-0"`,randomUUID())).rejects.toMatchObject({code:'TAG_NOT_FOUND'});
 expect((await root.query('SELECT count(*)::int n FROM note_relations WHERE source_note_id=$1',[noteA.noteId])).rows[0].n).toBe(0);
 expect((await assets.noteTags(b.scope,b.workspaceId,noteB.noteId)).tags).toHaveLength(1);
});
it('soft deletion preserves revisions, labels and explicit relationships for restoration',async()=>{
 const u=await fixture(),source=await makeNote(u),target=await makeNote(u);
 const tags=await assets.addNoteTag(u.scope,u.workspaceId,source.noteId,'retained',`"tags-${source.noteId}-0"`,randomUUID());
 const relation=await assets.createRelation(u.scope,u.workspaceId,source.noteId,{targetNoteId:target.noteId,relationType:'references',rationale:'retain'},randomUUID());
 await assets.deleteNote(u.scope,u.workspaceId,source.noteId,source.etag,randomUUID());
 expect((await root.query('SELECT count(*)::int n FROM note_part_revisions WHERE note_id=$1',[source.noteId])).rows[0].n).toBe(3);
 expect((await root.query('SELECT count(*)::int n FROM note_tags WHERE note_id=$1 AND tag_id=$2',[source.noteId,tags.tags[0]!.tagId])).rows[0].n).toBe(1);
 expect((await root.query('SELECT count(*)::int n FROM note_relations WHERE relation_id=$1',[relation.relationId])).rows[0].n).toBe(1);
 const deleted=await assets.getNote(u.scope,u.workspaceId,source.noteId);
 await assets.deleteNote(u.scope,u.workspaceId,source.noteId,deleted.etag,randomUUID(),true);
 expect((await assets.getNote(u.scope,u.workspaceId,source.noteId)).parts.raw!.contentMarkdown).toBe('正文 alpha');
 expect((await assets.noteTags(u.scope,u.workspaceId,source.noteId)).tags).toHaveLength(1);
});
it('folders enforce scope, duplicate names, cycles and ETags',async()=>{const u=await fixture();const f=await assets.createFolder(u.scope,u.workspaceId,{displayName:'资料'},randomUUID());await expect(assets.createFolder(u.scope,u.workspaceId,{displayName:'资料'},randomUUID())).rejects.toMatchObject({code:'FOLDER_NAME_CONFLICT'});const child=await assets.createFolder(u.scope,u.workspaceId,{displayName:'子',parentFolderId:f.folderId},randomUUID());await expect(assets.moveFolder(u.scope,u.workspaceId,f.folderId,child.folderId,f.etag,randomUUID())).rejects.toMatchObject({code:'FOLDER_CYCLE'});await expect(assets.updateFolder(u.scope,u.workspaceId,f.folderId,'x','bad-etag',randomUUID())).rejects.toMatchObject({statusCode:412});});
it('keeps original text on tag task failure/stale revision and returns extracted tags for current revision',async()=>{const u=await fixture();const n=await assets.createNote(u.scope,u.workspaceId,{title:'中文项目 Alpha',parts:{raw:'这是一个中文项目笔记 with mixed English',outline:'',germination:''}},randomUUID());const changed=await assets.updateNote(u.scope,u.workspaceId,n.noteId,{parts:{raw:'最新内容 beta'}},n.etag,randomUUID());const task=(await root.query("SELECT task_id FROM content_jobs WHERE note_id=$1 AND note_revision_id=$2",[n.noteId,n.noteRevisionId])).rows[0];const stale=await vi.waitFor(async()=>{const attempt=await engine.claim(task.task_id,randomUUID());expect(attempt).not.toBeNull();return attempt!;},{timeout:3000,interval:20});await engine.execute(stale!);const tags=(await root.query('SELECT count(*)::int n FROM note_tags WHERE note_id=$1',[n.noteId])).rows[0].n;expect(tags).toBe(0);const task2=(await root.query("SELECT task_id FROM content_jobs WHERE note_id=$1 AND note_revision_id=$2",[n.noteId,changed.noteRevisionId])).rows[0];const current=await vi.waitFor(async()=>{const attempt=await engine.claim(task2.task_id,randomUUID());expect(attempt).not.toBeNull();return attempt!;},{timeout:3000,interval:20});await engine.execute(current);expect((await root.query('SELECT count(*)::int n FROM note_tags WHERE note_id=$1',[n.noteId])).rows[0].n).toBeGreaterThan(0);expect((await assets.getNote(u.scope,u.workspaceId,n.noteId)).parts.raw!.contentMarkdown).toBe('最新内容 beta');});
it('imports text/markdown and fails closed for unsupported document payloads',async()=>{const u=await fixture();const ready=await assets.importNote(u.scope,u.workspaceId,{title:'导入',mimeType:'text/markdown',content:'# 标题\n正文'},randomUUID());expect(ready.status).toBe('ready');const pending=await assets.importNote(u.scope,u.workspaceId,{title:'扫描件',mimeType:'application/pdf',},randomUUID());expect(pending.status).toBe('needs-processing');});
it('content navigation and explicit relations expose evidence-based graph edges',async()=>{const u=await fixture();const a=await assets.createNote(u.scope,u.workspaceId,{title:'A',parts:{raw:'alpha',outline:'',germination:''}},randomUUID());const b=await assets.createNote(u.scope,u.workspaceId,{title:'B',parts:{raw:'beta',outline:'',germination:''}},randomUUID());const rel=await assets.createRelation(u.scope,u.workspaceId,a.noteId,{targetNoteId:b.noteId,relationType:'references',rationale:'explicit source'},randomUUID());expect(rel.origin).toBe('explicit');expect((await assets.noteRelations(u.scope,u.workspaceId,a.noteId)).items).toHaveLength(1);expect((await assets.navigation(u.scope,u.workspaceId,'graph')).nodes.length).toBeGreaterThanOrEqual(2);});
it('uses only effective tags for graph edges and keeps other notes unchanged after removal',async()=>{const u=await fixture();const a=await assets.createNote(u.scope,u.workspaceId,{title:'A',parts:{raw:'alpha',outline:'',germination:''}},randomUUID());const b=await assets.createNote(u.scope,u.workspaceId,{title:'B',parts:{raw:'beta',outline:'',germination:''}},randomUUID());const c=await assets.createNote(u.scope,u.workspaceId,{title:'C',parts:{raw:'gamma',outline:'',germination:''}},randomUUID());const at=await assets.replaceNoteTags(u.scope,u.workspaceId,a.noteId,['AI','内容创作'],`"tags-${a.noteId}-0"`,randomUUID());const bt=await assets.replaceNoteTags(u.scope,u.workspaceId,b.noteId,['内容创作','短视频'],`"tags-${b.noteId}-0"`,randomUUID());await assets.replaceNoteTags(u.scope,u.workspaceId,c.noteId,['旅行'],`"tags-${c.noteId}-0"`,randomUUID());let graph=await assets.navigation(u.scope,u.workspaceId,'graph',{maxNodes:20,maxEdges:20});const shared=edgeList(graph).find(edge=>edge.relationType==='co_tagged'&&edge.evidence?.sharedTags?.some(tag=>tag.tagName==='内容创作'));expect(shared).toBeTruthy();expect(edgeList(graph).some(edge=>edge.relationType==='co_tagged'&&(edge.source===a.noteId&&edge.target===c.noteId||edge.source===c.noteId&&edge.target===a.noteId))).toBe(false);const sharedTag=at.tags.find(x=>x.displayName==='内容创作')!;const after=await assets.removeNoteTag(u.scope,u.workspaceId,a.noteId,sharedTag.tagId,at.tagEtag,randomUUID());expect(after.tags.map(x=>x.displayName)).toEqual(['AI']);graph=await assets.navigation(u.scope,u.workspaceId,'graph',{maxNodes:20,maxEdges:20});expect(edgeList(graph).some(edge=>edge.relationType==='co_tagged'&&edge.evidence?.sharedTags?.some(tag=>tag.tagName==='内容创作'))).toBe(false);expect((await assets.noteTags(u.scope,u.workspaceId,b.noteId)).tags.map(x=>x.displayName)).toEqual(['内容创作','短视频']);expect(bt.tagSetVersion).toBe(1);});
it('manual tag changes fence old extraction and keep suggestions separate',async()=>{const u=await fixture();const n=await assets.createNote(u.scope,u.workspaceId,{title:'标签素材',parts:{raw:'原始内容 alpha',outline:'',germination:''}},randomUUID());const manual=await assets.replaceNoteTags(u.scope,u.workspaceId,n.noteId,['用户标签'],`"tags-${n.noteId}-0"`,randomUUID());const task=(await root.query("SELECT task_id FROM content_jobs WHERE note_id=$1 AND note_revision_id=$2",[n.noteId,n.noteRevisionId])).rows[0];const attempt=await engine.claim(task.task_id,randomUUID());expect(attempt).not.toBeNull();await engine.execute(attempt!);const tags=await assets.noteTags(u.scope,u.workspaceId,n.noteId);expect(tags.tags.map(x=>x.displayName)).toEqual(['用户标签']);expect(tags.suggestions.length).toBe(0);expect(tags.tagSetVersion).toBe(manual.tagSetVersion);const changed=await assets.updateNote(u.scope,u.workspaceId,n.noteId,{parts:{raw:'新正文 beta'}},n.etag,randomUUID());const task2=(await root.query("SELECT task_id FROM content_jobs WHERE note_id=$1 AND note_revision_id=$2",[n.noteId,changed.noteRevisionId])).rows[0];const attempt2=await engine.claim(task2.task_id,randomUUID());await engine.execute(attempt2!);expect((await assets.noteTags(u.scope,u.workspaceId,n.noteId)).tags.map(x=>x.displayName)).toEqual(['用户标签']);expect((await assets.getNote(u.scope,u.workspaceId,n.noteId)).parts.raw!.contentMarkdown).toBe('新正文 beta');});
it('HTTP tag CRUD uses tag ETags, scoped rename, replay and App navigation/search shapes',async()=>{
 const u=await fixture(),other=await fixture();const app=await buildApiServer({config:cfg});
 try{
  const base=`/api/v1/workspaces/${u.workspaceId}`,auth={...fixtureScopeHeaders(u.bearer)};
  const created=await app.inject({method:'POST',url:base+'/notes',headers:{...auth,'x-idempotency-key':randomUUID()},payload:{title:'HTTP 素材',parts:{raw:'正文 keyword'}}});expect(created.statusCode,created.body).toBe(200);const n=created.json().data;
  const url=base+`/notes/${n.noteId}/tags`;const initial=await app.inject({url,headers:auth});expect(initial.statusCode,initial.body).toBe(200);expect(initial.headers['cache-control']).toBe('no-store');
  const headers={...auth,'x-idempotency-key':randomUUID(),'if-match':initial.json().data.tagEtag};
  const add=await app.inject({method:'POST',url,headers,payload:{name:' ＡＩ '}});expect(add.statusCode,add.body).toBe(200);const tags=add.json().data;expect(tags.tags).toHaveLength(1);expect(tags.tags[0].normalizedName).toBe('ai');
  const replay=await app.inject({method:'POST',url,headers,payload:{name:' ＡＩ '}});expect(replay.json().data).toEqual(tags);
  const stale=await app.inject({method:'POST',url,headers:{...headers,'x-idempotency-key':randomUUID(),'if-match':n.etag},payload:{name:'覆盖'}});expect(stale.statusCode).toBe(412);
  const rename=await app.inject({method:'PATCH',url:url+'/'+tags.tags[0].tagId,headers:{...headers,'x-idempotency-key':randomUUID(),'if-match':tags.tagEtag},payload:{name:'写作'}});expect(rename.statusCode,rename.body).toBe(200);
  const renamed=rename.json().data;expect(renamed.tags[0].displayName).toBe('写作');
  const foreign=await app.inject({url,headers:{...fixtureScopeHeaders(other.bearer)}});expect(foreign.statusCode).toBe(404);
  const graph=await app.inject({url:base+'/content-navigation/overview',headers:auth});expect(graph.statusCode,graph.body).toBe(200);expect(graph.headers['cache-control']).toBe('no-store');const g=graph.json().data;
  expect(g.map).toBe('overview');expect(typeof g.contentCursor).toBe('string');expect(g.items).toHaveLength(2);
  for(const item of g.items){expect(item.path.startsWith('/')).toBe(false);expect((typeof item.revisionId==='string')!==(typeof item.version==='number')).toBe(true);expect(item.ownerRef.workspaceId).toBe(u.workspaceId);}
  const search=await app.inject({method:'POST',url:base+'/search',headers:{...auth,'x-idempotency-key':randomUUID()},payload:{query:'keyword',mode:'hybrid'}});expect(search.statusCode,search.body).toBe(200);expect(search.json().data).toMatchObject({mode:'hybrid',keywordReadiness:'current',vectorReadiness:'current',vectorStatus:'ready'});expect(search.json().data.results).toEqual([]); // No Note build exists in this tag-only fixture; real indexed search is covered by knowledge-base.test.ts.
  const over=await app.inject({method:'PUT',url,headers:{...headers,'x-idempotency-key':randomUUID(),'if-match':renamed.tagEtag},payload:{tags:Array.from({length:21},(_,i)=>({name:String(i)}))}});expect(over.statusCode).toBe(400);
  const removed=await app.inject({method:'DELETE',url:url+'/'+renamed.tags[0].tagId,headers:{...headers,'x-idempotency-key':randomUUID(),'if-match':renamed.tagEtag},payload:{}});expect(removed.statusCode,removed.body).toBe(200);expect(removed.json().data.tags).toEqual([]);
 }finally{await app.close();}
});
it('serializes concurrent edits; rename affects only one note and remaining evidence survives',async()=>{
 const u=await fixture();const a=await makeNote(u),b=await makeNote(u);
 const at=await assets.replaceNoteTags(u.scope,u.workspaceId,a.noteId,['共同','第二'],`"tags-${a.noteId}-0"`,randomUUID());await assets.replaceNoteTags(u.scope,u.workspaceId,b.noteId,['共同','第二'],`"tags-${b.noteId}-0"`,randomUUID());
 const outcomes=await Promise.allSettled(['新一','新二'].map(name=>assets.renameNoteTag(u.scope,u.workspaceId,a.noteId,at.tags.find(t=>t.displayName==='共同')!.tagId,name,at.tagEtag,randomUUID())));
 expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(outcomes.find(x=>x.status==='rejected')).toMatchObject({reason:{code:'TAG_REVISION_MISMATCH'}});
 expect((await assets.noteTags(u.scope,u.workspaceId,b.noteId)).tags.map(t=>t.displayName)).toContain('共同');
 const g=await assets.navigation(u.scope,u.workspaceId,'graph');const edge=edgeList(g).find(e=>e.relationType==='co_tagged')!;expect(edge.evidence!.sharedTags!.map(t=>t.tagName)).toEqual(['第二']);
 await assets.deleteNote(u.scope,u.workspaceId,a.noteId,a.etag,randomUUID());const after=await assets.navigation(u.scope,u.workspaceId,'graph');expect(after.totalNotes).toBe(1);expect(edgeList(after).some(e=>e.relationType==='co_tagged')).toBe(false);
 for(const node of after.nodes)if('count' in node)expect(node.count).toBe(1);
});
it('re-extraction after manual edits only suggests, explicit application and duplicate completion are idempotent',async()=>{
 const u=await fixture(),n=await makeNote(u);await assets.replaceNoteTags(u.scope,u.workspaceId,n.noteId,['人工'],`"tags-${n.noteId}-0"`,randomUUID());
 const job=await assets.requestTagExtraction(u.scope,u.workspaceId,n.noteId,randomUUID());expect((await assets.requestTagExtraction(u.scope,u.workspaceId,n.noteId,randomUUID())).taskId).toBe(job.taskId);
 const attempt=await engine.claim(job.taskId,randomUUID());expect(await engine.execute(attempt!)).toBe(true);expect(await engine.execute(attempt!)).toBe(false);
 const view=await assets.noteTags(u.scope,u.workspaceId,n.noteId);expect(view.tags.map(t=>t.displayName)).toEqual(['人工']);expect(view.suggestions).toHaveLength(1);
 const key=randomUUID(),suggestion=view.suggestions[0]!;const applied=await assets.applyTagSuggestion(u.scope,u.workspaceId,n.noteId,suggestion.suggestionId,view.tagEtag,key);
 expect(applied.tags.map(t=>t.displayName)).toEqual([...suggestion.labels].sort());expect(applied.suggestions).toHaveLength(0);
 expect(await assets.applyTagSuggestion(u.scope,u.workspaceId,n.noteId,suggestion.suggestionId,view.tagEtag,key)).toEqual(applied);
 expect((await root.query('SELECT count(*)::int n FROM task_results WHERE task_id=$1',[job.taskId])).rows[0].n).toBe(1);
});
it.each(['manual','revision','delete','folder'] as const)('rejects %s changes made while provider is in flight',async(mode)=>{
 const u=await fixture();const folder=mode==='folder'?await assets.createFolder(u.scope,u.workspaceId,{displayName:'folder'},randomUUID()):null;
 const n=await assets.createNote(u.scope,u.workspaceId,{title:'素材',folderId:folder?.folderId,parts:{raw:'正文 alpha'}},randomUUID());
 const provider:TagExtractor={provider:'race-fixture',async extract(){
  if(mode==='manual')await assets.replaceNoteTags(u.scope,u.workspaceId,n.noteId,[],`"tags-${n.noteId}-0"`,randomUUID());
  if(mode==='revision')await assets.updateNote(u.scope,u.workspaceId,n.noteId,{parts:{raw:'新正文'}},n.etag,randomUUID());
  if(mode==='delete')await assets.deleteNote(u.scope,u.workspaceId,n.noteId,n.etag,randomUUID());
  if(mode==='folder')await assets.deleteFolder(u.scope,u.workspaceId,folder!.folderId,folder!.etag,randomUUID());
  return {provider:this.provider,labels:['不能复活']};
 }};
 const e=new TaskEngine(worker,15000,undefined,undefined,provider),job=await jobFor(n.noteId);const a=await e.claim(job,randomUUID());await e.execute(a!);
 expect((await assets.noteTags(u.scope,u.workspaceId,n.noteId)).tags).toHaveLength(0);expect((await root.query('SELECT outcome FROM content_jobs WHERE task_id=$1',[job])).rows[0].outcome).toBe('stale');
 expect((await root.query('SELECT count(*)::int n FROM note_part_revisions WHERE note_id=$1',[n.noteId])).rows[0].n).toBeGreaterThanOrEqual(3);
});
it('expired attempt cannot write tags/results; disabled, malformed and failed providers preserve original text',async()=>{
 const u=await fixture();
 for(const provider of [undefined,{provider:'bad-fixture',async extract(){return {provider:this.provider,labels:['ok',12]};}},{provider:'error-fixture',async extract(){throw new Error('offline');}}] as Array<TagExtractor|undefined>){
  const n=await makeNote(u),e=new TaskEngine(worker,15000,undefined,undefined,provider),id=await jobFor(n.noteId),a=await e.claim(id,randomUUID());await e.execute(a!);
  expect((await assets.getNote(u.scope,u.workspaceId,n.noteId)).parts.raw!.contentMarkdown).toBe('正文 alpha');expect((await assets.noteTags(u.scope,u.workspaceId,n.noteId)).tags).toEqual([]);
  expect((await root.query('SELECT state,error_code FROM tasks WHERE id=$1',[id])).rows[0]).toMatchObject({state:provider?.provider==='error-fixture'?'retry_scheduled':'failed',error_code:provider?.provider==='bad-fixture'?'TAG_OUTPUT_INVALID':'TAG_PROVIDER_UNAVAILABLE'});
 }
 const n=await makeNote(u),id=await jobFor(n.noteId),attempt=await engine.claim(id,randomUUID());await root.query("UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1",[id]);expect(await engine.execute(attempt!)).toBe(false);expect((await assets.noteTags(u.scope,u.workspaceId,n.noteId)).tagSetVersion).toBe(0);
});
it('preserves ordinary note lists, active-state filtering and user/workspace boundaries',async()=>{
 const u=await fixture(),other=await fixture(),secondId=randomUUID();
 await root.query("INSERT INTO workspaces(id,user_id,display_name,bootstrap_receipt_id) VALUES($1,$2,'second',$3)",[secondId,u.userId,randomUUID()]);
 const active=await makeNote(u),deleted=await makeNote(u),foreign=await makeNote(other);
 const second=await makeNote({...u,workspaceId:secondId});
 await assets.deleteNote(u.scope,u.workspaceId,deleted.noteId,deleted.etag,randomUUID());
 const ownList=await assets.listNotes(u.scope,u.workspaceId);
 expect(ownList.items.map(row=>row.noteId)).toEqual([active.noteId]);
 expect(ownList.items.every(row=>row.state==='active'&&row.workspaceId===u.workspaceId)).toBe(true);
 expect((await assets.listNotes(u.scope,secondId)).items.map(row=>row.noteId)).toEqual([second.noteId]);
 expect((await assets.listNotes(other.scope,other.workspaceId)).items.map(row=>row.noteId)).toEqual([foreign.noteId]);
 await expect(assets.listNotes(other.scope,u.workspaceId)).rejects.toMatchObject({code:'WORKSPACE_NOT_FOUND'});
 await root.query("UPDATE workspaces SET state='disabled' WHERE id=$1",[secondId]);
 await expect(assets.listNotes(u.scope,secondId)).rejects.toMatchObject({code:'WORKSPACE_NOT_FOUND'});
});
it('100k-material high-frequency topic returns bounded pages, global counts and invalidates old cursors',async()=>{
 const u=await fixture(),tagId=randomUUID();await root.query("INSERT INTO asset_tags(tag_id,workspace_id,normalized_name,display_name,source) VALUES($1,$2,'common','Common','manual')",[tagId,u.workspaceId]);
 await root.query("INSERT INTO notes(note_id,workspace_id,title,note_revision_id,etag) SELECT gen_random_uuid(),$1,'scale material',gen_random_uuid(),'fixture' FROM generate_series(1,100000)",[u.workspaceId]);
 await root.query("INSERT INTO note_tags(note_id,tag_id,source) SELECT note_id,$2,'manual' FROM notes WHERE workspace_id=$1",[u.workspaceId,tagId]);
 await root.query('ANALYZE notes');await root.query('ANALYZE note_tags');
 const started=Date.now(),g=await assets.navigation(u.scope,u.workspaceId,'graph',{tagId,maxNodes:12,maxEdges:8});expect(g.totalNotes).toBe(100000);expect(g.nodes.length).toBeLessThanOrEqual(12);expect(g.edges.length).toBeLessThanOrEqual(8);expect(g.hasMore).toBe(true);expect(g.edgesTruncated).toBe(true);expect(g.nodes.find(n=>'count' in n)).toMatchObject({count:100000});
 const focus=await assets.navigation(u.scope,u.workspaceId,'graph',{noteId:g.nodes[0]!.id,maxNodes:1});expect(focus.nodes[0]!.id).toBe(g.nodes[0]!.id);const focusNext=await assets.navigation(u.scope,u.workspaceId,'graph',{noteId:g.nodes[0]!.id,maxNodes:1,cursor:focus.nextCursor!});expect(focusNext.nodes[0]!.id).not.toBe(g.nodes[0]!.id);
 const next=await assets.navigation(u.scope,u.workspaceId,'graph',{tagId,maxNodes:12,maxEdges:8,cursor:g.nextCursor!});const ids=g.nodes.filter(n=>n.kind==='note').map(n=>n.id);expect(next.nodes.filter(n=>n.kind==='note').some(n=>ids.includes(n.id))).toBe(false);
 const plan=await root.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT n.note_id FROM notes n WHERE n.workspace_id=$1 AND n.state='active' AND EXISTS(SELECT 1 FROM note_tags m WHERE m.note_id=n.note_id AND m.tag_id=$2) ORDER BY n.note_id LIMIT 7",[u.workspaceId,tagId]);
 const serialized=JSON.stringify(plan.rows);expect(serialized).toContain('Index');console.log('P06 scale: materials=100000 maxNodes=12 maxEdges=8 two-page-ms='+String(Date.now()-started)+' plan='+serialized);
 const first=ids[0]!;const view=await assets.noteTags(u.scope,u.workspaceId,first);await assets.removeNoteTag(u.scope,u.workspaceId,first,tagId,view.tagEtag,randomUUID());await expect(assets.navigation(u.scope,u.workspaceId,'graph',{tagId,cursor:g.nextCursor!})).rejects.toMatchObject({code:'GRAPH_CURSOR_STALE'});
 const fresh=await assets.navigation(u.scope,u.workspaceId,'graph',{tagId,maxNodes:12});expect(fresh.totalNotes).toBe(99999);expect(fresh.nodes.find(n=>'count' in n)).toMatchObject({count:99999});
},60000);

});
