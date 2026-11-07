import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../../src/config/config.js';
import { migrate } from '../../src/db/migrate.js';
import type pg from 'pg';
import { poolFor } from '../../src/plugins/dependencies.js';

// Dedicated experiment only: its runner creates an otherwise unused temporary
// database. It is not included in the normal tests/integration suite.
const ownerUrl=process.env.TEST_SCHEMA_ARCHIVE_OWNER_URL;
const migrationUrl=process.env.TEST_DATABASE_MIGRATION_URL;
const apiUrl=process.env.TEST_DATABASE_API_URL;
const adminUrl=process.env.TEST_DATABASE_ADMIN_URL;
for(const url of [ownerUrl,migrationUrl,apiUrl,adminUrl]){
 if(!url)throw new Error('DEDICATED_SCHEMA_ARCHIVE_RUNNER_REQUIRED');
 const parsed=new URL(url);
 if(parsed.hostname!=='127.0.0.1'||!/^huahuo_test_[a-z0-9_]+$/.test(parsed.pathname.slice(1)))throw new Error('LOCAL_ISOLATED_TEST_DATABASE_REQUIRED');
}
const config=loadConfig('migrate',{DATABASE_URL:adminUrl});
const owner=poolFor({...config,databaseUrl:ownerUrl!});
const migrator=poolFor({...config,databaseUrl:migrationUrl!});
const operator=poolFor(config);
const api=poolFor({...config,databaseUrl:apiUrl!});
const roles=['huahuo_api','huahuo_admin','huahuo_worker','huahuo_scheduler'];
const archivePrincipals=['pg_database_owner','huahuo_migrator',...roles];
const roleList=['PUBLIC',...archivePrincipals].join(',');
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
let before:{namespace_oid:number;objects:unknown[];functions:unknown[];notes:unknown[];view:unknown[];sequences:unknown[];ledger:unknown[]};
async function catalogSnapshot(schema:string,db:pg.Pool|pg.PoolClient=operator){
 const namespace=(await db.query<{oid:number}>('SELECT oid FROM pg_namespace WHERE nspname=$1',[schema])).rows[0]!;
 const objects=(await db.query(`SELECT c.oid,c.relname,c.relkind,c.relfilenode FROM pg_class c WHERE c.relnamespace=$1 ORDER BY c.oid`,[namespace.oid])).rows;
 const functions=(await db.query('SELECT oid,proname FROM pg_proc WHERE pronamespace=$1 ORDER BY oid',[namespace.oid])).rows;
 return{namespace_oid:namespace.oid,objects,functions};
}
async function snapshot(schema:string,db:pg.Pool|pg.PoolClient=operator){
 return{...await catalogSnapshot(schema,db),
  notes:(await db.query(`SELECT * FROM ${quote(schema)}.notes ORDER BY id`)).rows,
  view:(await db.query(`SELECT * FROM ${quote(schema)}.rag_chunks ORDER BY chunk_key`)).rows,
  sequences:[(await db.query(`SELECT last_value,is_called FROM ${quote(schema)}.notes_id_seq`)).rows[0],(await db.query(`SELECT last_value,is_called FROM ${quote(schema)}.old_standalone_counter`)).rows[0]],
  ledger:(await db.query(`SELECT * FROM ${quote(schema)}.schema_migrations ORDER BY version`)).rows,
 };
}
describe('isolated PostgreSQL namespace archival safety experiment',()=>{
 beforeAll(async()=>{
  await owner.query(`ALTER DATABASE ${quote(new URL(ownerUrl!).pathname.slice(1))} OWNER TO huahuo_admin`);
  await owner.query(`BEGIN;SET LOCAL ROLE huahuo_admin;CREATE TABLE public.notes(id serial PRIMARY KEY,title text NOT NULL,search_vector text,tag_set_version integer NOT NULL DEFAULT 0);
   CREATE TABLE public.note_part_revisions(note_id integer,content_markdown text);
   CREATE TABLE public.old_only(id integer PRIMARY KEY,payload text);
   INSERT INTO public.old_only VALUES(1,'retained archive fixture');
   CREATE TABLE public.schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());
   INSERT INTO public.schema_migrations(version,checksum) VALUES(18,repeat('a',64));
   CREATE SEQUENCE public.old_standalone_counter START WITH 7;
   SELECT nextval('public.old_standalone_counter');
   CREATE FUNCTION public.note_tags_lifecycle_fence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.tag_set_version:=OLD.tag_set_version+1;RETURN NEW;END $$;
   CREATE FUNCTION public.notes_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.search_vector:=(SELECT content_markdown FROM note_part_revisions WHERE note_id=NEW.id LIMIT 1);RETURN NEW;END $$;
   CREATE TRIGGER note_tags_lifecycle_fence BEFORE UPDATE ON public.notes FOR EACH ROW EXECUTE FUNCTION public.note_tags_lifecycle_fence();
   CREATE TRIGGER notes_search_vector_trigger BEFORE INSERT OR UPDATE OF title ON public.notes FOR EACH ROW EXECUTE FUNCTION public.notes_search_vector_update();
   INSERT INTO public.notes(title) VALUES('old note');
   INSERT INTO public.note_part_revisions VALUES(1,'old original text');
   UPDATE public.notes SET title='old note' WHERE id=1;
   CREATE VIEW public.rag_chunks AS SELECT id AS chunk_key,title,search_vector FROM public.notes;
   GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON public.notes TO huahuo_api;
   GRANT SELECT(title),UPDATE(title),REFERENCES(title) ON public.notes TO huahuo_worker;
   GRANT SELECT,USAGE,UPDATE ON SEQUENCE public.notes_id_seq,public.old_standalone_counter TO huahuo_worker;
   GRANT EXECUTE ON FUNCTION public.note_tags_lifecycle_fence(),public.notes_search_vector_update() TO PUBLIC;COMMIT;`);
  before=await snapshot('public');
 });
 afterAll(async()=>{await Promise.all([owner.end(),migrator.end(),operator.end(),api.end()]);});
 it('requires ownership to rename the original public namespace',async()=>{
  await expect(migrator.query('ALTER SCHEMA public RENAME TO forbidden_rename_probe')).rejects.toMatchObject({code:'42501'});
  expect((await snapshot('public')).namespace_oid).toBe(before.namespace_oid);
 });
 it('rolls back an interrupted namespace rename and all fresh-public objects atomically',async()=>{
  const client=await operator.connect();
  try{
   await client.query('BEGIN');
   await client.query('ALTER SCHEMA public RENAME TO initialization_backup;CREATE SCHEMA public;CREATE TABLE public.rollback_probe(id int)');
   await expect(client.query('SELECT 1/0')).rejects.toMatchObject({code:'22012'});
   await client.query('ROLLBACK');
  }finally{client.release();}
  expect(await snapshot('public')).toEqual(before);
  expect((await owner.query("SELECT to_regnamespace('initialization_backup') AS backup,to_regclass('public.rollback_probe') AS probe")).rows[0]).toEqual({backup:null,probe:null});
 });
 it('archives the complete namespace and initializes the exact new baseline without removing old rows',async()=>{
  const initial=await readFile('migrations/0001_initial_schema.sql','utf8');
  const checksum=createHash('sha256').update(initial).digest('hex');
  const client=await operator.connect();
  try{
   await client.query('BEGIN');
   await client.query('ALTER SCHEMA public RENAME TO initialization_backup;CREATE SCHEMA public AUTHORIZATION pg_database_owner;GRANT USAGE,CREATE ON SCHEMA public TO huahuo_migrator');
   await client.query('ALTER FUNCTION initialization_backup.note_tags_lifecycle_fence() SET search_path=pg_catalog,initialization_backup,pg_temp');
   await client.query('ALTER FUNCTION initialization_backup.notes_search_vector_update() SET search_path=pg_catalog,initialization_backup,pg_temp');
   expect(await snapshot('initialization_backup',client)).toEqual(before);
   await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA initialization_backup FROM ${roleList};
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA initialization_backup FROM ${roleList};
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA initialization_backup FROM ${roleList}`);
   const columns=(await client.query<{table_name:string;columns:string[]}>(`SELECT t.relname AS table_name,array_agg(a.attname::text ORDER BY a.attnum) AS columns
     FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_attribute a ON a.attrelid=t.oid
     WHERE n.nspname='initialization_backup' AND t.relkind IN ('r','v') AND a.attnum>0 AND NOT a.attisdropped GROUP BY t.relname`)).rows;
   for(const table of columns){const names=table.columns.map(quote).join(',');await client.query(`REVOKE SELECT(${names}),INSERT(${names}),UPDATE(${names}),REFERENCES(${names}) ON initialization_backup.${quote(table.table_name)} FROM ${roleList}`);}
   await client.query(`REVOKE ALL ON SCHEMA initialization_backup FROM ${roleList}`);
   await client.query('CREATE TABLE public.schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
   await client.query(initial);
   await client.query('INSERT INTO public.schema_migrations(version,checksum) VALUES(1,$1)',[checksum]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  expect(await catalogSnapshot('initialization_backup')).toEqual({namespace_oid:before.namespace_oid,objects:before.objects,functions:before.functions});
  expect((await owner.query('SELECT count(*)::int AS n FROM public.users')).rows[0].n).toBe(0);
  expect((await owner.query("SELECT to_regclass('public.old_only') AS old_table,to_regclass('public.old_standalone_counter') AS old_sequence")).rows[0]).toEqual({old_table:null,old_sequence:null});
  expect((await owner.query('SELECT version,checksum FROM public.schema_migrations')).rows).toEqual([{version:1,checksum}]);
  expect((await owner.query('SELECT count(*)::int AS n FROM public.rag_chunks')).rows[0].n).toBe(0);
 });
 it('removes runtime and inherited database-owner access while preserving explicit recovery rights',async()=>{
  for(const role of archivePrincipals){
   const result=(await owner.query(`SELECT has_schema_privilege($1,'initialization_backup','USAGE,CREATE') AS schema_access,
    has_table_privilege($1,'initialization_backup.notes','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS table_access,
    has_column_privilege($1,'initialization_backup.notes','title','SELECT,INSERT,UPDATE,REFERENCES') AS column_access,
    has_sequence_privilege($1,'initialization_backup.notes_id_seq','USAGE,UPDATE') AS sequence_access,
    has_function_privilege($1,'initialization_backup.notes_search_vector_update()','EXECUTE') AS function_access`,[role])).rows[0];
   expect(Object.values(result).every(value=>value===false),role).toBe(true);
  }
  expect((await owner.query("SELECT r.rolname AS owner FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=current_database()")).rows[0].owner).toBe('huahuo_admin');
  expect((await owner.query("SELECT n.nspname,r.rolname AS owner FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname IN ('public','initialization_backup') ORDER BY n.nspname")).rows).toEqual([{nspname:'initialization_backup',owner:'pg_database_owner'},{nspname:'public',owner:'pg_database_owner'}]);
  await expect(api.query('SELECT * FROM initialization_backup.notes')).rejects.toMatchObject({code:'42501'});
  await expect(operator.query('SELECT * FROM initialization_backup.notes')).rejects.toMatchObject({code:'42501'});
 });
 it('permits explicit administrator recovery inside a rolled-back probe without leaving runtime access',async()=>{
  const client=await operator.connect();
  try{
   await client.query('BEGIN');
   await client.query(`GRANT USAGE ON SCHEMA initialization_backup TO huahuo_admin;
    GRANT SELECT,UPDATE ON initialization_backup.notes TO huahuo_admin;
    GRANT SELECT ON initialization_backup.note_part_revisions TO huahuo_admin;
    GRANT EXECUTE ON FUNCTION initialization_backup.note_tags_lifecycle_fence(),initialization_backup.notes_search_vector_update() TO huahuo_admin`);
   const row=(await client.query("UPDATE initialization_backup.notes SET title='trigger probe' WHERE id=1 RETURNING search_vector,tag_set_version")).rows[0];
   expect(row).toEqual({search_vector:'old original text',tag_set_version:2});
   await client.query('ROLLBACK');
  }finally{client.release();}
  expect(await catalogSnapshot('initialization_backup')).toEqual({namespace_oid:before.namespace_oid,objects:before.objects,functions:before.functions});
  expect((await operator.query("SELECT has_schema_privilege(current_user,'initialization_backup','USAGE,CREATE') AS allowed")).rows[0].allowed).toBe(false);
 });
 it('replays migrations against only the new public ledger and preserves the archived one',async()=>{
  expect(await migrate(config)).toEqual({applied:[],current:1});
  expect(await catalogSnapshot('initialization_backup')).toEqual({namespace_oid:before.namespace_oid,objects:before.objects,functions:before.functions});
 });
});
