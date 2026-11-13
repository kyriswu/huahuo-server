import {beforeEach,describe,it,expect,vi} from 'vitest';
import {DataType,MilvusClient} from '@zilliz/milvus2-sdk-node';
import {MilvusRepository,createMilvusClient,milvusScopeFilter} from '../../src/modules/rag/adapters/milvus.js';
import {buildMilvusSchema,BM25_FUNCTION} from '../../src/modules/rag/adapters/milvus-schema.js';
import {config} from '../helpers.js';
vi.mock('@zilliz/milvus2-sdk-node',async original=>({...await original<object>(),MilvusClient:vi.fn()}));
const scope={userId:'u',workspaceId:'w',pointIds:['a']};
const vector=()=>Array.from({length:1024},(_,i)=>i===0?1:0);
function setup(mode:'note-hybrid'|'document-keyword'='note-hybrid',exists=true){
 const client={connectPromise:Promise.resolve(),hasCollection:vi.fn(async()=>({value:exists})),createCollection:vi.fn(async()=>({})),
 describeCollection:vi.fn(async()=>({schema:{fields:buildMilvusSchema(mode),functions:[BM25_FUNCTION]}})),
 describeIndex:vi.fn(async(o:{field_name:string})=>({index_descriptions:[{field_name:o.field_name,index_name:o.field_name==='dense_vector'?'huahuo_dense_hnsw':'huahuo_sparse_bm25',state:'Finished',params:Object.entries(o.field_name==='dense_vector'?{index_type:'HNSW',metric_type:'COSINE',M:'16',efConstruction:'128'}:{index_type:'SPARSE_INVERTED_INDEX',metric_type:'BM25',inverted_index_algo:'DAAT_MAXSCORE'}).map(([key,value])=>({key,value}))}]})),
 createIndex:vi.fn(async()=>({})),loadCollection:vi.fn(async()=>({})),closeConnection:vi.fn(async()=>{}),upsert:vi.fn(async({data}:{data:unknown[]})=>({upsert_cnt:data.length})),search:vi.fn(async(options:unknown)=>{void options;return {results:[]};}),hybridSearch:vi.fn(async(options:unknown)=>{void options;return {results:[]};}),deleteEntities:vi.fn(async()=>({}))};
 const repository=new MilvusRepository({...config().milvus,address:'test:19530',username:'user',password:'password',collection:'test_collection',mode,createIfMissing:true},()=>client as unknown as MilvusClient);
 return {repository,client};
}
beforeEach(()=>vi.clearAllMocks());
describe('two mode Milvus collections',()=>{
 it('keyword schema has only sparse BM25 and zero dense/model fields',()=>{const fields=buildMilvusSchema('document-keyword');expect(fields.some(f=>f.data_type===DataType.FloatVector)).toBe(false);expect(fields.map(f=>f.name)).not.toContain('embedding_dimensions');});
 it('hybrid schema fixes native BGE-M3 dimensions at 1024',()=>expect(buildMilvusSchema('note-hybrid').find(f=>f.name==='dense_vector')).toMatchObject({dim:1024}));
 it('uses SDK pool max 50',()=>{vi.mocked(MilvusClient).mockImplementationOnce(function(){return {connectPromise:Promise.resolve()} as MilvusClient;});createMilvusClient({...config().milvus,address:'test'});expect(MilvusClient).toHaveBeenCalledWith(expect.objectContaining({pool:{min:2,max:50}}));});
 it.each(['note-hybrid','document-keyword'] as const)('initializes %s once and reuses connection/readiness',async mode=>{const {repository,client}=setup(mode,false);await Promise.all([repository.ensureReady(),repository.ensureReady()]);await repository.ensureReady();expect(client.createCollection).toHaveBeenCalledTimes(1);expect(client.hasCollection).toHaveBeenCalledTimes(1);expect(client.loadCollection).toHaveBeenCalledTimes(1);});
 it('keyword writes text with no placeholder vector',async()=>{const {repository,client}=setup('document-keyword');await repository.upsert([{id:'a',sourceId:'s',sourceType:'file',userId:'u',workspaceId:'w',content:'数据库 MVCC'}]);const data=client.upsert.mock.calls[0]![0].data[0];expect(data).not.toHaveProperty('dense_vector');expect(data).not.toHaveProperty('sparse_vector');});
 it('dense and sparse use identical filters and native RRF',async()=>{const {repository,client}=setup();await repository.hybridSearch(vector(),'MVCC',{scope,limit:20});const request=client.hybridSearch.mock.calls[0]![0] as unknown as {data:Array<{expr:string;anns_field:string}>;rerank:unknown};expect(request.data[1]!.expr).toContain(request.data[0]!.expr);expect(request.data).toHaveLength(3);expect(request.data[1]!.anns_field).toBe('sparse_vector');expect(request.rerank).toBeTruthy();});
 it('does not allow dense operations or vectors in keyword collection',async()=>{const {repository}=setup('document-keyword');await expect(repository.search(vector(),{scope,limit:5})).rejects.toThrow('Dense search');await expect(repository.upsert([{id:'a',sourceId:'s',sourceType:'file',userId:'u',workspaceId:'w',content:'x',embedding:vector()}])).rejects.toThrow('does not accept');});
 it('deduplicates ready physical hits and rejects building',async()=>{const {repository,client}=setup();client.search.mockResolvedValueOnce({results:[{id:'a',score:2,index_status:'ready',text:'a'},{id:'a',score:3,index_status:'ready',text:'a'},{id:'b',score:5,index_status:'building',text:'b'}]} as never);expect(await repository.search(vector(),{scope,limit:5})).toEqual([{chunkKey:'a',content:'a',score:3}]);});
 it('never searches unscoped user data',()=>{expect(milvusScopeFilter(scope)).toContain('index_status == "ready"');expect(()=>milvusScopeFilter({...scope,pointIds:[]})).toThrow();});
 it('allows fifty operations and queues fifty-first',async()=>{const {repository,client}=setup();let active=0,peak=0;const releases:Array<()=>void>=[];client.hybridSearch.mockImplementation(async()=>{active++;peak=Math.max(peak,active);await new Promise<void>(r=>releases.push(r));active--;return {results:[]};});const calls=Array.from({length:51},()=>repository.hybridSearch(vector(),'数据库',{scope,limit:5}));await vi.waitFor(()=>expect(client.hybridSearch).toHaveBeenCalledTimes(50));releases.shift()!();await vi.waitFor(()=>expect(client.hybridSearch).toHaveBeenCalledTimes(51));releases.splice(0).forEach(r=>r());await Promise.all(calls);expect(peak).toBe(50);});
});
