import {beforeEach,describe,it,expect,vi} from 'vitest';
import {DataType,MilvusClient,f16BytesToF32Array} from '@zilliz/milvus2-sdk-node';
import {createMilvusKeywordIndex,createMilvusHybridIndex,createMilvusVectorIndex,createMilvusClient,milvusScopeFilter} from '../../src/integrations/search-index/milvus.js';
import {buildMilvusSchema,BM25_FUNCTION} from '../../src/integrations/search-index/milvus-schema.js';
import type {KeywordIndex,VectorIndex,HybridIndex,SearchIndex} from '../../src/lib/search-index/types.js';
import {config} from '../helpers.js';
vi.mock('@zilliz/milvus2-sdk-node',async original=>({...await original<object>(),MilvusClient:vi.fn()}));
const scope={userId:'u',workspaceId:'w',pointIds:['a']};
const vector=():number[]=>Array.from({length:1024},(_,i)=>i===0?1:0);
type FixtureClient=ReturnType<typeof setupDriver>['client'];
function setup(mode?:'hybrid',exists?:boolean):{repository:HybridIndex;client:FixtureClient};
function setup(mode:'keyword',exists?:boolean):{repository:KeywordIndex;client:FixtureClient};
function setup(mode:'vector',exists?:boolean):{repository:VectorIndex;client:FixtureClient};
function setup(mode:'hybrid'|'keyword'|'vector',exists?:boolean):{repository:SearchIndex;client:FixtureClient};
function setup(mode:'hybrid'|'keyword'|'vector'='hybrid',exists=true){return setupDriver(mode,exists);}
function setupDriver(mode:'hybrid'|'keyword'|'vector'='hybrid',exists=true){
 const client={connectPromise:Promise.resolve(),hasCollection:vi.fn(async()=>({value:exists})),createCollection:vi.fn(async(options:unknown)=>{void options;return {};}),
 describeCollection:vi.fn(async()=>({schema:{fields:buildMilvusSchema(mode),functions:mode==='vector'?[]:[BM25_FUNCTION]}})),
 describeIndex:vi.fn(async(o:{field_name:string})=>({index_descriptions:[{field_name:o.field_name,index_name:o.field_name==='dense_vector'?'huahuo_dense_hnsw':'huahuo_sparse_bm25',state:'Finished',params:Object.entries(o.field_name==='dense_vector'?{index_type:'HNSW',metric_type:'COSINE',M:'16',efConstruction:'128'}:{index_type:'SPARSE_INVERTED_INDEX',metric_type:'BM25',inverted_index_algo:'DAAT_MAXSCORE'}).map(([key,value])=>({key,value}))}]})),
 createIndex:vi.fn(async()=>({})),loadCollection:vi.fn(async()=>({})),closeConnection:vi.fn(async()=>{}),upsert:vi.fn(async({data}:{data:unknown[]})=>({upsert_cnt:data.length})),search:vi.fn(async(options:unknown)=>{void options;return {results:[]};}),hybridSearch:vi.fn(async(options:unknown)=>{void options;return {results:[]};}),deleteEntities:vi.fn(async()=>({}))};
 const factory=mode==='hybrid'?createMilvusHybridIndex:mode==='keyword'?createMilvusKeywordIndex:createMilvusVectorIndex;
 const repository=factory({...config().milvus,address:'test:19530',username:'user',password:'password',collection:'test_collection',maxContentChars:mode==='keyword'?2000:500,createIfMissing:true},()=>client as unknown as MilvusClient);
 return {repository,client};
}
beforeEach(()=>vi.clearAllMocks());
describe('two mode Milvus collections',()=>{
 it('keyword schema has only sparse BM25 and zero dense/model fields',()=>{const fields=buildMilvusSchema('keyword');expect(fields.some(f=>f.data_type===DataType.FloatVector)).toBe(false);expect(fields.map(f=>f.name)).not.toContain('embedding_dimensions');});
 it('hybrid schema stores native Qwen dimensions as IEEE FP16',()=>expect(buildMilvusSchema('hybrid').find(f=>f.name==='dense_vector')).toMatchObject({dim:1024,data_type:DataType.Float16Vector}));
 it('packs writes and both dense query paths into 2048 bytes per 1024-dimensional vector',async()=>{
  const {repository,client}=setup();const values=vector();values[1]=0.123456;
  await repository.upsert([{id:'a',sourceId:'s',sourceType:'content_asset',userId:'u',workspaceId:'w',content:'数据库',embedding:values}]);
  const data=client.upsert.mock.calls[0]![0].data[0] as {dense_vector:Uint8Array};
  expect(data.dense_vector).toBeInstanceOf(Uint8Array);expect(data.dense_vector.byteLength).toBe(2048);
  expect(f16BytesToF32Array(data.dense_vector)[1]).toBeCloseTo(values[1]!,3);
  await repository.search(values,{scope,limit:5});await repository.hybridSearch(values,'数据库',{scope,limit:5});
  expect((client.search.mock.calls[0]![0] as {data:Uint8Array[]}).data[0]).toEqual(data.dense_vector);
  expect((client.hybridSearch.mock.calls[0]![0] as {data:Array<{data:Uint8Array[]}>}).data[0]!.data[0]).toEqual(data.dense_vector);
 });
 it('rejects an old FP32 collection without dropping or searching it',async()=>{
  const {repository,client}=setup();const fields=buildMilvusSchema('hybrid').map(f=>f.name==='dense_vector'?{...f,data_type:DataType.FloatVector}:f);
  client.describeCollection.mockResolvedValueOnce({schema:{fields,functions:[BM25_FUNCTION]}});
  await expect(repository.search(vector(),{scope,limit:5})).rejects.toMatchObject({code:'MILVUS_SCHEMA_INCOMPATIBLE'});
  expect(client.search).not.toHaveBeenCalled();expect(client.createCollection).not.toHaveBeenCalled();
 });
 it.each([65505,Number.NaN,Number.POSITIVE_INFINITY,1e-20])('rejects FP16 overflow, nonfinite and all-underflow vectors (%s)',async value=>{
  const {repository,client}=setup();await expect(repository.search(Array(1024).fill(value),{scope,limit:5})).rejects.toMatchObject({code:'MILVUS_SCHEMA_INCOMPATIBLE'});expect(client.search).not.toHaveBeenCalled();
 });
 it('uses SDK pool max 50',()=>{vi.mocked(MilvusClient).mockImplementationOnce(function(){return {connectPromise:Promise.resolve()} as MilvusClient;});createMilvusClient({...config().milvus,address:'test'});expect(MilvusClient).toHaveBeenCalledWith(expect.objectContaining({pool:{min:2,max:50}}));});
 it.each(['hybrid','keyword'] as const)('initializes %s once and reuses connection/readiness',async mode=>{const {repository,client}=setup(mode,false);await Promise.all([repository.ensureReady(),repository.ensureReady()]);await repository.ensureReady();expect(client.createCollection).toHaveBeenCalledTimes(1);expect(client.hasCollection).toHaveBeenCalledTimes(1);expect(client.loadCollection).toHaveBeenCalledTimes(1);});
 it('keyword writes text with no placeholder vector',async()=>{const {repository,client}=setup('keyword');await repository.upsert([{id:'a',sourceId:'s',sourceType:'file',userId:'u',workspaceId:'w',content:'数据库 MVCC'}]);const data=client.upsert.mock.calls[0]![0].data[0];expect(data).not.toHaveProperty('dense_vector');expect(data).not.toHaveProperty('sparse_vector');});
 it('dense and sparse use identical filters and native RRF',async()=>{const {repository,client}=setup();await repository.hybridSearch(vector(),'MVCC',{scope,limit:20});const request=client.hybridSearch.mock.calls[0]![0] as unknown as {data:Array<{expr:string;anns_field:string}>;rerank:unknown};expect(request.data[1]!.expr).toContain(request.data[0]!.expr);expect(request.data).toHaveLength(3);expect(request.data[1]!.anns_field).toBe('sparse_vector');expect(request.rerank).toBeTruthy();});
 it('does not expose dense operations or accept vectors in a keyword collection',async()=>{
  const {repository}=setup('keyword');expect(repository).not.toHaveProperty('search');expect(repository).not.toHaveProperty('hybridSearch');
  // @ts-expect-error Also exercise the adapter boundary for JavaScript callers.
  await expect(repository.upsert([{id:'a',sourceId:'s',sourceType:'file',userId:'u',workspaceId:'w',content:'x',embedding:vector()}])).rejects.toThrow('does not accept');
 });
 it('deduplicates ready physical hits and rejects building',async()=>{const {repository,client}=setup();client.search.mockResolvedValueOnce({results:[{id:'a',score:2,index_status:'ready',text:'a'},{id:'a',score:3,index_status:'ready',text:'a'},{id:'b',score:5,index_status:'building',text:'b'}]} as never);expect(await repository.search(vector(),{scope,limit:5})).toEqual([{chunkKey:'a',content:'a',score:3}]);});
 it('never searches unscoped user data',()=>{expect(milvusScopeFilter(scope)).toContain('index_status == "ready"');expect(()=>milvusScopeFilter({...scope,pointIds:[]})).toThrow();});
 it('creates a standalone vector collection without BM25 and accepts arbitrary business source labels',async()=>{
  const {repository,client}=setup('vector',false);
  await repository.upsert([{id:'a',sourceId:'s',sourceType:'future-business',userId:'u',workspaceId:'w',content:'数据库',embedding:vector()}]);
  await repository.search(vector(),{scope,limit:5});
  expect(repository).not.toHaveProperty('searchKeyword');expect(repository).not.toHaveProperty('hybridSearch');
  const creation=client.createCollection.mock.calls[0]![0] as unknown as {fields:Array<{name:string}>;functions:unknown[]};
  expect(creation.functions).toEqual([]);expect(creation.fields.map(f=>f.name)).not.toContain('sparse_vector');
  expect(client.describeIndex.mock.calls.map(([options])=>options.field_name)).toEqual(['dense_vector']);
 });
 it('applies allowlisted source filters together with mandatory tenant and point scope',async()=>{
  const {repository,client}=setup('keyword');
  await repository.searchKeyword('数据库',{scope,limit:5,filter:{sourceIds:['source" or true'],sourceTypes:['future-business']}});
  const request=client.search.mock.calls[0]![0] as {filter:string};
  expect(request.filter).toContain(milvusScopeFilter(scope));
  expect(request.filter).toContain('source_id in ["source\\" or true"]');
  expect(request.filter).toContain('source_type in ["future-business"]');
  await expect(repository.searchKeyword('数据库',{scope,limit:5,filter:{sourceIds:[]}})).rejects.toMatchObject({code:'SEARCH_INDEX_FILTER_INVALID'});
  expect(client.search).toHaveBeenCalledTimes(1);
 });
 it('allows fifty operations and queues fifty-first',async()=>{const {repository,client}=setup();let active=0,peak=0;const releases:Array<()=>void>=[];client.hybridSearch.mockImplementation(async()=>{active++;peak=Math.max(peak,active);await new Promise<void>(r=>releases.push(r));active--;return {results:[]};});const calls=Array.from({length:51},()=>repository.hybridSearch(vector(),'数据库',{scope,limit:5}));await vi.waitFor(()=>expect(client.hybridSearch).toHaveBeenCalledTimes(50));releases.shift()!();await vi.waitFor(()=>expect(client.hybridSearch).toHaveBeenCalledTimes(51));releases.splice(0).forEach(r=>r());await Promise.all(calls);expect(peak).toBe(50);});
});
