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
});
