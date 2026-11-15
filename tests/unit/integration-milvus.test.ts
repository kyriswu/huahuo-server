import {describe,it,expect,vi} from 'vitest';
// @ts-expect-error Host tooling deliberately uses portable plain JavaScript.
import {cloudMilvusConfig,IsolatedCloudMilvus} from '../../scripts/integration-milvus.mjs';
import {loadConfig} from '../../src/config/config.js';
import {configureTestMilvus} from '../support/milvus.js';
import {env as baseEnv} from '../helpers.js';

const runId='a'.repeat(32),database=`huahuo_test_${runId}`;
const connection={address:'milvus.test:19530',username:'test-user',password:'test-password',ssl:true};
const success={error_code:'Success',code:0};
function fixture(){
 let exists=false;
 const description={status:success,db_name:database,dbID:'1234',created_timestamp:'5678'};
 const admin={connectPromise:Promise.resolve(),closeConnection:vi.fn(async()=>undefined),
  listDatabases:vi.fn(async()=>({status:success,db_names:exists?['default',database]:['default']})),
  createDatabase:vi.fn(async()=>{exists=true;return success;}),
  describeDatabase:vi.fn(async()=>description),
  dropDatabase:vi.fn(async()=>{exists=false;return success;}),
 };
 const scoped={connectPromise:Promise.resolve(),closeConnection:vi.fn(async()=>undefined),
  showCollections:vi.fn(async()=>({status:success,data:[{name:`huahuo_test_note_${runId}`},{name:`huahuo_test_document_${runId}`}]})),
  dropCollection:vi.fn(async()=>success),
 };
 const factory=vi.fn((options:{database:string})=>options.database==='default'?admin:scoped);
 return {admin,scoped,factory,runner:new IsolatedCloudMilvus(connection,runId,factory)};
}

