import {randomUUID} from 'node:crypto';
import {afterAll,expect,it} from 'vitest';
import {loadConfig} from '../../src/config/config.js';
import {loadMigrationFiles} from '../../src/db/migration-files.js';
import {poolFor} from '../../src/plugins/dependencies.js';
const database=process.env.TEST_DATABASE_MIGRATION_URL;
if(!database||!/^huahuo_test_[a-z0-9_]+$/u.test(new URL(database).pathname.slice(1)))throw Error('ISOLATED_DATABASE_REQUIRED');
const pool=poolFor(loadConfig('migrate',{DATABASE_URL:database}));
const migration=loadMigrationFiles().find(file=>file.name==='0014_retire_processing_node_enabled.sql')!;
afterAll(()=>pool.end());
it('removes only the retired flag from node and durable snapshots and rejects old writers',async()=>{
 const client=await pool.connect(),schema='node_flag_'+randomUUID().replaceAll('-','');
 await client.query('BEGIN');
 try{
  await client.query(`CREATE SCHEMA ${schema};
   CREATE TABLE ${schema}.processing_nodes(id uuid PRIMARY KEY,config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'),revision integer NOT NULL,
    CHECK((jsonb_typeof(config->'enabled')='boolean') IS TRUE));
   CREATE TABLE ${schema}.processing_node_assignments(request_id text PRIMARY KEY,snapshot jsonb NOT NULL,settled boolean NOT NULL);`);
  const id=randomUUID(),node={name:'fixture',capabilities:['document'],resourceClass:'cpu',mode:'always-on',regionId:null,instanceId:null,privateIp:null,baseUrl:'http://127.0.0.1:8000',concurrency:1};
  await client.query(`INSERT INTO ${schema}.processing_nodes VALUES($1,$2,7)`,[id,JSON.stringify({...node,enabled:true})]);
  for(const settled of [false,true])await client.query(`INSERT INTO ${schema}.processing_node_assignments VALUES($1,$2,$3)`,[String(settled),JSON.stringify({...node,id,revision:7,enabled:false}),settled]);
  await client.query(migration.sql.replaceAll('public.',schema+'.'));
  expect((await client.query(`SELECT * FROM ${schema}.processing_nodes`)).rows).toEqual([{id,config:node,revision:7}]);
  const assignments=(await client.query(`SELECT * FROM ${schema}.processing_node_assignments ORDER BY settled`)).rows;
  expect(assignments).toEqual([false,true].map(settled=>({request_id:String(settled),snapshot:{...node,id,revision:7},settled})));
  await client.query('SAVEPOINT old_writer');
  await expect(client.query(`UPDATE ${schema}.processing_nodes SET config=config||'{"enabled":true}'`)).rejects.toMatchObject({code:'23514'});
  await client.query('ROLLBACK TO SAVEPOINT old_writer');
  await client.query(`UPDATE ${schema}.processing_nodes SET config=jsonb_set(config,'{concurrency}','2')`);
  expect((await client.query(`SELECT config->'concurrency' AS concurrency FROM ${schema}.processing_nodes`)).rows[0].concurrency).toBe(2);
  expect(Number((await client.query("SELECT count(*) AS n FROM pg_constraint WHERE connamespace=$1::regnamespace AND contype='f'",[schema])).rows[0].n)).toBe(0);
 }finally{await client.query('ROLLBACK');client.release();}
});
