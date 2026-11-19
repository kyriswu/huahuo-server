import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildApiServer} from '../../src/apps/api-server.js';
import {insertFixtureUser,insertFixtureSession,testJwtEnv} from './jwt-fixture.js';
import { fixtureScopeHeaders } from './jwt-fixture.js';
import type {TagExtractor} from '../../src/modules/content-assets/tag-extractor.js';
import {loadTestConfig as loadConfig} from '../sms-fixture.js';
import {poolFor} from '../../src/plugins/dependencies.js';
import {migrate} from '../../src/db/migrate.js';
import {ContentAssetService} from '../../src/modules/content-assets/service.js';
import {DeterministicTagExtractor} from '../../src/modules/content-assets/tag-extractor.js';
import {TaskEngine} from '../../src/modules/tasks/engine.js';
import {TaskService} from '../../src/modules/tasks/service.js';
type GraphEdge={source:string;target:string;relationType:string;evidence?:{sharedTags?:Array<{tagName:string}>}};const edgeList=(graph:{edges:readonly unknown[]})=>graph.edges as GraphEdge[];
const migrationUrl=process.env.TEST_DATABASE_MIGRATION_URL;if(!migrationUrl)throw new Error('TEST_DB_REQUIRED');
const root=poolFor(loadConfig('migrate',{...process.env,APP_ENV:'test',DATABASE_URL:migrationUrl}));const cfg=loadConfig('api-server',{...process.env,...testJwtEnv,APP_ENV:'test',LOG_LEVEL:'silent',APP_TOKEN_SECRET:'asset-test-'.repeat(8),APP_PUBLIC_BASE_URL:'http://contentAssets.test',DATABASE_URL:process.env.TEST_DATABASE_API_URL});const pool=poolFor(cfg),worker=poolFor({...cfg,role:'worker',databaseUrl:process.env.TEST_DATABASE_WORKER_URL!});const contentAssets=new ContentAssetService(pool,cfg.appTokenSecret!);const engine=new TaskEngine(worker,15000,undefined,undefined,new DeterministicTagExtractor());
async function fixture(){
 const userId=await insertFixtureUser(root),sessionId=randomUUID(),workspaceId=randomUUID();
 const bearer=await insertFixtureSession(root,userId,sessionId,'fixture-fixture');
 await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'fixture',true,$3)",[workspaceId,userId,randomUUID()]);
 return {userId,workspaceId,bearer,scope:{userId,sessionId,traceId:randomUUID()}};
}
async function makeContentAsset(u:Awaited<ReturnType<typeof fixture>>){return contentAssets.createContentAsset(u.scope,u.workspaceId,{title:'素材',parts:{raw:'正文 alpha'}},randomUUID());}
async function jobFor(contentAssetId:string){return String((await root.query('SELECT task_id FROM content_jobs WHERE content_asset_id=$1',[contentAssetId])).rows[0].task_id);}
describe('P06 personal contentAssets, revisions and search',()=>{beforeAll(()=>migrate(loadConfig('migrate',{...process.env,APP_ENV:'test',DATABASE_URL:migrationUrl})));afterAll(async()=>{await Promise.all([pool.end(),root.end(),worker.end()]);});
it('skips disabled automatic tags while preserving ContentAsset saves, content events, indexing and explicit request outcomes',async()=>{
 const u=await fixture(),settings:typeof cfg={...cfg,tagExtractorProvider:'disabled',kb:{...cfg.kb,contentAssetEnabled:true},rag:{...cfg.rag,providerMode:'mock'}};
 const service=new ContentAssetService(pool,cfg.appTokenSecret!,settings);
 const created=await service.createContentAsset(u.scope,u.workspaceId,{title:'original',parts:{raw:'first body'}},randomUUID());
 const edited=await service.updateContentAsset(u.scope,u.workspaceId,created.contentAssetId,{parts:{raw:'second body'}},created.etag,randomUUID());
 let current=await service.updateContentAsset(u.scope,u.workspaceId,created.contentAssetId,{title:'renamed'},edited.etag,randomUUID());
 expect(current).toMatchObject({title:'renamed',parts:{raw:{contentMarkdown:'second body'}}});
 expect((await root.query('SELECT count(*)::int n FROM content_jobs WHERE content_asset_id=$1',[created.contentAssetId])).rows[0].n).toBe(0);
 expect((await root.query('SELECT count(*)::int n FROM kb_content_asset_hybrid_builds WHERE source_id=$1',[created.contentAssetId])).rows[0].n).toBe(2);
 expect((await root.query('SELECT kind FROM tasks WHERE user_id=$1 ORDER BY created_at',[u.userId])).rows.map(t=>t.kind)).toEqual(['kb.content-asset-index','kb.content-asset-index']);
 const key=randomUUID();
 await expect(service.requestTagExtraction(u.scope,u.workspaceId,created.contentAssetId,key)).rejects.toMatchObject({statusCode:503,code:'TAG_PROVIDER_UNAVAILABLE'});
 expect((await root.query('SELECT count(*)::int n FROM api_idempotency WHERE key=$1',[key])).rows[0].n).toBe(0);
 settings.tagExtractorProvider='deterministic';
 const explicit=await service.requestTagExtraction(u.scope,u.workspaceId,created.contentAssetId,key);
 current=await service.updateContentAsset(u.scope,u.workspaceId,created.contentAssetId,{title:'enabled rename'},current.etag,randomUUID());
 expect((await root.query('SELECT count(*)::int n FROM content_jobs WHERE content_asset_id=$1',[created.contentAssetId])).rows[0].n).toBe(2);
 settings.tagExtractorProvider='disabled';
 expect(await service.requestTagExtraction(u.scope,u.workspaceId,created.contentAssetId,key)).toEqual(explicit);
 await expect(service.requestTagExtraction(u.scope,u.workspaceId,created.contentAssetId,randomUUID())).rejects.toMatchObject({code:'TAG_PROVIDER_UNAVAILABLE'});
 current=await service.updateContentAsset(u.scope,u.workspaceId,created.contentAssetId,{parts:{raw:'third body'}},current.etag,randomUUID());
 expect(current.parts.raw!.contentMarkdown).toBe('third body');
 expect((await root.query('SELECT count(*)::int n FROM content_jobs WHERE content_asset_id=$1',[created.contentAssetId])).rows[0].n).toBe(2);
 expect((await root.query('SELECT count(*)::int n FROM kb_content_asset_hybrid_builds WHERE source_id=$1',[created.contentAssetId])).rows[0].n).toBe(3);
 expect((await root.query('SELECT change_type FROM content_events WHERE workspace_id=$1 AND object_id=$2 ORDER BY cursor',[u.workspaceId,created.contentAssetId])).rows.map(e=>e.change_type)).toEqual(['created','updated','updated','updated','updated']);
});
it('creates ContentAsset tag jobs alongside plain-text task inputs under hash-join query plans',async()=>{
 const f=await fixture(),isolated=poolFor({...cfg,poolMax:1});
 try{
  // One connection keeps these planner settings local to this test's service.
  await isolated.query("SELECT set_config('enable_nestloop','off',false),set_config('enable_mergejoin','off',false)");
  const text='plain task input is not JSON';
  const plain=await new TaskService(isolated,cfg.appTokenSecret!).create(f.scope,{workspaceId:f.workspaceId,text},randomUUID());
  const contentAsset=await new ContentAssetService(isolated,cfg.appTokenSecret!).createContentAsset(f.scope,f.workspaceId,{title:'mixed task inputs',parts:{raw:'readable ContentAsset body'}},randomUUID());
  expect(contentAsset.parts.raw!.contentMarkdown).toBe('readable ContentAsset body');
  expect((await root.query('SELECT count(*)::int n FROM content_jobs WHERE content_asset_id=$1',[contentAsset.contentAssetId])).rows[0].n).toBe(1);
  expect((await root.query('SELECT i.body FROM task_inputs i JOIN tasks t ON t.input_id=i.id WHERE t.id=$1',[plain.task.taskId])).rows[0].body).toBe(text);
 }finally{await isolated.end();}
});
it('validates folder, ContentAsset and tag relationship targets within the owning workspace',async()=>{
 const a=await fixture(),b=await fixture(),contentAssetA=await makeContentAsset(a),contentAssetB=await makeContentAsset(b);
 const foreignFolder=await contentAssets.createFolder(b.scope,b.workspaceId,{displayName:'foreign'},randomUUID());
 // A relationship alone cannot grant access to another account's content.
 await root.query('INSERT INTO content_asset_workspaces(workspace_id,content_asset_id) VALUES($1,$2)',[a.workspaceId,contentAssetB.contentAssetId]);
 await expect(contentAssets.getContentAsset(a.scope,a.workspaceId,contentAssetB.contentAssetId)).rejects.toMatchObject({code:'CONTENT_ASSET_NOT_FOUND'});
 await expect(contentAssets.contentAssetTags(a.scope,a.workspaceId,contentAssetB.contentAssetId)).rejects.toMatchObject({code:'CONTENT_ASSET_NOT_FOUND'});
 expect((await contentAssets.listContentAssets(a.scope,a.workspaceId)).items.map(item=>item.contentAssetId)).toEqual([contentAssetA.contentAssetId]);
 await expect(contentAssets.createFolder(a.scope,a.workspaceId,{displayName:'missing parent',parentFolderId:randomUUID()},randomUUID())).rejects.toMatchObject({code:'PARENT_FOLDER_NOT_FOUND'});
 await expect(contentAssets.createContentAsset(a.scope,a.workspaceId,{title:'foreign folder',folderId:foreignFolder.folderId,parts:{raw:'body'}},randomUUID())).rejects.toMatchObject({code:'FOLDER_NOT_FOUND'});
 await expect(contentAssets.createContentAssetRelation(a.scope,a.workspaceId,contentAssetA.contentAssetId,{targetContentAssetId:contentAssetB.contentAssetId,relationType:'references',rationale:'foreign'},randomUUID())).rejects.toMatchObject({code:'CONTENT_ASSET_NOT_FOUND'});
 await expect(contentAssets.createContentAssetRelation(a.scope,a.workspaceId,contentAssetA.contentAssetId,{targetContentAssetId:randomUUID(),relationType:'references',rationale:'absent'},randomUUID())).rejects.toMatchObject({code:'CONTENT_ASSET_NOT_FOUND'});
 const tagsB=await contentAssets.addContentAssetTag(b.scope,b.workspaceId,contentAssetB.contentAssetId,'foreign label',`"tags-${contentAssetB.contentAssetId}-0"`,randomUUID());
 await expect(contentAssets.removeContentAssetTag(a.scope,a.workspaceId,contentAssetA.contentAssetId,tagsB.tags[0]!.tagId,`"tags-${contentAssetA.contentAssetId}-0"`,randomUUID())).rejects.toMatchObject({code:'TAG_NOT_FOUND'});
 expect((await root.query('SELECT count(*)::int n FROM content_asset_relations WHERE source_content_asset_id=$1',[contentAssetA.contentAssetId])).rows[0].n).toBe(0);
 expect((await contentAssets.contentAssetTags(b.scope,b.workspaceId,contentAssetB.contentAssetId)).tags).toHaveLength(1);
});
it('soft deletion preserves revisions, labels and explicit relationships for restoration',async()=>{
 const u=await fixture(),source=await makeContentAsset(u),target=await makeContentAsset(u);
 const tags=await contentAssets.addContentAssetTag(u.scope,u.workspaceId,source.contentAssetId,'retained',`"tags-${source.contentAssetId}-0"`,randomUUID());
 const relation=await contentAssets.createContentAssetRelation(u.scope,u.workspaceId,source.contentAssetId,{targetContentAssetId:target.contentAssetId,relationType:'references',rationale:'retain'},randomUUID());
 await contentAssets.deleteContentAsset(u.scope,u.workspaceId,source.contentAssetId,source.etag,randomUUID());
 expect((await root.query('SELECT count(*)::int n FROM content_asset_parts WHERE content_asset_id=$1',[source.contentAssetId])).rows[0].n).toBe(3);
 expect((await root.query('SELECT count(*)::int n FROM content_asset_tags WHERE content_asset_id=$1 AND tag_id=$2',[source.contentAssetId,tags.tags[0]!.tagId])).rows[0].n).toBe(1);
 expect((await root.query('SELECT count(*)::int n FROM content_asset_relations WHERE relation_id=$1',[relation.relationId])).rows[0].n).toBe(1);
 const deleted=await contentAssets.getContentAsset(u.scope,u.workspaceId,source.contentAssetId);
 await contentAssets.deleteContentAsset(u.scope,u.workspaceId,source.contentAssetId,deleted.etag,randomUUID(),true);
 expect((await contentAssets.getContentAsset(u.scope,u.workspaceId,source.contentAssetId)).parts.raw!.contentMarkdown).toBe('正文 alpha');
 expect((await contentAssets.contentAssetTags(u.scope,u.workspaceId,source.contentAssetId)).tags).toHaveLength(1);
});
it('folders enforce scope, duplicate names, cycles and ETags',async()=>{const u=await fixture();const f=await contentAssets.createFolder(u.scope,u.workspaceId,{displayName:'资料'},randomUUID());await expect(contentAssets.createFolder(u.scope,u.workspaceId,{displayName:'资料'},randomUUID())).rejects.toMatchObject({code:'FOLDER_NAME_CONFLICT'});const child=await contentAssets.createFolder(u.scope,u.workspaceId,{displayName:'子',parentFolderId:f.folderId},randomUUID());await expect(contentAssets.moveFolder(u.scope,u.workspaceId,f.folderId,child.folderId,f.etag,randomUUID())).rejects.toMatchObject({code:'FOLDER_CYCLE'});await expect(contentAssets.updateFolder(u.scope,u.workspaceId,f.folderId,'x','bad-etag',randomUUID())).rejects.toMatchObject({statusCode:412});});
it('folder deletion and restoration only affect organization and leave contentAsset state and revisions intact',async()=>{
 const u=await fixture(),folder=await contentAssets.createFolder(u.scope,u.workspaceId,{displayName:'restore root'},randomUUID());
 const child=await contentAssets.createFolder(u.scope,u.workspaceId,{displayName:'independent child',parentFolderId:folder.folderId},randomUUID());
 const create=(title:string,folderId=folder.folderId)=>contentAssets.createContentAsset(u.scope,u.workspaceId,{title,folderId,parts:{raw:'retained content'}},randomUUID());
 const active=await create('active'),removed=await create('independent contentAsset'),childContentAsset=await create('child contentAsset',child.folderId);
 await contentAssets.deleteContentAsset(u.scope,u.workspaceId,removed.contentAssetId,removed.etag,randomUUID());
 await contentAssets.deleteFolder(u.scope,u.workspaceId,child.folderId,child.etag,randomUUID());
 const removedBefore=await contentAssets.getContentAsset(u.scope,u.workspaceId,removed.contentAssetId),childBefore=await contentAssets.getContentAsset(u.scope,u.workspaceId,childContentAsset.contentAssetId);
 const deleted=await contentAssets.deleteFolder(u.scope,u.workspaceId,folder.folderId,folder.etag,randomUUID());
 expect(deleted.affectedObjectCount).toBe(1);
 expect(await contentAssets.getContentAsset(u.scope,u.workspaceId,active.contentAssetId))
  .toMatchObject({state:'active',folderId:null,etag:active.etag,parts:active.parts});
 expect((await contentAssets.listContentAssets(u.scope,u.workspaceId)).items).toEqual(expect.arrayContaining([
  expect.objectContaining({contentAssetId:active.contentAssetId,folderId:null}),
 ]));
 const rootDeleted=await contentAssets.getFolder(u.scope,u.workspaceId,folder.folderId);
 const key=randomUUID(),restored=await contentAssets.deleteFolder(u.scope,u.workspaceId,folder.folderId,rootDeleted.etag,key,true);
 expect(await contentAssets.deleteFolder(u.scope,u.workspaceId,folder.folderId,rootDeleted.etag,key,true)).toEqual(restored);
 expect(restored.affectedObjectCount).toBe(1);
 expect(await contentAssets.getContentAsset(u.scope,u.workspaceId,active.contentAssetId)).toMatchObject({state:'active',folderId:folder.folderId,etag:active.etag});
 expect(await contentAssets.getContentAsset(u.scope,u.workspaceId,removed.contentAssetId)).toMatchObject({state:'deleted',etag:removedBefore.etag});
 expect(await contentAssets.getContentAsset(u.scope,u.workspaceId,childContentAsset.contentAssetId)).toMatchObject({state:'active',folderId:null,etag:childBefore.etag});
 expect((await contentAssets.getFolder(u.scope,u.workspaceId,child.folderId)).state).toBe('deleted');
 const events=(await root.query("SELECT change_type FROM content_events WHERE workspace_id=$1 AND object_id=$2 ORDER BY cursor",[u.workspaceId,active.contentAssetId])).rows;
 expect(events.map(e=>e.change_type)).toEqual(['created']);
});
it('serializes opposing folder moves so they cannot introduce a cycle',async()=>{
 const u=await fixture(),a=await contentAssets.createFolder(u.scope,u.workspaceId,{displayName:'A'},randomUUID()),b=await contentAssets.createFolder(u.scope,u.workspaceId,{displayName:'B'},randomUUID());
 const results=await Promise.allSettled([contentAssets.moveFolder(u.scope,u.workspaceId,a.folderId,b.folderId,a.etag,randomUUID()),contentAssets.moveFolder(u.scope,u.workspaceId,b.folderId,a.folderId,b.etag,randomUUID())]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'FOLDER_CYCLE'}});
});
it('keeps folder and relation idempotency bound to the complete resource scope',async()=>{
 const u=await fixture(),otherWorkspace=randomUUID();
 await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'second',false,$3)",[otherWorkspace,u.userId,randomUUID()]);
 const key=randomUUID(),a=await contentAssets.createFolder(u.scope,u.workspaceId,{displayName:'same'},key),b=await contentAssets.createFolder(u.scope,otherWorkspace,{displayName:'same'},key);
 expect(a.workspaceId).toBe(u.workspaceId);expect(b.workspaceId).toBe(otherWorkspace);expect(a.folderId).not.toBe(b.folderId);
 const source=await makeContentAsset(u),differentSource=await makeContentAsset(u),target=await makeContentAsset(u),relationKey=randomUUID(),body={targetContentAssetId:target.contentAssetId,relationType:'references',rationale:'same'};
 await contentAssets.createContentAssetRelation(u.scope,u.workspaceId,source.contentAssetId,body,relationKey);
 await expect(contentAssets.createContentAssetRelation(u.scope,u.workspaceId,differentSource.contentAssetId,body,relationKey)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
it('restores a contentAsset independently and allows detaching its inactive folder link',async()=>{
 const u=await fixture(),folder=await contentAssets.createFolder(u.scope,u.workspaceId,{displayName:'parent'},randomUUID()),contentAsset=await contentAssets.createContentAsset(u.scope,u.workspaceId,{title:'child',folderId:folder.folderId,parts:{raw:'body'}},randomUUID());
 await contentAssets.deleteContentAsset(u.scope,u.workspaceId,contentAsset.contentAssetId,contentAsset.etag,randomUUID());
 await contentAssets.deleteFolder(u.scope,u.workspaceId,folder.folderId,folder.etag,randomUUID());
 const deleted=await contentAssets.getContentAsset(u.scope,u.workspaceId,contentAsset.contentAssetId);
 await contentAssets.deleteContentAsset(u.scope,u.workspaceId,contentAsset.contentAssetId,deleted.etag,randomUUID(),true);
 const restored=await contentAssets.getContentAsset(u.scope,u.workspaceId,contentAsset.contentAssetId);
 expect(restored).toMatchObject({state:'active',folderId:null,parts:contentAsset.parts});
 await contentAssets.updateContentAsset(u.scope,u.workspaceId,contentAsset.contentAssetId,{folderId:null},restored.etag,randomUUID());
 const removedFolder=await contentAssets.getFolder(u.scope,u.workspaceId,folder.folderId);
 await contentAssets.deleteFolder(u.scope,u.workspaceId,folder.folderId,removedFolder.etag,randomUUID(),true);
 expect(await contentAssets.getContentAsset(u.scope,u.workspaceId,contentAsset.contentAssetId)).toMatchObject({state:'active',folderId:null});
});
it('overwrites the current part with ETag protection without storing previous bodies',async()=>{
 const u=await fixture(),contentAsset=await makeContentAsset(u),key=randomUUID();
 const updated=await contentAssets.putContentAssetPart(u.scope,u.workspaceId,contentAsset.contentAssetId,'raw','next',contentAsset.etag,key);
 expect(updated.parts.raw!.contentMarkdown).toBe('next');
 expect(await contentAssets.putContentAssetPart(u.scope,u.workspaceId,contentAsset.contentAssetId,'raw','next',contentAsset.etag,key)).toEqual(updated);
 await expect(contentAssets.putContentAssetPart(u.scope,u.workspaceId,contentAsset.contentAssetId,'raw','overwritten',contentAsset.etag,randomUUID())).rejects.toMatchObject({code:'CONTENT_ASSET_REVISION_MISMATCH'});
 expect((await contentAssets.contentAssetPart(u.scope,u.workspaceId,contentAsset.contentAssetId,'raw')).contentMarkdown).toBe('next');
 expect((await root.query('SELECT part,revision,content_markdown FROM content_asset_parts WHERE content_asset_id=$1 ORDER BY part',[contentAsset.contentAssetId])).rows).toEqual([
  {part:'germination',revision:1,content_markdown:''},{part:'outline',revision:1,content_markdown:''},{part:'raw',revision:2,content_markdown:'next'},
 ]);
});
it('keeps original text on tag task failure/stale revision and returns extracted tags for current revision',async()=>{const u=await fixture();const n=await contentAssets.createContentAsset(u.scope,u.workspaceId,{title:'中文项目 Alpha',parts:{raw:'这是一个中文项目资产 with mixed English',outline:'',germination:''}},randomUUID());const changed=await contentAssets.updateContentAsset(u.scope,u.workspaceId,n.contentAssetId,{parts:{raw:'最新内容 beta'}},n.etag,randomUUID());const task=(await root.query("SELECT task_id FROM content_jobs WHERE content_asset_id=$1 AND content_asset_revision_id=$2",[n.contentAssetId,n.contentAssetRevisionId])).rows[0];const stale=await vi.waitFor(async()=>{const attempt=await engine.claim(task.task_id,randomUUID());expect(attempt).not.toBeNull();return attempt!;},{timeout:3000,interval:20});await engine.execute(stale!);const tags=(await root.query('SELECT count(*)::int n FROM content_asset_tags WHERE content_asset_id=$1',[n.contentAssetId])).rows[0].n;expect(tags).toBe(0);const task2=(await root.query("SELECT task_id FROM content_jobs WHERE content_asset_id=$1 AND content_asset_revision_id=$2",[n.contentAssetId,changed.contentAssetRevisionId])).rows[0];const current=await vi.waitFor(async()=>{const attempt=await engine.claim(task2.task_id,randomUUID());expect(attempt).not.toBeNull();return attempt!;},{timeout:3000,interval:20});await engine.execute(current);expect((await root.query('SELECT count(*)::int n FROM content_asset_tags WHERE content_asset_id=$1',[n.contentAssetId])).rows[0].n).toBeGreaterThan(0);expect((await contentAssets.getContentAsset(u.scope,u.workspaceId,n.contentAssetId)).parts.raw!.contentMarkdown).toBe('最新内容 beta');});
it('imports only extracted text and rejects binary formats without creating placeholder contentAssets',async()=>{
 const u=await fixture(),content='  已提取正文 😀\n\n第二段\n';
 for(const mimeType of ['text/plain','text/markdown']){
  const ready=await contentAssets.importContentAsset(u.scope,u.workspaceId,{title:'导入',mimeType,content},randomUUID());
  expect(ready.status).toBe('ready');expect(ready.contentAsset.parts.raw!.contentMarkdown).toBe(content);
 }
 for(const mimeType of ['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/x-markdown'])
  await expect(contentAssets.importContentAsset(u.scope,u.workspaceId,{title:'不支持',mimeType,content},randomUUID())).rejects.toMatchObject({code:'IMPORT_CONTENT_TYPE_UNSUPPORTED'});
 for(const invalid of ['', ' \n\t '])
  await expect(contentAssets.importContentAsset(u.scope,u.workspaceId,{title:'空正文',mimeType:'text/plain',content:invalid},randomUUID())).rejects.toMatchObject({code:'IMPORT_CONTENT_INVALID'});
 await expect(contentAssets.importContentAsset(u.scope,u.workspaceId,{title:'超限规范正文',mimeType:'text/plain',content:'x'.repeat(500001)},randomUUID())).rejects.toMatchObject({code:'CONTENT_ASSET_CONTENT_TOO_LARGE'});
 expect((await root.query('SELECT count(*)::int n FROM content_assets WHERE user_id=$1',[u.userId])).rows[0].n).toBe(2);
});
it('HTTP text imports reject file payloads, preserve replay and enforce workspace ownership',async()=>{
 const u=await fixture(),other=await fixture(),app=await buildApiServer({config:cfg});
 const url=`/api/v1/workspaces/${u.workspaceId}/content-asset-imports`,headers={...fixtureScopeHeaders(u.bearer),'x-idempotency-key':randomUUID()};
 const payload={title:'提取结果',mimeType:'text/markdown',content:'# 外部提取结果\n\n正文 😀\n',sourceUrl:'https://fixture.test/original.pdf'};
 try{
  for(const invalid of [
   {...payload,contentBase64:'UEsDBAoAAAAAAA=='},
   {...payload,mimeType:'application/pdf'},
   {...payload,mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},
   {title:payload.title,mimeType:payload.mimeType,sourceUrl:payload.sourceUrl},
   {...payload,content:' \n\t '},
  ]){
   const rejected=await app.inject({method:'POST',url,headers,payload:invalid});expect(rejected.statusCode,rejected.body).toBe(400);
  }
  expect((await root.query('SELECT count(*)::int n FROM content_assets WHERE user_id=$1',[u.userId])).rows[0].n).toBe(0);
  const first=await app.inject({method:'POST',url,headers,payload});expect(first.statusCode,first.body).toBe(200);
  expect(first.json().data).toMatchObject({status:'ready',contentAsset:{parts:{raw:{contentMarkdown:payload.content}}}});
  const replay=await app.inject({method:'POST',url,headers,payload});expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data.contentAsset.contentAssetId).toBe(first.json().data.contentAsset.contentAssetId);
  expect((await root.query('SELECT count(*)::int n FROM content_assets WHERE user_id=$1',[u.userId])).rows[0].n).toBe(1);
  const foreign=await app.inject({method:'POST',url,headers:{...fixtureScopeHeaders(other.bearer),'x-idempotency-key':randomUUID()},payload});expect(foreign.statusCode,foreign.body).toBe(404);
 }finally{await app.close();}
});
it('content navigation and explicit relations expose evidence-based graph edges',async()=>{const u=await fixture();const a=await contentAssets.createContentAsset(u.scope,u.workspaceId,{title:'A',parts:{raw:'alpha',outline:'',germination:''}},randomUUID());const b=await contentAssets.createContentAsset(u.scope,u.workspaceId,{title:'B',parts:{raw:'beta',outline:'',germination:''}},randomUUID());const rel=await contentAssets.createContentAssetRelation(u.scope,u.workspaceId,a.contentAssetId,{targetContentAssetId:b.contentAssetId,relationType:'references',rationale:'explicit source'},randomUUID());expect(rel.origin).toBe('explicit');expect((await contentAssets.contentAssetRelations(u.scope,u.workspaceId,a.contentAssetId)).items).toHaveLength(1);expect((await contentAssets.navigation(u.scope,u.workspaceId,'graph')).nodes.length).toBeGreaterThanOrEqual(2);});
it('uses only effective tags for graph edges and keeps other contentAssets unchanged after removal',async()=>{const u=await fixture();const a=await contentAssets.createContentAsset(u.scope,u.workspaceId,{title:'A',parts:{raw:'alpha',outline:'',germination:''}},randomUUID());const b=await contentAssets.createContentAsset(u.scope,u.workspaceId,{title:'B',parts:{raw:'beta',outline:'',germination:''}},randomUUID());const c=await contentAssets.createContentAsset(u.scope,u.workspaceId,{title:'C',parts:{raw:'gamma',outline:'',germination:''}},randomUUID());const at=await contentAssets.replaceContentAssetTags(u.scope,u.workspaceId,a.contentAssetId,['AI','内容创作'],`"tags-${a.contentAssetId}-0"`,randomUUID());const bt=await contentAssets.replaceContentAssetTags(u.scope,u.workspaceId,b.contentAssetId,['内容创作','短视频'],`"tags-${b.contentAssetId}-0"`,randomUUID());await contentAssets.replaceContentAssetTags(u.scope,u.workspaceId,c.contentAssetId,['旅行'],`"tags-${c.contentAssetId}-0"`,randomUUID());let graph=await contentAssets.navigation(u.scope,u.workspaceId,'graph',{maxNodes:20,maxEdges:20});const shared=edgeList(graph).find(edge=>edge.relationType==='co_tagged'&&edge.evidence?.sharedTags?.some(tag=>tag.tagName==='内容创作'));expect(shared).toBeTruthy();expect(edgeList(graph).some(edge=>edge.relationType==='co_tagged'&&(edge.source===a.contentAssetId&&edge.target===c.contentAssetId||edge.source===c.contentAssetId&&edge.target===a.contentAssetId))).toBe(false);const sharedTag=at.tags.find(x=>x.displayName==='内容创作')!;const after=await contentAssets.removeContentAssetTag(u.scope,u.workspaceId,a.contentAssetId,sharedTag.tagId,at.tagEtag,randomUUID());expect(after.tags.map(x=>x.displayName)).toEqual(['AI']);graph=await contentAssets.navigation(u.scope,u.workspaceId,'graph',{maxNodes:20,maxEdges:20});expect(edgeList(graph).some(edge=>edge.relationType==='co_tagged'&&edge.evidence?.sharedTags?.some(tag=>tag.tagName==='内容创作'))).toBe(false);expect((await contentAssets.contentAssetTags(u.scope,u.workspaceId,b.contentAssetId)).tags.map(x=>x.displayName)).toEqual(['内容创作','短视频']);expect(bt.tagSetVersion).toBe(1);});
it('manual tag changes fence old extraction and keep suggestions separate',async()=>{const u=await fixture();const n=await contentAssets.createContentAsset(u.scope,u.workspaceId,{title:'标签素材',parts:{raw:'原始内容 alpha',outline:'',germination:''}},randomUUID());const manual=await contentAssets.replaceContentAssetTags(u.scope,u.workspaceId,n.contentAssetId,['用户标签'],`"tags-${n.contentAssetId}-0"`,randomUUID());const task=(await root.query("SELECT task_id FROM content_jobs WHERE content_asset_id=$1 AND content_asset_revision_id=$2",[n.contentAssetId,n.contentAssetRevisionId])).rows[0];const attempt=await engine.claim(task.task_id,randomUUID());expect(attempt).not.toBeNull();await engine.execute(attempt!);const tags=await contentAssets.contentAssetTags(u.scope,u.workspaceId,n.contentAssetId);expect(tags.tags.map(x=>x.displayName)).toEqual(['用户标签']);expect(tags.suggestions.length).toBe(0);expect(tags.tagSetVersion).toBe(manual.tagSetVersion);const changed=await contentAssets.updateContentAsset(u.scope,u.workspaceId,n.contentAssetId,{parts:{raw:'新正文 beta'}},n.etag,randomUUID());const task2=(await root.query("SELECT task_id FROM content_jobs WHERE content_asset_id=$1 AND content_asset_revision_id=$2",[n.contentAssetId,changed.contentAssetRevisionId])).rows[0];const attempt2=await engine.claim(task2.task_id,randomUUID());await engine.execute(attempt2!);expect((await contentAssets.contentAssetTags(u.scope,u.workspaceId,n.contentAssetId)).tags.map(x=>x.displayName)).toEqual(['用户标签']);expect((await contentAssets.getContentAsset(u.scope,u.workspaceId,n.contentAssetId)).parts.raw!.contentMarkdown).toBe('新正文 beta');});
it('HTTP tag CRUD uses tag ETags, scoped rename, replay and App navigation/search shapes',async()=>{
 const u=await fixture(),other=await fixture();const app=await buildApiServer({config:cfg});
 try{
  const base=`/api/v1/workspaces/${u.workspaceId}`,auth={...fixtureScopeHeaders(u.bearer)};
  const created=await app.inject({method:'POST',url:base+'/content-assets',headers:{...auth,'x-idempotency-key':randomUUID()},payload:{title:'HTTP 素材',parts:{raw:'正文 keyword'}}});expect(created.statusCode,created.body).toBe(200);const n=created.json().data;
  const url=base+`/content-assets/${n.contentAssetId}/tags`;const initial=await app.inject({url,headers:auth});expect(initial.statusCode,initial.body).toBe(200);expect(initial.headers['cache-control']).toBe('no-store');
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
  const search=await app.inject({method:'POST',url:base+'/search',headers:{...auth,'x-idempotency-key':randomUUID()},payload:{query:'keyword',mode:'hybrid'}});expect(search.statusCode,search.body).toBe(200);expect(search.json().data).toMatchObject({mode:'hybrid',keywordReadiness:'current',vectorReadiness:'current',vectorStatus:'ready'});expect(search.json().data.results).toEqual([]); // No ContentAsset build exists in this tag-only fixture; real indexed search is covered by knowledge-base.test.ts.
  const over=await app.inject({method:'PUT',url,headers:{...headers,'x-idempotency-key':randomUUID(),'if-match':renamed.tagEtag},payload:{tags:Array.from({length:21},(_,i)=>({name:String(i)}))}});expect(over.statusCode).toBe(400);
  const removed=await app.inject({method:'DELETE',url:url+'/'+renamed.tags[0].tagId,headers:{...headers,'x-idempotency-key':randomUUID(),'if-match':renamed.tagEtag},payload:{}});expect(removed.statusCode,removed.body).toBe(200);expect(removed.json().data.tags).toEqual([]);
 }finally{await app.close();}
});
it('serializes concurrent edits; rename affects only one contentAsset and remaining evidence survives',async()=>{
 const u=await fixture();const a=await makeContentAsset(u),b=await makeContentAsset(u);
 const at=await contentAssets.replaceContentAssetTags(u.scope,u.workspaceId,a.contentAssetId,['共同','第二'],`"tags-${a.contentAssetId}-0"`,randomUUID());await contentAssets.replaceContentAssetTags(u.scope,u.workspaceId,b.contentAssetId,['共同','第二'],`"tags-${b.contentAssetId}-0"`,randomUUID());
 const outcomes=await Promise.allSettled(['新一','新二'].map(name=>contentAssets.renameContentAssetTag(u.scope,u.workspaceId,a.contentAssetId,at.tags.find(t=>t.displayName==='共同')!.tagId,name,at.tagEtag,randomUUID())));
 expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(outcomes.find(x=>x.status==='rejected')).toMatchObject({reason:{code:'TAG_REVISION_MISMATCH'}});
 expect((await contentAssets.contentAssetTags(u.scope,u.workspaceId,b.contentAssetId)).tags.map(t=>t.displayName)).toContain('共同');
 const g=await contentAssets.navigation(u.scope,u.workspaceId,'graph');const edge=edgeList(g).find(e=>e.relationType==='co_tagged')!;expect(edge.evidence!.sharedTags!.map(t=>t.tagName)).toEqual(['第二']);
 await contentAssets.deleteContentAsset(u.scope,u.workspaceId,a.contentAssetId,a.etag,randomUUID());const after=await contentAssets.navigation(u.scope,u.workspaceId,'graph');expect(after.totalContentAssets).toBe(1);expect(edgeList(after).some(e=>e.relationType==='co_tagged')).toBe(false);
 for(const node of after.nodes)if('count' in node)expect(node.count).toBe(1);
});
it('re-extraction after manual edits only suggests, explicit application and duplicate completion are idempotent',async()=>{
 const u=await fixture(),n=await makeContentAsset(u);await contentAssets.replaceContentAssetTags(u.scope,u.workspaceId,n.contentAssetId,['人工'],`"tags-${n.contentAssetId}-0"`,randomUUID());
 const job=await contentAssets.requestTagExtraction(u.scope,u.workspaceId,n.contentAssetId,randomUUID());expect((await contentAssets.requestTagExtraction(u.scope,u.workspaceId,n.contentAssetId,randomUUID())).taskId).toBe(job.taskId);
 const attempt=await engine.claim(job.taskId,randomUUID());expect(await engine.execute(attempt!)).toBe(true);expect(await engine.execute(attempt!)).toBe(false);
 const view=await contentAssets.contentAssetTags(u.scope,u.workspaceId,n.contentAssetId);expect(view.tags.map(t=>t.displayName)).toEqual(['人工']);expect(view.suggestions).toHaveLength(1);
 const key=randomUUID(),suggestion=view.suggestions[0]!;const applied=await contentAssets.applyTagSuggestion(u.scope,u.workspaceId,n.contentAssetId,suggestion.suggestionId,view.tagEtag,key);
 expect(applied.tags.map(t=>t.displayName)).toEqual([...suggestion.labels].sort());expect(applied.suggestions).toHaveLength(0);
 expect(await contentAssets.applyTagSuggestion(u.scope,u.workspaceId,n.contentAssetId,suggestion.suggestionId,view.tagEtag,key)).toEqual(applied);
 expect((await root.query('SELECT count(*)::int n FROM task_results WHERE task_id=$1',[job.taskId])).rows[0].n).toBe(1);
});
it.each(['manual','revision','delete','folder'] as const)('fences tag results correctly when %s changes during extraction',async(mode)=>{
 const u=await fixture();const folder=mode==='folder'?await contentAssets.createFolder(u.scope,u.workspaceId,{displayName:'folder'},randomUUID()):null;
 const n=await contentAssets.createContentAsset(u.scope,u.workspaceId,{title:'素材',folderId:folder?.folderId,parts:{raw:'正文 alpha'}},randomUUID());
 const provider:TagExtractor={provider:'race-fixture',async extract(){
  if(mode==='manual')await contentAssets.replaceContentAssetTags(u.scope,u.workspaceId,n.contentAssetId,[],`"tags-${n.contentAssetId}-0"`,randomUUID());
  if(mode==='revision')await contentAssets.updateContentAsset(u.scope,u.workspaceId,n.contentAssetId,{parts:{raw:'新正文'}},n.etag,randomUUID());
  if(mode==='delete')await contentAssets.deleteContentAsset(u.scope,u.workspaceId,n.contentAssetId,n.etag,randomUUID());
  if(mode==='folder')await contentAssets.deleteFolder(u.scope,u.workspaceId,folder!.folderId,folder!.etag,randomUUID());
  return {provider:this.provider,labels:['不能复活']};
 }};
 const e=new TaskEngine(worker,15000,undefined,undefined,provider),job=await jobFor(n.contentAssetId);const a=await e.claim(job,randomUUID());await e.execute(a!);
 expect((await contentAssets.contentAssetTags(u.scope,u.workspaceId,n.contentAssetId)).tags.map(t=>t.displayName)).toEqual(mode==='folder'?['不能复活']:[]);
 expect((await root.query('SELECT outcome FROM content_jobs WHERE task_id=$1',[job])).rows[0].outcome).toBe(mode==='folder'?'applied':'stale');
 expect((await root.query('SELECT count(*)::int n FROM content_asset_parts WHERE content_asset_id=$1',[n.contentAssetId])).rows[0].n).toBeGreaterThanOrEqual(3);
});
it('rejects tag task inputs without the current captured version',async()=>{
 const u=await fixture(),n=await makeContentAsset(u),id=await jobFor(n.contentAssetId);
 await root.query("UPDATE task_inputs SET body=(body::jsonb-'tagSetVersion')::text WHERE id=(SELECT input_id FROM tasks WHERE id=$1)",[id]);
 const attempt=await engine.claim(id,randomUUID());await engine.execute(attempt!);
 expect((await root.query('SELECT state,error_code,retryable FROM tasks WHERE id=$1',[id])).rows[0]).toMatchObject({state:'failed',error_code:'TAG_INPUT_INVALID',retryable:false});
 expect((await contentAssets.contentAssetTags(u.scope,u.workspaceId,n.contentAssetId)).tags).toEqual([]);
});
it('expired attempt cannot write tags/results; disabled, malformed and failed providers preserve original text',async()=>{
 const u=await fixture();
 for(const provider of [undefined,{provider:'bad-fixture',async extract(){return {provider:this.provider,labels:['ok',12]};}},{provider:'error-fixture',async extract(){throw new Error('offline');}}] as Array<TagExtractor|undefined>){
  const n=await makeContentAsset(u),e=new TaskEngine(worker,15000,undefined,undefined,provider),id=await jobFor(n.contentAssetId),a=await e.claim(id,randomUUID());await e.execute(a!);
  expect((await contentAssets.getContentAsset(u.scope,u.workspaceId,n.contentAssetId)).parts.raw!.contentMarkdown).toBe('正文 alpha');expect((await contentAssets.contentAssetTags(u.scope,u.workspaceId,n.contentAssetId)).tags).toEqual([]);
  expect((await root.query('SELECT state,error_code FROM tasks WHERE id=$1',[id])).rows[0]).toMatchObject({state:provider?.provider==='error-fixture'?'retry_scheduled':'failed',error_code:provider?.provider==='bad-fixture'?'TAG_OUTPUT_INVALID':'TAG_PROVIDER_UNAVAILABLE'});
 }
 const n=await makeContentAsset(u),id=await jobFor(n.contentAssetId),attempt=await engine.claim(id,randomUUID());await root.query("UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1",[id]);expect(await engine.execute(attempt!)).toBe(false);expect((await contentAssets.contentAssetTags(u.scope,u.workspaceId,n.contentAssetId)).tagSetVersion).toBe(0);
});
it('preserves ordinary contentAsset lists, active-state filtering and user/workspace boundaries',async()=>{
 const u=await fixture(),other=await fixture(),secondId=randomUUID();
 await root.query("INSERT INTO workspaces(id,user_id,display_name,bootstrap_receipt_id) VALUES($1,$2,'second',$3)",[secondId,u.userId,randomUUID()]);
 const active=await makeContentAsset(u),deleted=await makeContentAsset(u),foreign=await makeContentAsset(other);
 const second=await makeContentAsset({...u,workspaceId:secondId});
 await contentAssets.deleteContentAsset(u.scope,u.workspaceId,deleted.contentAssetId,deleted.etag,randomUUID());
 const ownList=await contentAssets.listContentAssets(u.scope,u.workspaceId);
 expect(ownList.items.map(row=>row.contentAssetId)).toEqual([active.contentAssetId]);
 expect(ownList.items.every(row=>row.state==='active'&&row.workspaceId===u.workspaceId)).toBe(true);
 expect((await contentAssets.listContentAssets(u.scope,secondId)).items.map(row=>row.contentAssetId)).toEqual([second.contentAssetId]);
 expect((await contentAssets.listContentAssets(other.scope,other.workspaceId)).items.map(row=>row.contentAssetId)).toEqual([foreign.contentAssetId]);
 await expect(contentAssets.listContentAssets(other.scope,u.workspaceId)).rejects.toMatchObject({code:'WORKSPACE_NOT_FOUND'});
 await root.query("UPDATE workspaces SET state='disabled' WHERE id=$1",[secondId]);
 await expect(contentAssets.listContentAssets(u.scope,secondId)).rejects.toMatchObject({code:'WORKSPACE_NOT_FOUND'});
});
it('100k-material high-frequency topic returns bounded pages, global counts and invalidates old cursors',async()=>{
 const u=await fixture(),tagId=randomUUID();await root.query("INSERT INTO asset_tags(tag_id,workspace_id,normalized_name,display_name,source) VALUES($1,$2,'common','Common','manual')",[tagId,u.workspaceId]);
 await root.query(`WITH inserted AS (
  INSERT INTO content_assets(content_asset_id,user_id,title,content_asset_revision_id,etag)
  SELECT gen_random_uuid(),$1,'scale material',gen_random_uuid(),'fixture' FROM generate_series(1,100000) RETURNING content_asset_id
 ) INSERT INTO content_asset_workspaces(workspace_id,content_asset_id) SELECT $2,content_asset_id FROM inserted`,[u.userId,u.workspaceId]);
 await root.query("INSERT INTO content_asset_tags(content_asset_id,tag_id,source) SELECT content_asset_id,$2,'manual' FROM content_asset_workspaces WHERE workspace_id=$1",[u.workspaceId,tagId]);
 await root.query('ANALYZE content_assets');await root.query('ANALYZE content_asset_tags');await root.query('ANALYZE content_asset_workspaces');
 const started=Date.now(),g=await contentAssets.navigation(u.scope,u.workspaceId,'graph',{tagId,maxNodes:12,maxEdges:8});expect(g.totalContentAssets).toBe(100000);expect(g.nodes.length).toBeLessThanOrEqual(12);expect(g.edges.length).toBeLessThanOrEqual(8);expect(g.hasMore).toBe(true);expect(g.edgesTruncated).toBe(true);expect(g.nodes.find(n=>'count' in n)).toMatchObject({count:100000});
 const focus=await contentAssets.navigation(u.scope,u.workspaceId,'graph',{contentAssetId:g.nodes[0]!.id,maxNodes:1});expect(focus.nodes[0]!.id).toBe(g.nodes[0]!.id);const focusNext=await contentAssets.navigation(u.scope,u.workspaceId,'graph',{contentAssetId:g.nodes[0]!.id,maxNodes:1,cursor:focus.nextCursor!});expect(focusNext.nodes[0]!.id).not.toBe(g.nodes[0]!.id);
 const next=await contentAssets.navigation(u.scope,u.workspaceId,'graph',{tagId,maxNodes:12,maxEdges:8,cursor:g.nextCursor!});const ids=g.nodes.filter(n=>n.kind==='content_asset').map(n=>n.id);expect(next.nodes.filter(n=>n.kind==='content_asset').some(n=>ids.includes(n.id))).toBe(false);
 const plan=await root.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
  SELECT n.content_asset_id FROM content_assets n JOIN content_asset_workspaces w ON w.content_asset_id=n.content_asset_id AND w.workspace_id=$1
  WHERE n.user_id=$3 AND n.state='active' AND EXISTS(SELECT 1 FROM content_asset_tags m WHERE m.content_asset_id=n.content_asset_id AND m.tag_id=$2)
  ORDER BY n.content_asset_id LIMIT 7`,[u.workspaceId,tagId,u.userId]);
 const serialized=JSON.stringify(plan.rows);expect(serialized).toContain('Index');console.log('P06 scale: materials=100000 maxNodes=12 maxEdges=8 two-page-ms='+String(Date.now()-started)+' plan='+serialized);
 const first=ids[0]!;const view=await contentAssets.contentAssetTags(u.scope,u.workspaceId,first);await contentAssets.removeContentAssetTag(u.scope,u.workspaceId,first,tagId,view.tagEtag,randomUUID());await expect(contentAssets.navigation(u.scope,u.workspaceId,'graph',{tagId,cursor:g.nextCursor!})).rejects.toMatchObject({code:'GRAPH_CURSOR_STALE'});
 const fresh=await contentAssets.navigation(u.scope,u.workspaceId,'graph',{tagId,maxNodes:12});expect(fresh.totalContentAssets).toBe(99999);expect(fresh.nodes.find(n=>'count' in n)).toMatchObject({count:99999});
},60000);

});