describe('isolated cloud Milvus acceptance tooling',()=>{
 it('allowlists connection inputs and requires an explicit proxy',()=>{
  const env={MILVUS_ADDRESS:connection.address,MILVUS_USERNAME:connection.username,MILVUS_PASSWORD:connection.password,MILVUS_TLS:'true',
   MILVUS_DATABASE:'business',KB_NOTE_HYBRID_COLLECTION:'business_notes',DATABASE_URL:'private-sql',RAG_EMBEDDING_API_KEY:'private-model',grpc_proxy:'http://host.docker.internal:1082'};
  expect(cloudMilvusConfig(env)).toEqual(connection);
  expect(cloudMilvusConfig({...env,TEST_MILVUS_GRPC_PROXY:'http://127.0.0.1:1082'}).proxy).toBe('http://127.0.0.1:1082');
  expect(()=>cloudMilvusConfig({...env,MILVUS_PASSWORD:''})).toThrow('TEST_CLOUD_MILVUS_CONFIG_REQUIRED');
  expect(()=>cloudMilvusConfig({...env,MILVUS_TLS:'yes'})).toThrow('TEST_CLOUD_MILVUS_TLS_INVALID');
  expect(()=>cloudMilvusConfig({...env,TEST_MILVUS_GRPC_PROXY:'file:///private-key'})).toThrow('TEST_CLOUD_MILVUS_PROXY_INVALID');
  expect(()=>new IsolatedCloudMilvus(connection,'default')).toThrow('TEST_CLOUD_MILVUS_RUN_ID_INVALID');
 });
 it('creates only a fresh isolated database and cleans only its two known collections',async()=>{
  const f=fixture(),env=await f.runner.create();
  expect(f.admin.createDatabase).toHaveBeenCalledExactlyOnceWith({db_name:database});
  expect(env).toMatchObject({TEST_MILVUS_DATABASE:database,TEST_MILVUS_MODE:'cloud',TEST_MILVUS_USERNAME:connection.username,TEST_MILVUS_TLS:'true'});
  expect(env).not.toHaveProperty('grpc_proxy');
  expect(f.factory.mock.calls.map(([options])=>options.database)).toEqual(['default',database]);
  await f.runner.cleanup();
  expect(f.scoped.dropCollection.mock.calls).toEqual([
   [{db_name:database,collection_name:`huahuo_test_note_${runId}`}],
   [{db_name:database,collection_name:`huahuo_test_document_${runId}`}],
  ]);
  expect(f.admin.dropDatabase).toHaveBeenCalledExactlyOnceWith({db_name:database});
  expect(f.admin.listDatabases).toHaveBeenCalledTimes(2);
  expect(f.admin.closeConnection).toHaveBeenCalledOnce();expect(f.scoped.closeConnection).toHaveBeenCalledOnce();
 });
 it('never adopts or deletes a database that existed before the run',async()=>{
  const f=fixture();f.admin.listDatabases.mockResolvedValue({status:success,db_names:['default',database]});
  await expect(f.runner.create()).rejects.toThrow('TEST_CLOUD_MILVUS_DATABASE_EXISTS');await f.runner.cleanup();
  expect(f.admin.createDatabase).not.toHaveBeenCalled();expect(f.admin.dropDatabase).not.toHaveBeenCalled();expect(f.scoped.dropCollection).not.toHaveBeenCalled();
  expect(f.admin.closeConnection).toHaveBeenCalledOnce();
 });
 it('does not clean up an unsuccessful create response even if its numeric code is zero',async()=>{
  const f=fixture();f.admin.createDatabase.mockResolvedValue({error_code:'UnexpectedError',code:0});
  await expect(f.runner.create()).rejects.toThrow('TEST_CLOUD_MILVUS_CREATE_FAILED');await f.runner.cleanup();
  expect(f.admin.dropDatabase).not.toHaveBeenCalled();expect(f.scoped.dropCollection).not.toHaveBeenCalled();
 });
 it('refuses cleanup if the database was replaced',async()=>{
  const f=fixture();await f.runner.create();f.admin.describeDatabase.mockResolvedValue({status:success,db_name:database,dbID:'replacement',created_timestamp:'5678'});
  await expect(f.runner.cleanup()).rejects.toThrow('TEST_CLOUD_MILVUS_OWNERSHIP_MISMATCH');
  expect(f.admin.dropDatabase).not.toHaveBeenCalled();expect(f.scoped.dropCollection).not.toHaveBeenCalled();
  expect(f.admin.closeConnection).toHaveBeenCalledOnce();expect(f.scoped.closeConnection).toHaveBeenCalledOnce();
 });
 it('refuses every deletion if an unexpected collection is found',async()=>{
  const f=fixture();await f.runner.create();f.scoped.showCollections.mockResolvedValue({status:success,data:[{name:`huahuo_test_note_${runId}`},{name:'business_notes'}]});
  await expect(f.runner.cleanup()).rejects.toThrow('TEST_CLOUD_MILVUS_UNEXPECTED_COLLECTION');
  expect(f.scoped.dropCollection).not.toHaveBeenCalled();expect(f.admin.dropDatabase).not.toHaveBeenCalled();
 });
 it('does not drop the database after a failed collection cleanup',async()=>{
  const f=fixture();await f.runner.create();f.scoped.dropCollection.mockResolvedValue({error_code:'UnexpectedError',code:0});
  await expect(f.runner.cleanup()).rejects.toThrow('TEST_CLOUD_MILVUS_COLLECTION_CLEANUP_FAILED');
  expect(f.admin.dropDatabase).not.toHaveBeenCalled();
 });
 it('binds every test snapshot/client to cloud isolation and rejects business targets',async()=>{
  const f=fixture(),env=await f.runner.create(),cfg=loadConfig('api-server',baseEnv);
  configureTestMilvus(cfg,env);
  expect(cfg.milvus).toMatchObject({address:connection.address,username:connection.username,password:connection.password,database,tls:true,createIfMissing:true});
  expect(cfg.kb.noteCollection).toBe(`huahuo_test_note_${runId}`);expect(cfg.kb.documentCollection).toBe(`huahuo_test_document_${runId}`);
  expect(()=>configureTestMilvus(cfg,{...env,TEST_MILVUS_DATABASE:'default'})).toThrow('ISOLATED_CLOUD_MILVUS_REQUIRED');
  expect(()=>configureTestMilvus(cfg,{...env,TEST_MILVUS_NOTE_COLLECTION:'business_notes'})).toThrow('ISOLATED_CLOUD_MILVUS_REQUIRED');
  expect(()=>configureTestMilvus(cfg,{...env,TEST_MILVUS_PASSWORD:''})).toThrow('TEST_MILVUS_CONFIG_REQUIRED');
  await f.runner.cleanup();
 });
});
