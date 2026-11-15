import { describe,it,expect,vi } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { migrate } from '../../src/db/migrate.js';
import { loadMigrationFiles } from '../../src/db/migration-files.js';
import { poolFor,createDependencies,isReady } from '../../src/plugins/dependencies.js';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const testUrl=process.env.TEST_DATABASE_MIGRATION_URL;
if (!testUrl || !/^huahuo_test_[a-z0-9_]+$/.test(new URL(testUrl).pathname.slice(1))) {
 throw new Error('REAL_ISOLATED_TEST_DATABASE_REQUIRED: run scripts/integration.mjs');
}
const migrator=loadConfig('migrate',{DATABASE_URL:testUrl});
const migrationFiles=loadMigrationFiles(),currentVersion=migrationFiles.at(-1)!.version,nextVersion=currentVersion+1;
const nextFile=(suffix:string)=>`${String(nextVersion).padStart(4,'0')}_${suffix}.sql`;
const copyMigrations=async(directory:string)=>{for(const file of migrationFiles)await writeFile(join(directory,file.name),file.sql);};
describe('real PostgreSQL/Redis infrastructure',()=>{
 it('migration is repeatable and concurrent-safe',async()=>{
  const first=await migrate(migrator);expect(first.current).toBe(currentVersion);
  const repeated=await Promise.all([migrate(migrator),migrate(migrator)]);
  expect(repeated.every(r=>r.applied.length===0)).toBe(true);
 },20000);
 it('rejects checksum changes and rolls back a failed migration',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'p01-migration-'));
  const pool=poolFor(migrator);
  try {
   const original=await readFile('migrations/0001_initial_schema.sql','utf8');
   await copyMigrations(directory);
   await writeFile(join(directory,'0001_initial_schema.sql'),original+'\n-- changed');
   await expect(migrate(migrator,directory)).rejects.toThrow('MIGRATION_CHECKSUM_MISMATCH');
   await writeFile(join(directory,'0001_initial_schema.sql'),original);
   await writeFile(join(directory,nextFile('failure')),'CREATE TABLE rollback_probe(id int); SELECT missing_column FROM rollback_probe;');
   await expect(migrate(migrator,directory)).rejects.toThrow('MIGRATION_SQL_FAILED');
   expect((await pool.query("SELECT to_regclass('public.rollback_probe') AS name")).rows[0].name).toBeNull();
   expect((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n).toBe(migrationFiles.length);
  }finally{await pool.end();await rm(directory,{recursive:true,force:true});}
 });
 it('rolls back a new migration that attempts to introduce a physical foreign key',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'no-foreign-key-migration-'));
  const pool=poolFor(migrator);
  try{
   await copyMigrations(directory);
   await writeFile(join(directory,nextFile('foreign_key_probe')),'CREATE TABLE foreign_key_probe(id uuid PRIMARY KEY,user_id uuid REFERENCES users(id));');
   await expect(migrate(migrator,directory)).rejects.toThrow('MIGRATION_FOREIGN_KEYS_FORBIDDEN');
   expect((await pool.query("SELECT to_regclass('public.foreign_key_probe') AS name")).rows[0].name).toBeNull();
   expect((await pool.query('SELECT count(*)::int AS n FROM schema_migrations WHERE version=$1',[nextVersion])).rows[0].n).toBe(0);
  }finally{await pool.end();await rm(directory,{recursive:true,force:true});}
 });
 it('rejects foreign-key drift after the schema has already migrated',async()=>{
  const pool=poolFor(migrator);
  try{
   await pool.query('CREATE TABLE foreign_key_drift_probe(id uuid PRIMARY KEY,user_id uuid REFERENCES users(id))');
   await expect(migrate(migrator)).rejects.toThrow('DATABASE_FOREIGN_KEYS_FORBIDDEN');
  }finally{await pool.query('DROP TABLE IF EXISTS foreign_key_drift_probe');await pool.end();}
 });
 it('migration lock wait is bounded',async()=>{
  const pool=poolFor(migrator);const client=await pool.connect();
  try{
   await client.query('SELECT pg_advisory_lock(72701,1)');
   await expect(migrate({...migrator,migrationLockTimeoutMs:200})).rejects.toThrow('MIGRATION_LOCK_TIMEOUT');
  }finally{await client.query('SELECT pg_advisory_unlock(72701,1)');client.release();await pool.end();}
 });
 it.each(['api','admin','worker','scheduler'])('%s role connects without DDL or mutation privileges',async role=>{
  const url=process.env[`TEST_DATABASE_${role.toUpperCase()}_URL`];if(!url)throw new Error('TEST_ROLE_URL_REQUIRED');
  const pool=poolFor({...migrator,databaseUrl:url});
  try {
   expect((await pool.query('SELECT 1 AS n')).rows[0].n).toBe(1);
   const r=await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user');expect(r.rows[0]).toEqual({rolsuper:false,rolcreatedb:false,rolcreaterole:false});
   await expect(pool.query('CREATE TABLE should_never_exist(id int)')).rejects.toThrow();
   await expect(pool.query('UPDATE schema_migrations SET checksum=checksum')).rejects.toThrow();
   expect((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n).toBe(migrationFiles.length);
  }finally{await pool.end();}
 });
 it('Redis cache and queue round trip keys expire',async()=>{
  for(const name of ['REDIS_CACHE_URL','REDIS_QUEUE_URL']) {
   const url=process.env[name];if(!url||Number(new URL(url).pathname.slice(1))<10) throw new Error('TEST_REDIS_DB_REQUIRED');
   const redis=new Redis(url,{maxRetriesPerRequest:1});const key=`huahuo:p01:test:${randomUUID()}`;
   try{await redis.set(key,'value','PX',250);expect(await redis.get(key)).toBe('value');expect(await redis.pttl(key)).toBeGreaterThan(0);await vi.waitFor(async()=>expect(await redis.get(key)).toBeNull(),{timeout:3000,interval:50});}
   finally{await redis.del(key);redis.disconnect();}
  }
 });
 it('real readiness checks schema and both Redis clients',async()=>{
  const config={...migrator,role:'worker' as const,databaseUrl:process.env.TEST_DATABASE_WORKER_URL!,redisCacheUrl:process.env.REDIS_CACHE_URL!,redisQueueUrl:process.env.REDIS_QUEUE_URL!};
  const deps=createDependencies(config);
  try {let ready=false;for(let n=0;n<10;n++){if(isReady(await deps.check())){ready=true;break;}await new Promise(r=>setTimeout(r,200));}expect(ready).toBe(true);}
  finally{await deps.close();}
  const future=createDependencies({...config,schemaMinVersion:nextVersion});
  try{expect((await future.check()).schema).toBe(false);}finally{await future.close();}
 });
 it('rejects a different baseline even with a higher migration number and recovers after correction',async()=>{
  const config={...migrator,role:'worker' as const,databaseUrl:process.env.TEST_DATABASE_WORKER_URL!,redisCacheUrl:process.env.REDIS_CACHE_URL!,redisQueueUrl:process.env.REDIS_QUEUE_URL!};
  const pool=poolFor(migrator),deps=createDependencies(config);
  const original=(await pool.query<{checksum:string}>('SELECT checksum FROM schema_migrations WHERE version=1')).rows[0]!.checksum;
  try{
   await pool.query("UPDATE schema_migrations SET checksum=repeat('0',64) WHERE version=1");
   await pool.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,repeat('0',64))",[nextVersion]);
   const health=await deps.check();
   expect(health.postgres).toBe(true);expect(health.schema).toBe(false);
   await pool.query('UPDATE schema_migrations SET checksum=$1 WHERE version=1',[original]);
   await pool.query('DELETE FROM schema_migrations WHERE version=$1',[nextVersion]);
   expect((await deps.check()).schema).toBe(true);
  }finally{
   await pool.query('UPDATE schema_migrations SET checksum=$1 WHERE version=1',[original]);
   await pool.query('DELETE FROM schema_migrations WHERE version=$1',[nextVersion]);
   await deps.close();await pool.end();
  }
 });
});
