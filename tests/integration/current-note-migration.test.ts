import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {afterAll,describe,expect,it} from 'vitest';
import {loadConfig} from '../../src/config/config.js';
import {loadMigrationFiles} from '../../src/db/migration-files.js';
import {poolFor} from '../../src/plugins/dependencies.js';

const database=process.env.TEST_DATABASE_MIGRATION_URL;
if(!database||!/^huahuo_test_[a-z0-9_]+$/u.test(new URL(database).pathname.slice(1)))throw new Error('ISOLATED_DATABASE_REQUIRED');
const pool=poolFor(loadConfig('migrate',{DATABASE_URL:database}));
const migrations=loadMigrationFiles();
afterAll(()=>pool.end());
async function fixture(run:(tx:PoolClient,schema:string)=>Promise<void>){
 const tx=await pool.connect(),schema=`current_note_${randomUUID().replaceAll('-','')}`;
 await tx.query('BEGIN');
 try{await tx.query(`CREATE SCHEMA ${schema}`);await run(tx,schema);}
 finally{await tx.query('ROLLBACK');tx.release();}
}
function sql(version:number,schema:string){return migrations.find(m=>m.version===version)!.sql.replaceAll('public.',`${schema}.`);}

describe('current-only note content and retired settings migrations',()=>{
 it('removes only retired downloader settings and changes the singleton revision once',async()=>fixture(async(tx,schema)=>{
  await tx.query(`CREATE TABLE ${schema}.runtime_configuration(singleton boolean PRIMARY KEY,revision bigint,"values" jsonb,updated_at timestamptz);
   INSERT INTO ${schema}.runtime_configuration VALUES(true,7,'{"storage.maxSourceBytes":200,"tasks.downloadTimeoutMs":1000,"storage.quotaBytes":99,"$schemaVersion":1}','2026-01-01')`);
  await tx.query(sql(9,schema));
  const current=(await tx.query(`SELECT * FROM ${schema}.runtime_configuration`)).rows;
  expect(current[0]).toMatchObject({revision:'8',values:{'storage.quotaBytes':99,$schemaVersion:1}});
  await tx.query(sql(9,schema));
  expect((await tx.query(`SELECT * FROM ${schema}.runtime_configuration`)).rows).toEqual(current);
 }));

 async function notes(tx:PoolClient,schema:string){
  await tx.query(`CREATE TABLE ${schema}.workspaces(id uuid PRIMARY KEY,user_id uuid);
   CREATE TABLE ${schema}.notes(note_id uuid PRIMARY KEY,workspace_id uuid);
   CREATE TABLE ${schema}.note_part_revisions(part_revision_id uuid CONSTRAINT note_part_revisions_pkey PRIMARY KEY,note_id uuid,part text,revision integer,content_markdown text,created_at timestamptz DEFAULT now(),
    CONSTRAINT note_part_revisions_part_check CHECK(part IN ('raw','outline','germination')),
    CONSTRAINT note_part_revisions_revision_check CHECK(revision>0),
    CONSTRAINT note_part_revisions_note_id_part_revision_key UNIQUE(note_id,part,revision));
   CREATE INDEX note_parts_latest ON ${schema}.note_part_revisions(note_id,part,revision DESC);
   CREATE TABLE ${schema}.resource_refs(resource_id uuid,user_id uuid,workspace_id uuid,ref_kind text,ref_id_external text);
   GRANT SELECT,INSERT,UPDATE,DELETE ON ${schema}.note_part_revisions TO huahuo_api;`);
  const user=randomUUID(),workspace=randomUUID(),note=randomUUID(),old=randomUUID(),latest=randomUUID(),resource=randomUUID();
  await tx.query(`INSERT INTO ${schema}.workspaces VALUES($1,$2);`,[workspace,user]);
  await tx.query(`INSERT INTO ${schema}.notes VALUES($1,$2)`,[note,workspace]);
  await tx.query(`INSERT INTO ${schema}.note_part_revisions(part_revision_id,note_id,part,revision,content_markdown,created_at) VALUES($1,$3,'raw',1,'old','2026-01-01'),($2,$3,'raw',2,'current','2026-02-01')`,[old,latest,note]);
  await tx.query(`INSERT INTO ${schema}.resource_refs VALUES($1,$2,$3,'note_revision',$4),($1,$2,$3,'note',$5)`,[resource,user,workspace,old,note]);
  return {user,workspace,note,old,latest,resource};
 }
 it('keeps only current bodies and current note references, with one row per part and unchanged role access',async()=>fixture(async(tx,schema)=>{
  const f=await notes(tx,schema);
  await tx.query(sql(10,schema));
  expect((await tx.query(`SELECT part_revision_id,content_markdown,revision,updated_at=created_at AS timestamp_preserved FROM ${schema}.note_parts`)).rows).toEqual([{part_revision_id:f.latest,content_markdown:'current',revision:2,timestamp_preserved:true}]);
  expect((await tx.query(`SELECT ref_kind,ref_id_external FROM ${schema}.resource_refs`)).rows).toEqual([{ref_kind:'note',ref_id_external:f.note}]);
  expect((await tx.query('SELECT to_regclass($1) AS old',[`${schema}.note_part_revisions`])).rows[0].old).toBeNull();
  expect((await tx.query("SELECT has_table_privilege('huahuo_api',$1,'UPDATE') AS allowed",[`${schema}.note_parts`])).rows[0].allowed).toBe(true);
  await tx.query('SAVEPOINT duplicate_part');
  await expect(tx.query(`INSERT INTO ${schema}.note_parts(part_revision_id,note_id,part,revision,content_markdown) VALUES($1,$2,'raw',3,'duplicate')`,[randomUUID(),f.note])).rejects.toMatchObject({code:'23505'});
  await tx.query('ROLLBACK TO SAVEPOINT duplicate_part');
 }));
 it.each(['missing-note','foreign-pin'])('rejects %s ownership before removing any history or pins',async mode=>fixture(async(tx,schema)=>{
  const f=await notes(tx,schema);
  if(mode==='missing-note')await tx.query(`DELETE FROM ${schema}.notes WHERE note_id=$1`,[f.note]);
  else await tx.query(`UPDATE ${schema}.resource_refs SET user_id=$1 WHERE ref_kind='note_revision'`,[randomUUID()]);
  await tx.query('SAVEPOINT migration_start');
  await expect(tx.query(sql(10,schema))).rejects.toThrow(mode==='missing-note'?'NOTE_CURRENT_PART_OWNER_MISSING':'NOTE_REVISION_REFERENCE_OWNER_MISMATCH');
  await tx.query('ROLLBACK TO SAVEPOINT migration_start');
  expect((await tx.query(`SELECT count(*)::int n FROM ${schema}.note_part_revisions`)).rows[0].n).toBe(2);
  expect((await tx.query(`SELECT count(*)::int n FROM ${schema}.resource_refs`)).rows[0].n).toBe(2);
 }));

 async function resources(tx:PoolClient,schema:string){
  await tx.query(`CREATE TABLE ${schema}.resources(resource_id uuid PRIMARY KEY,user_id uuid NOT NULL,workspace_id uuid NOT NULL,upload_id uuid NOT NULL,processing_status text,deleted_at timestamptz,status text NOT NULL CONSTRAINT resources_status_check CHECK(status IN ('ready','deleting','deleted','quarantined')),size_bytes bigint,created_at timestamptz DEFAULT now());
   CREATE TABLE ${schema}.resource_refs(resource_id uuid,user_id uuid,workspace_id uuid NOT NULL,ref_kind text,ref_id_external text);
   CREATE TABLE ${schema}.storage_jobs(task_id uuid PRIMARY KEY);
   CREATE TABLE ${schema}.tasks(id uuid PRIMARY KEY,user_id uuid,workspace_id uuid,kind text,
    CONSTRAINT tasks_check CHECK((user_id IS NULL AND workspace_id IS NULL AND kind IN ('maintenance.check','processing.node-start')) OR(user_id IS NOT NULL AND workspace_id IS NOT NULL)))`);
  const id=randomUUID(),user=randomUUID(),workspace=randomUUID();
  await tx.query(`INSERT INTO ${schema}.resources(resource_id,user_id,workspace_id,upload_id,status,size_bytes) VALUES($1,$2,$3,$4,'ready',10)`,[id,user,workspace,randomUUID()]);
  await tx.query(`INSERT INTO ${schema}.resource_refs VALUES($1,$2,$3,'note','first'),($1,$2,$3,'note','second')`,[id,user,workspace]);
  return {id,user};
 }
 it('initializes exact reference counts, keeps UUID identity and permits only user-scoped deletion tasks without a workspace',async()=>fixture(async(tx,schema)=>{
  const f=await resources(tx,schema);await tx.query(sql(11,schema));
  expect((await tx.query(`SELECT reference_count FROM ${schema}.resources WHERE resource_id=$1`,[f.id])).rows[0].reference_count).toBe('2');
  expect((await tx.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='resources' AND column_name IN ('workspace_id','upload_id','processing_status','deleted_at','content_md5')",[schema])).rows).toEqual([]);
  expect((await tx.query("SELECT has_table_privilege('huahuo_worker',$1,'DELETE') AS allowed,has_column_privilege('huahuo_worker',$2,'completed_at','UPDATE') AS stamp",[`${schema}.resources`,`${schema}.storage_jobs`])).rows[0]).toEqual({allowed:true,stamp:true});
  await tx.query(`INSERT INTO ${schema}.resources(resource_id,user_id,status,size_bytes) VALUES($1,$2,'ready',10)`,[randomUUID(),f.user]);
  expect((await tx.query(`SELECT count(*)::int n FROM ${schema}.resources WHERE user_id=$1`,[f.user])).rows[0].n).toBe(2);
  await tx.query(`INSERT INTO ${schema}.resource_refs VALUES($1,$2,NULL,'avatar','owner')`,[f.id,f.user]);
  await tx.query(`INSERT INTO ${schema}.tasks VALUES($1,$2,NULL,'storage.delete')`,[randomUUID(),f.user]);
  await tx.query('SAVEPOINT business_scope');
  await expect(tx.query(`INSERT INTO ${schema}.tasks VALUES($1,$2,NULL,'text.ingest')`,[randomUUID(),f.user])).rejects.toMatchObject({code:'23514'});
  await tx.query('ROLLBACK TO SAVEPOINT business_scope');
 }));
 it('refuses cross-user reference corruption before changing resource ownership or counters',async()=>fixture(async(tx,schema)=>{
  await resources(tx,schema);await tx.query(`UPDATE ${schema}.resource_refs SET user_id=$1`,[randomUUID()]);
  await tx.query('SAVEPOINT migration_start');
  await expect(tx.query(sql(11,schema))).rejects.toThrow('RESOURCE_REFERENCE_OWNER_MISMATCH');
  await tx.query('ROLLBACK TO SAVEPOINT migration_start');
  expect((await tx.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='resources' AND column_name='workspace_id'",[schema])).rows).toHaveLength(1);
 }));
 it('moves note grouping into relationships while preserving owners, identity, bodies and attachments',async()=>fixture(async(tx,schema)=>{
  await tx.query(`CREATE TABLE ${schema}.workspaces(id uuid PRIMARY KEY,user_id uuid NOT NULL);
   CREATE TABLE ${schema}.asset_folders(folder_id uuid PRIMARY KEY,workspace_id uuid NOT NULL);
   CREATE TABLE ${schema}.notes(note_id uuid PRIMARY KEY,workspace_id uuid NOT NULL,folder_id uuid,
    deleted_by_folder_id uuid,title text NOT NULL,state text NOT NULL DEFAULT 'active',
    note_revision_id uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
   CREATE INDEX notes_scope ON ${schema}.notes(workspace_id,state,updated_at,note_id);
   CREATE INDEX notes_graph_page ON ${schema}.notes(workspace_id,note_id) WHERE state='active';
   CREATE TABLE ${schema}.note_parts(note_id uuid PRIMARY KEY,content_markdown text NOT NULL);
   CREATE TABLE ${schema}.note_resource_refs(note_id uuid NOT NULL,resource_id uuid NOT NULL);`);
  const workspace=randomUUID(),owner=randomUUID(),folder=randomUUID(),note=randomUUID(),
   rootNote=randomUUID(),revision=randomUUID(),attachment=randomUUID();
  await tx.query(`INSERT INTO ${schema}.workspaces VALUES($1,$2)`,[workspace,owner]);
  await tx.query(`INSERT INTO ${schema}.asset_folders VALUES($1,$2)`,[folder,workspace]);
  await tx.query(`INSERT INTO ${schema}.notes(note_id,workspace_id,folder_id,deleted_by_folder_id,title,state,note_revision_id)
    VALUES($1,$3,$4,$4,'old folder note','deleted',$5),($2,$3,NULL,NULL,'old root note','active',$5)`,
   [note,rootNote,workspace,folder,revision]);
  await tx.query(`INSERT INTO ${schema}.note_parts VALUES($1,'retained Markdown')`,[note]);
  await tx.query(`INSERT INTO ${schema}.note_resource_refs VALUES($1,$2)`,[note,attachment]);

  await tx.query('SAVEPOINT before_bad_link');
  await tx.query(`UPDATE ${schema}.asset_folders SET workspace_id=$1`,[randomUUID()]);
  await expect(tx.query(sql(19,schema))).rejects.toThrow('NOTE_FOLDER_SCOPE_MISMATCH');
  await tx.query('ROLLBACK TO SAVEPOINT before_bad_link');
  await tx.query(sql(19,schema));

  expect((await tx.query(`SELECT note_id,user_id,note_revision_id,state FROM ${schema}.notes ORDER BY title`)).rows).toEqual([
   {note_id:note,user_id:owner,note_revision_id:revision,state:'deleted'},
   {note_id:rootNote,user_id:owner,note_revision_id:revision,state:'active'},
  ]);
  expect((await tx.query(`SELECT * FROM ${schema}.note_workspaces`)).rows).toEqual(expect.arrayContaining([
   {workspace_id:workspace,note_id:note},{workspace_id:workspace,note_id:rootNote},
  ]));
  expect((await tx.query(`SELECT * FROM ${schema}.note_folders`)).rows)
   .toEqual([{folder_id:folder,note_id:note,deleted_by_folder_id:folder}]);
  expect((await tx.query(`SELECT * FROM ${schema}.note_parts`)).rows).toEqual([{note_id:note,content_markdown:'retained Markdown'}]);
  expect((await tx.query(`SELECT * FROM ${schema}.note_resource_refs`)).rows).toEqual([{note_id:note,resource_id:attachment}]);
  expect((await tx.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='notes' AND column_name IN ('workspace_id','folder_id','deleted_by_folder_id')",[schema])).rows).toEqual([]);
  await tx.query(`INSERT INTO ${schema}.notes(note_id,user_id,title,note_revision_id) VALUES($1,$2,'unplaced content',$3)`,[randomUUID(),owner,randomUUID()]);
  expect((await tx.query(`SELECT count(*)::int AS n FROM ${schema}.note_workspaces`)).rows[0].n).toBe(2);
 }));
 it('renames the version 19 model and allows assets to be read and updated with their original links',async()=>fixture(async(tx,schema)=>{
  await tx.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
  await tx.query('CREATE TABLE schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for(const migration of migrations.filter(file=>file.version<=19)){
   await tx.query(migration.sql.replace(/\bpublic\b/g,schema));
  }
  const userId=randomUUID(),workspaceId=randomUUID(),folderId=randomUUID(),assetId=randomUUID(),revisionId=randomUUID();
  await tx.query("INSERT INTO workspaces(id,user_id,display_name,bootstrap_receipt_id) VALUES($1,$2,'seeded workspace',gen_random_uuid())",
   [workspaceId,userId]);
  await tx.query("INSERT INTO asset_folders(folder_id,workspace_id,display_name,normalized_name,current_revision_id) VALUES($1,$2,'seeded folder','seeded folder',gen_random_uuid())",
   [folderId,workspaceId]);
  await tx.query("INSERT INTO notes(note_id,user_id,title,note_revision_id,etag) VALUES($1,$2,'fixture asset',$3,'fixture-etag')",
   [assetId,userId,revisionId]);
  await tx.query('INSERT INTO note_workspaces(workspace_id,note_id) VALUES($1,$2)',[workspaceId,assetId]);
  await tx.query('INSERT INTO note_folders(folder_id,note_id) VALUES($1,$2)',[folderId,assetId]);
  await tx.query("INSERT INTO note_parts(part_revision_id,note_id,part,revision,content_markdown,content_sha256) VALUES(gen_random_uuid(),$1,'raw',1,'seeded Markdown',repeat('0',64))",
   [assetId]);

  await tx.query(sql(20,schema));

  expect((await tx.query("SELECT to_regclass('notes') AS old_table")).rows[0].old_table).toBeNull();
  expect((await tx.query(
   `SELECT a.content_asset_id, a.user_id, a.content_asset_revision_id, f.folder_id, w.workspace_id, p.content_markdown
     FROM content_assets a JOIN content_asset_parts p USING(content_asset_id)
     JOIN content_asset_workspaces w USING(content_asset_id)
     JOIN content_asset_folders f USING(content_asset_id) WHERE a.content_asset_id=$1`,[assetId],
  )).rows).toEqual([{
   content_asset_id:assetId,user_id:userId,content_asset_revision_id:revisionId,
   folder_id:folderId,workspace_id:workspaceId,content_markdown:'seeded Markdown',
  }]);
  expect((await tx.query("UPDATE content_assets SET title='updated' WHERE content_asset_id=$1 RETURNING title",[assetId])).rows).toEqual([{title:'updated'}]);
  expect((await tx.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='content_asset_folders' AND column_name='deleted_by_folder_id'",[schema])).rows).toEqual([]);
 }));

 it('moves populated current assets, labels, runs and index jobs onto account ownership',async()=>fixture(async(tx,schema)=>{
  await tx.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
  await tx.query('CREATE TABLE schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for(const migration of migrations.filter(file=>file.version<=22))await tx.query(migration.sql.replace(/\bpublic\b/g,schema));

  const userId=randomUUID(),firstWorkspace=randomUUID(),secondWorkspace=randomUUID(),assetId=randomUUID(),revision=randomUUID();
  const folderId=randomUUID(),resourceId=randomUUID(),manualTag=randomUUID(),extractedTag=randomUUID();
  const runId=randomUUID(),buildId=randomUUID(),oldTaskId=randomUUID(),inputId=randomUUID();
  await tx.query(`INSERT INTO workspaces(id,user_id,display_name,bootstrap_receipt_id)
   VALUES($1,$3,'first',gen_random_uuid()),($2,$3,'second',gen_random_uuid())`,[firstWorkspace,secondWorkspace,userId]);
  await tx.query(`INSERT INTO content_assets(content_asset_id,user_id,title,content_asset_revision_id,etag,processing_status)
   VALUES($1,$2,'existing asset',$3,'asset-etag','ready')`,[assetId,userId,revision]);
  await tx.query('INSERT INTO content_asset_workspaces(workspace_id,content_asset_id) VALUES($1,$3),($2,$3)',[firstWorkspace,secondWorkspace,assetId]);
  await tx.query(`INSERT INTO content_asset_parts(part_revision_id,content_asset_id,part,revision,content_markdown,content_sha256)
   VALUES($1,$2,'raw',1,'existing body',repeat('a',64))`,[revision,assetId]);
  await tx.query(`INSERT INTO asset_folders(folder_id,workspace_id,display_name,normalized_name,current_revision_id)
   VALUES($1,$2,'drafts','drafts',gen_random_uuid())`,[folderId,firstWorkspace]);
  await tx.query('INSERT INTO content_asset_folders(folder_id,content_asset_id) VALUES($1,$2)',[folderId,assetId]);
  await tx.query(`INSERT INTO asset_tags(tag_id,workspace_id,normalized_name,display_name,source)
    VALUES($1,$2,'draft','Draft','manual'),($3,$4,'draft','Draft','extracted')`,[manualTag,firstWorkspace,extractedTag,secondWorkspace]);
  await tx.query(`INSERT INTO content_asset_tags(content_asset_id,tag_id,source)
   VALUES($1,$2,'manual'),($1,$3,'extracted')`,[assetId,manualTag,extractedTag]);
  await tx.query(`INSERT INTO resource_refs(resource_id,user_id,workspace_id,ref_kind,ref_id_external)
   VALUES($1,$2,$3,'content_asset',$4)`,[resourceId,userId,firstWorkspace,assetId]);
  await tx.query('INSERT INTO workspace_content_state(workspace_id,next_cursor) VALUES($1,3),($2,7)',[firstWorkspace,secondWorkspace]);
  await tx.query(`INSERT INTO content_events(event_id,workspace_id,cursor,operation_id,object_kind,object_id,change_type)
   SELECT gen_random_uuid(),workspace_id,1,gen_random_uuid(),'content_asset',$3,'created'
   FROM unnest(ARRAY[$1::uuid,$2::uuid]) AS event(workspace_id)`,[firstWorkspace,secondWorkspace,assetId]);
  await tx.query(`INSERT INTO ai_template_runs(id,user_id,workspace_id,scene_key,item_key,template_version,idempotency_key,request_hash,trace_id,deadline_at)
   VALUES($1,$2,$3,'editor_polish','polish',1,'owned-run','request-hash','trace',now())`,[runId,userId,firstWorkspace]);
  await tx.query('INSERT INTO task_inputs(id,user_id,workspace_id,body) VALUES($1,$2,$3,$4)',[inputId,userId,firstWorkspace,JSON.stringify({buildId})]);
  await tx.query(`INSERT INTO tasks(id,user_id,workspace_id,kind,queue,input_id,state,trace_id)
   VALUES($1,$2,$3,'kb.content-asset-index','content',$4,'queued',gen_random_uuid()::text)`,[oldTaskId,userId,firstWorkspace,inputId]);
  await tx.query(`INSERT INTO kb_content_asset_hybrid_builds(id,source_type,source_id,source_revision,user_id,workspace_id,task_id,content_hash,config_hash,snapshot)
   VALUES($1,'content_asset',$2,$3,$4,$5,$6,repeat('a',64),repeat('b',64),$7)`,
  [buildId,assetId,revision,userId,firstWorkspace,oldTaskId,{mode:'hybrid',target:{collection:'fixture_sparse_v1'}}]);

  await tx.query(sql(23,schema));

  expect((await tx.query("SELECT to_regclass('content_asset_workspaces') AS old")).rows[0].old).toBeNull();
  expect((await tx.query(`SELECT a.user_id,a.content_asset_revision_id,p.content_markdown,af.folder_id,r.resource_id,r.workspace_id
   FROM content_assets a JOIN content_asset_parts p USING(content_asset_id) JOIN content_asset_folders af USING(content_asset_id)
   JOIN resource_refs r ON r.ref_id_external=a.content_asset_id::text WHERE a.content_asset_id=$1`,[assetId])).rows[0]).toEqual({
    user_id:userId,content_asset_revision_id:revision,content_markdown:'existing body',folder_id:folderId,resource_id:resourceId,workspace_id:null,
  });
  expect((await tx.query('SELECT t.tag_id,t.user_id,m.source FROM asset_tags t JOIN content_asset_tags m USING(tag_id)')).rows)
   .toEqual([{tag_id:manualTag,user_id:userId,source:'manual'}]);
  expect((await tx.query('SELECT user_id,next_cursor FROM account_content_state')).rows).toEqual([{user_id:userId,next_cursor:'7'}]);
  expect((await tx.query('SELECT cursor FROM content_events WHERE user_id=$1 ORDER BY cursor',[userId])).rows).toEqual([{cursor:'1'},{cursor:'2'}]);
  expect((await tx.query('SELECT id,user_id,idempotency_key FROM ai_template_runs')).rows).toEqual([{id:runId,user_id:userId,idempotency_key:'owned-run'}]);
  expect((await tx.query("SELECT state FROM tasks WHERE id=$1",[oldTaskId])).rows[0]).toEqual({state:'cancelled'});
  expect((await tx.query(`SELECT b.status,b.published,b.snapshot,t.state,t.workspace_id,(i.body::jsonb)->>'buildId' AS build_id
   FROM kb_content_asset_hybrid_builds b JOIN tasks t ON t.id=b.task_id JOIN task_inputs i ON i.id=t.input_id JOIN task_outbox o ON o.task_id=t.id
   WHERE b.id=$1`,[buildId])).rows).toEqual([{status:'pending',published:false,snapshot:{mode:'hybrid',target:{collection:'fixture_sparse_v1_account_v1'},accountScope:true},
    state:'queued',workspace_id:null,build_id:buildId}]);

  const hiddenFolder=randomUUID(),hiddenAsset=randomUUID(),unfiledAsset=randomUUID();
  await tx.query(`INSERT INTO asset_folders(folder_id,user_id,display_name,normalized_name,current_revision_id,state)
   VALUES($1,$2,'retired','retired',gen_random_uuid(),'deleted')`,[hiddenFolder,userId]);
  await tx.query(`INSERT INTO content_assets(content_asset_id,user_id,title,content_asset_revision_id,etag)
   VALUES($1,$3,'hidden placement',gen_random_uuid(),'hidden'),($2,$3,'unfiled',gen_random_uuid(),'unfiled')`,[hiddenAsset,unfiledAsset,userId]);
  await tx.query('INSERT INTO content_asset_folders(folder_id,content_asset_id) VALUES($1,$2)',[hiddenFolder,hiddenAsset]);

  await tx.query(sql(24,schema));

  expect((await tx.query("SELECT to_regclass('content_asset_folders') AS old")).rows[0].old).toBeNull();
  const placements=(await tx.query('SELECT content_asset_id,folder_id FROM content_assets')).rows;
  expect(placements).toHaveLength(3);
  expect(placements).toEqual(expect.arrayContaining([
   {content_asset_id:assetId,folder_id:folderId},
   {content_asset_id:hiddenAsset,folder_id:hiddenFolder},
   {content_asset_id:unfiledAsset,folder_id:null},
  ]));
 }));

 it.each([
  ['multiple folders', 'duplicate_assets=1, orphan_links=0, cross_account_links=0'],
  ['missing folder', 'duplicate_assets=0, orphan_links=1, cross_account_links=0'],
  ['missing asset', 'duplicate_assets=0, orphan_links=1, cross_account_links=0'],
  ['another account', 'duplicate_assets=0, orphan_links=0, cross_account_links=1'],
 ])('rejects legacy placement with %s before changing the schema',async (kind,error)=>fixture(async(tx,schema)=>{
  await tx.query(`SET LOCAL search_path TO ${schema}, pg_catalog;
   CREATE TABLE content_assets(content_asset_id uuid PRIMARY KEY,user_id uuid NOT NULL);
   CREATE TABLE asset_folders(folder_id uuid PRIMARY KEY,user_id uuid NOT NULL);
   CREATE TABLE content_asset_folders(folder_id uuid,content_asset_id uuid,PRIMARY KEY(folder_id,content_asset_id));`);
  const owner=randomUUID(),other=randomUUID(),asset=randomUUID(),folder=randomUUID(),second=randomUUID();
  await tx.query('INSERT INTO content_assets VALUES($1,$2)',[asset,owner]);
  await tx.query('INSERT INTO asset_folders VALUES($1,$3),($2,$4)',[folder,second,owner,kind==='another account'?other:owner]);
  if(kind==='multiple folders')await tx.query('INSERT INTO content_asset_folders VALUES($1,$3),($2,$3)',[folder,second,asset]);
  else await tx.query('INSERT INTO content_asset_folders VALUES($1,$2)',[kind==='missing folder'?randomUUID():second,kind==='missing asset'?randomUUID():asset]);

  await tx.query('SAVEPOINT invalid_placement');
  await expect(tx.query(sql(24,schema))).rejects.toThrow(error);
  await tx.query('ROLLBACK TO SAVEPOINT invalid_placement');
  expect((await tx.query("SELECT to_regclass('content_asset_folders') AS old")).rows[0].old).toBe('content_asset_folders');
  expect((await tx.query(`SELECT column_name FROM information_schema.columns
   WHERE table_schema=$1 AND table_name='content_assets' AND column_name='folder_id'`,[schema])).rows).toEqual([]);
 }));
 it('requires legacy index maintenance and assigns types without creating rebuild tasks',async()=>fixture(async(tx,schema)=>{
  await tx.query(`SET LOCAL search_path TO ${schema}, pg_catalog;
   CREATE TABLE content_assets(content_asset_id uuid PRIMARY KEY,source_kind text);
   CREATE TABLE kb_content_asset_hybrid_builds(id uuid);
   CREATE TABLE kb_content_asset_hybrid_chunks(point_id text);
   CREATE TABLE tasks(kind text,state text);
   INSERT INTO content_assets VALUES(gen_random_uuid(),'recording'),(gen_random_uuid(),'photo'),(gen_random_uuid(),'manual');
   INSERT INTO kb_content_asset_hybrid_builds VALUES(gen_random_uuid());`);
  await tx.query('SAVEPOINT occupied');
  await expect(tx.query(sql(25,schema))).rejects.toThrow('CONTENT_ASSET_LEGACY_INDEX_MAINTENANCE_REQUIRED');
  await tx.query('ROLLBACK TO SAVEPOINT occupied');
  await tx.query('DELETE FROM kb_content_asset_hybrid_builds');
  await tx.query(sql(25,schema));
  expect((await tx.query('SELECT asset_kind FROM content_assets ORDER BY asset_kind')).rows)
   .toEqual([{asset_kind:'audio'},{asset_kind:'creative'},{asset_kind:'image'}]);
  expect((await tx.query('SELECT * FROM tasks')).rows).toEqual([]);
 }));

 it('classifies legacy explicit link sources without changing other kinds, metadata or tasks',async()=>fixture(async(tx,schema)=>{
  await tx.query(`SET LOCAL search_path TO ${schema}, pg_catalog;
   CREATE TABLE content_assets(content_asset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title text,source_kind text,source_id text,
    created_at timestamptz DEFAULT '2026-01-01T00:00:00.123456Z',updated_at timestamptz DEFAULT '2026-02-01T00:00:00.654321Z');
   CREATE TABLE kb_content_asset_hybrid_builds(id uuid);
   CREATE TABLE kb_content_asset_hybrid_chunks(point_id text);
   CREATE TABLE tasks(kind text,state text);`);
  await tx.query(sql(25,schema));
  await tx.query(`INSERT INTO content_assets(title,source_kind,source_id,asset_kind) VALUES
   ('legacy link',' LiNk ','https://example.invalid/article','creative'),
   ('link-sourced image','link','https://example.invalid/image.png','image'),
   ('link-sourced file','link','https://example.invalid/report.pdf','file'),
   ('imported file','import','https://example.invalid/document','file'),
   ('creative with URL','manual','https://example.invalid/reference','creative'),
   ('recording','recording',NULL,'audio');
   INSERT INTO tasks VALUES('unrelated.job','queued');`);
  const read = async()=> (await tx.query(`SELECT content_asset_id,title,source_kind,source_id,asset_kind,
   created_at::text AS created_at,updated_at::text AS updated_at FROM content_assets ORDER BY title`)).rows;
  const before = await read();

  await tx.query(sql(26,schema));

  expect(await read()).toEqual(before.map(row=>row.title==='legacy link'?{...row,asset_kind:'link'}:row));
  expect((await tx.query('SELECT * FROM tasks')).rows).toEqual([{kind:'unrelated.job',state:'queued'}]);
  expect((await tx.query(`INSERT INTO content_assets(title,source_kind) VALUES('new default','manual')
   RETURNING asset_kind`)).rows).toEqual([{asset_kind:'creative'}]);
  expect((await tx.query(`INSERT INTO content_assets(title,source_kind,asset_kind) VALUES('new link','manual','link')
   RETURNING asset_kind`)).rows).toEqual([{asset_kind:'link'}]);
  await tx.query('SAVEPOINT invalid_kind');
  await expect(tx.query(`INSERT INTO content_assets(title,source_kind,asset_kind) VALUES('invalid','manual','other')`))
   .rejects.toMatchObject({code:'23514'});
  await tx.query('ROLLBACK TO SAVEPOINT invalid_kind');
 }));


 it('backfills legacy asset content status and enforces the four supported values',async()=>fixture(async(tx,schema)=>{
  await tx.query(`SET LOCAL search_path TO ${schema}, pg_catalog;
   CREATE TABLE content_assets(
    content_asset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    state text NOT NULL DEFAULT 'active',
    processing_status text NOT NULL DEFAULT 'ready',
    updated_at timestamptz NOT NULL DEFAULT '2026-02-01T00:00:00.654321Z',
    CONSTRAINT content_assets_processing_status_check CHECK (processing_status IN ('ready','needs-processing'))
   );
   INSERT INTO content_assets(title,state,processing_status) VALUES
    ('empty asset','active','needs-processing'),
    ('deleted asset','deleted','needs-processing'),
    ('usable asset','active','ready');`);
  const read = async()=> (await tx.query(`SELECT content_asset_id,title,state,processing_status,
   updated_at::text AS updated_at FROM content_assets ORDER BY title`)).rows;
  const before = await read();

  await tx.query(sql(27,schema));

  expect(await read()).toEqual(before.map(row=>row.processing_status==='needs-processing'?{...row,processing_status:'draft'}:row));
  expect((await tx.query(`INSERT INTO content_assets(title) VALUES ('default asset')
   RETURNING processing_status`)).rows).toEqual([{processing_status:'ready'}]);
  const statuses = ['draft','failed','processing','ready'];
  const inserted = await tx.query<{processing_status:string}>(`INSERT INTO content_assets(title,processing_status)
    SELECT 'new ' || status,status FROM unnest($1::text[]) AS supplied(status)
    RETURNING processing_status`,[statuses]);
  expect(inserted.rows.map(row=>row.processing_status).sort()).toEqual(statuses);
  await tx.query('SAVEPOINT invalid_status');
  await expect(tx.query(`INSERT INTO content_assets(title,processing_status) VALUES ('legacy writer','needs-processing')`))
   .rejects.toMatchObject({code:'23514',constraint:'content_assets_processing_status_check'});
  await tx.query('ROLLBACK TO SAVEPOINT invalid_status');
 }));

});
