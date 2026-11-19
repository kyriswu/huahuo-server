import { ConsistencyLevelEnum, DataType, FunctionType, IndexType, MetricType, MilvusClient, RRFRanker, f32ArrayToF16Bytes, f16BytesToF32Array, type FieldSchema, type IndexDescription, type SparseVectorDic } from '@zilliz/milvus2-sdk-node';
import { digest } from '../../lib/crypto.js';
import type { MilvusConfig } from '../../config/config.js';
import { SearchIndexError, validateSearch, type KeywordIndex, type VectorIndex, type HybridIndex, type IndexKind, type IndexPoint, type RecallHit, type RecallScope, type RecallFilter, type SearchOptions, type OperationOptions, type LexicalDictionary } from '../../lib/search-index/types.js';
import { BM25_FUNCTION, buildMilvusSchema, DENSE_INDEX_NAME, detectChunkLanguage, MILVUS_OUTPUT_FIELDS, MILVUS_POINT_FIELDS, MULTI_ANALYZER_PARAMS, SPARSE_INDEX_NAME, SPARSE_IP_INDEX_NAME, type ChunkLanguage } from './milvus-schema.js';
// SDK 2.6.17 treats numeric Strong=0 as falsy; send its supported wire enum name.
const STRONG='Strong' as unknown as ConsistencyLevelEnum;
export class MilvusError extends SearchIndexError {
 constructor(code:string,message:string,retryable=true,options?:{cause?:unknown}){super(code,retryable,options);this.message=message;this.name='MilvusError';}
}
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function status(response: unknown) { const top = record(response); return record(top.status ?? top); }
function successful(response: unknown): boolean { const s = status(response); return ['Success', '0'].includes(String(s.error_code ?? 'Success')) && Number(s.code ?? 0) === 0; }
function ok(response: unknown, operation: string): void {
  if (!successful(response)) throw new MilvusError('MILVUS_UNAVAILABLE', `${operation} failed (${String(status(response).error_code ?? status(response).code)})`, true);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(record(value)).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? '';
}
function fieldParams(field: FieldSchema): Record<string, unknown> { return { ...Object.fromEntries((field.type_params ?? []).map(p => [p.key, p.value])), ...field }; }
function typeId(value: unknown): number { return typeof value === 'number' ? value : Number(record(DataType)[String(value)] ?? value); }
function incompatible(message: string): never { throw new MilvusError('MILVUS_SCHEMA_INCOMPATIBLE', message, false); }
function quote(value: string): string { return JSON.stringify(value); }

export function milvusScopeFilter(scope:RecallScope,filter?:RecallFilter):string {
 validateSearch({scope,filter,limit:1});
 let expression=`user_id == ${quote(scope.userId)} && workspace_id == ${quote(scope.workspaceId)} && index_status == "ready" && id in [${scope.pointIds.map(quote).join(',')}]`;
 if(filter?.sourceIds)expression+=` && source_id in [${filter.sourceIds.map(quote).join(',')}]`;
 if(filter?.sourceTypes)expression+=` && source_type in [${filter.sourceTypes.map(quote).join(',')}]`;
 return expression;
}
type KeywordRoute = {
  filter:string; data:string|SparseVectorDic[]; metric:MetricType;
  params:{drop_ratio_search:number;analyzer_name?:ChunkLanguage};
};
type PreparedKeywords = { routes:KeywordRoute[]; terms?:string[]; coordinates?:Map<string,number> };
const keywordGroup=(language:ChunkLanguage)=>language==='en'||language==='unknown'?'unicode':'jieba';
const termInGroup=(group:string,term:string)=>group+'\0'+term;
const MAX_PREPARED_QUERIES=512;
function keywordRoutes(query:string,filter:string):Array<{analyzer:ChunkLanguage;filter:string}>{
 const analyzer=detectChunkLanguage(query);
 return analyzer==='en'?[{analyzer:'en',filter:filter+' && language in ["en","unknown"]'},{analyzer:'mixed',filter:filter+' && language in ["zh","mixed"]'}]:[{analyzer,filter}];
}
class AsyncGate {
  private available: number;
  private readonly queue: Array<() => void> = [];
  constructor(limit: number, private readonly queueLimit = 32) { this.available = limit; }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.available === 0) {
      if (this.queue.length >= this.queueLimit) throw new MilvusError('MILVUS_BUSY', 'Milvus operation queue is full');
      await new Promise<void>(resolve => this.queue.push(resolve));
    } else this.available -= 1;
    try { return await operation(); }
    finally { const next = this.queue.shift(); if (next) next(); else this.available += 1; }
  }
}
export function createMilvusClient(config: MilvusConfig): MilvusClient {
  const client = new MilvusClient({ address: config.address!, username: config.username!, password: config.password!, database: config.database, timeout: 15_000, maxRetries: 2, ssl: config.tls, logLevel: 'error', pool: { min: Math.min(2, config.searchConcurrency), max: config.searchConcurrency } });
  void client.connectPromise.catch(() => undefined);
  return client;
}
export interface MilvusIndexConfig extends MilvusConfig {
 collection:string;
 maxContentChars:number;
 dimensions?:number;
 dictionary?:LexicalDictionary;
}
class MilvusIndexDriver {
 private client:MilvusClient|undefined;private connectPromise:Promise<void>|undefined;private readyPromise:Promise<void>|undefined;
 private readonly preparedQueries=new Map<string,PreparedKeywords>();
 private closed=false;private readonly collection:string;private readonly gate:AsyncGate;
 constructor(private readonly config:MilvusIndexConfig & {kind:IndexKind},private readonly clientFactory=()=>createMilvusClient(config)){
  this.collection=config.collection;this.gate=new AsyncGate(config.searchConcurrency);
  if(!Number.isSafeInteger(config.maxContentChars)||config.maxContentChars<1||config.maxContentChars>65535)incompatible('Invalid content limit');
  if(!Number.isSafeInteger(config.dimensions??1024)||(config.dimensions??1024)<1||(config.dimensions??1024)>65536)incompatible('Invalid vector dimensions');
  if(!config.address||!config.username||!config.password)throw new MilvusError('MILVUS_CONFIG_INVALID','Milvus connection configuration is incomplete',false);
 }
  async connect(): Promise<void> {
    if (this.closed) throw new MilvusError('MILVUS_CLIENT_CLOSED', 'Milvus client is closed', false);
    if (this.connectPromise) return this.connectPromise;
    const client = this.client ?? this.clientFactory(); this.client = client;
    const pending = (async () => {
      try { await client.connectPromise; }
      catch (error) {
        if (this.client === client) { this.client = undefined; this.connectPromise = undefined; }
        await client.closeConnection().catch(() => undefined);
        throw new MilvusError('MILVUS_UNAVAILABLE', 'Milvus connection failed', true, { cause: error });
      }
    })();
    this.connectPromise = pending; return pending;
  }
  async close(): Promise<void> {
    this.closed = true; const client = this.client; this.client = undefined;
    this.connectPromise = undefined; this.readyPromise = undefined; this.preparedQueries.clear();
    await client?.closeConnection().catch(() => undefined);
  }
  private async operation<T>(name: string, operation: (client: MilvusClient) => Promise<T>): Promise<T> {
    await this.connect();
    if (!this.client) throw new MilvusError('MILVUS_UNAVAILABLE', 'Milvus client is not connected');
    try { return await operation(this.client); }
    catch (error) { if (error instanceof MilvusError) throw error; throw new MilvusError('MILVUS_UNAVAILABLE', `${name} failed`, true, { cause: error }); }
  }
  async ensureReady(): Promise<void> {
    await this.connect();
    if (this.readyPromise) {
      return this.readyPromise;
    }
    this.readyPromise = this.ensureReadyOnce().catch(error => { this.readyPromise = undefined; throw error; });
    return this.readyPromise;
  }
  private get outputFields(){return this.config.dictionary?MILVUS_POINT_FIELDS:MILVUS_OUTPUT_FIELDS;}
  private async ensureReadyOnce(): Promise<void> {
    const sparse=!!this.config.dictionary;
    const fields=buildMilvusSchema(this.config.kind,this.config.dimensions??1024,sparse);
    await this.operation('ensureReady', async client => {
      const exists = await client.hasCollection({ collection_name: this.collection }); ok(exists, 'hasCollection');
      if (!exists.value) {
        if (!this.config.createIfMissing) throw new MilvusError('MILVUS_COLLECTION_MISSING', 'Configured collection does not exist', false);
        // Another process may create the same collection; validate it rather than drop/recreate.
        try { ok(await client.createCollection({ collection_name: this.collection, enable_dynamic_field: false, fields, functions: sparse||this.config.kind==='vector'?[]:[BM25_FUNCTION] }), 'createCollection'); }
        catch (error) { const raced = await client.hasCollection({ collection_name: this.collection }); ok(raced, 'hasCollection'); if (!raced.value) throw error; }
      }
      const desc = await client.describeCollection({ collection_name: this.collection }); ok(desc, 'describeCollection');
      if(this.config.kind==='keyword'&&desc.schema.fields.some(f=>[DataType.FloatVector,DataType.Float16Vector,DataType.BFloat16Vector,DataType.BinaryVector,DataType.Int8Vector].includes(typeId(f.data_type))))incompatible('Keyword collection must not contain dense vectors');
      if(sparse&&(desc.schema.enable_dynamic_field||desc.schema.fields.length!==fields.length))incompatible('Textless collection field set does not match');
      for (const expected of fields) {
        const field = desc.schema.fields.find(f => f.name === expected.name);
        if (!field || typeId(field.data_type) !== typeId(expected.data_type)) incompatible(`Invalid field ${expected.name}`);
        const params = fieldParams(field);
        if (expected.is_primary_key && (!field.is_primary_key || field.autoID)) incompatible('Primary key must be a stable caller supplied ID');
        if (expected.max_length && (!Number.isFinite(Number(params.max_length)) || Number(params.max_length) < Number(expected.max_length))) incompatible(`Field ${expected.name} is too short or missing max_length`);
        if (expected.name === 'dense_vector' && Number(params.dim) !== (this.config.dimensions??1024)) incompatible('Dense embedding dimension mismatch');
        if (expected.name === 'sparse_vector' && Boolean(field.is_function_output)===sparse) incompatible('Unexpected sparse vector writer');
        if (expected.name === 'text') {
          if (![true, 'true'].includes(params.enable_analyzer as boolean | string)) incompatible('Text analyzer must be enabled');
          let multi: unknown = params.multi_analyzer_params;
          if (typeof multi === 'string') { try { multi = JSON.parse(multi); } catch { incompatible('Invalid multi-language analyzer'); } }
          if (canonical(multi) !== canonical(MULTI_ANALYZER_PARAMS)) incompatible('Multi-language analyzer does not match the collection schema');
        }
      }
      const functions = [...(desc.schema.functions ?? []), ...(desc.functions ?? [])];
      if(sparse&&functions.length)incompatible('Textless collection must not have schema functions');
      if (!sparse&&this.config.kind!=='vector'&&!functions.some(fn => fn.name === BM25_FUNCTION.name && (fn.type === FunctionType.BM25 || String(fn.type) === 'BM25') && canonical(fn.input_field_names) === canonical(['text']) && canonical(fn.output_field_names) === canonical(['sparse_vector']))) incompatible('BM25 text to sparse_vector function is missing');
      if(this.config.kind!=='keyword')await this.ensureIndex(client, 'dense_vector', DENSE_INDEX_NAME, IndexType.HNSW, MetricType.COSINE, { M: 16, efConstruction: 128 });
      if(this.config.kind!=='vector')await this.ensureIndex(client, 'sparse_vector', sparse?SPARSE_IP_INDEX_NAME:SPARSE_INDEX_NAME, 'SPARSE_INVERTED_INDEX', sparse?MetricType.IP:MetricType.BM25, { inverted_index_algo: 'DAAT_MAXSCORE' });
      ok(await client.loadCollection({ collection_name: this.collection }), 'loadCollection');
    });
  }
  private async ensureIndex(client: MilvusClient, field: string, name: string, type: string, metric: string, params: Record<string, number | string>): Promise<void> {
    const describe = async (): Promise<IndexDescription[]> => {
      const result = await client.describeIndex({ collection_name: this.collection, field_name: field });
      if (String(status(result).error_code) === 'IndexNotExist' || /index not found/iu.test(String(status(result).reason))) return [];
      // Some Milvus deployments return all collection indexes even when the
      // request specifies field_name. Never let another vector field's index
      // suppress creation (or satisfy race recovery) for this field.
      ok(result, 'describeIndex'); return result.index_descriptions.filter(index => index.field_name === field);
    };
    let indexes = await describe();
    if (!indexes.length) {
      try { ok(await client.createIndex({ collection_name: this.collection, field_name: field, index_name: name, index_type: type, metric_type: metric, params }), 'createIndex'); }
      catch (error) { if (!(await describe()).length) throw error; }
      indexes = await describe();
    }
    if (!indexes.some(index => {
      const p = Object.fromEntries(index.params.map(v => [v.key, v.value]));
      let detail: Record<string, unknown> = {};
      if (typeof p.params === 'string') { try { detail = record(JSON.parse(p.params)); } catch { return false; } }
      const actual = { ...detail, ...p };
      return index.index_name === name && index.field_name === field && p.index_type === type && p.metric_type === metric && index.state !== 'Failed'
        && Object.entries(params).every(([key, value]) => String(actual[key]) === String(value));
    })) incompatible(`Invalid ${field} index; no automatic rebuild is allowed`);
  }
  private validateVector(vector: readonly number[], dimensions: number): void {
    if (vector.length !== dimensions || vector.some(v => !Number.isFinite(v)||Math.abs(v)>65504) || f16BytesToF32Array(f32ArrayToF16Bytes([...vector])).every(v => v === 0)) incompatible('Invalid FP16 embedding vector or dimension');
  }
  private async analyze(client:MilvusClient,language:ChunkLanguage,text:string[]):Promise<string[][]>{
    const params=MULTI_ANALYZER_PARAMS.analyzers[language==='unknown'?'default':language]!;
    const response=await client.runAnalyzer({text,analyzer_params:params,with_detail:true});
    ok(response,'analyze');
    if(response.results?.length!==text.length||response.results.some(row=>!Array.isArray(row.tokens)||row.tokens.some(token=>typeof token.token!=='string')))throw new MilvusError('MILVUS_ANALYZER_RESPONSE_INVALID','Analyzer result does not match the input',false);
    return response.results.map(row=>row.tokens.map(token=>token.token).filter(Boolean));
  }
  private async encodePoints(client:MilvusClient,points:readonly IndexPoint[],languages:ChunkLanguage[]){
    const groups=new Map<ChunkLanguage,number[]>();
    for(const [i,language] of languages.entries()){
      const group=groups.get(language)??[];group.push(i);groups.set(language,group);
    }
    const terms=Array<string[]>(points.length);
    await Promise.all([...groups].map(async ([language,ids])=>{
      const analyzed=await this.analyze(client,language,ids.map(i=>points[i]!.content));
      for(const [j,i] of ids.entries())terms[i]=analyzed[j]!;
    }));
    const groupedTerms=terms.map((tokens,i)=>tokens.map(token=>termInGroup(keywordGroup(languages[i]!),token)));
    const coordinates=await this.config.dictionary!.coordinates(groupedTerms.flat(),true);
    return groupedTerms.map(tokens=>{
      const counts=new Map<string,number>();
      for(const token of tokens)counts.set(token,(counts.get(token)??0)+1);
      // Fixed reference length keeps weights stable across edits and index shards.
      const lengthFactor=1.2*(0.25+0.75*tokens.length/128);
      return counts.size?Object.fromEntries([...counts].map(([term,tf])=>[coordinates.get(term)!,2.2*tf/(tf+lengthFactor)])):{0:1};
    });
  }
  async upsert(points:readonly IndexPoint[],options?:OperationOptions):Promise<void>{
    options?.signal?.throwIfAborted();
    if(!points.length)return;
    for(const point of points){
      if(!point.id||!point.sourceId||!point.sourceType||!point.userId||!point.workspaceId||!point.content.trim())incompatible('Incomplete point');
      if(Array.from(point.content).length>this.config.maxContentChars||Buffer.byteLength(point.content,'utf8')>65535)incompatible('Chunk exceeds configured storage limit');
      if(this.config.kind!=='keyword')this.validateVector(point.embedding??[],this.config.dimensions??1024);
      else if(point.embedding!==undefined)incompatible('Keyword collection does not accept dense vectors');
    }
    await this.ensureReady();
    await this.gate.run(()=>this.operation('upsert',async client=>{
      options?.signal?.throwIfAborted();
      const languages=points.map(p=>detectChunkLanguage(p.content));
      const sparse=this.config.dictionary?await this.encodePoints(client,points,languages):undefined;
      options?.signal?.throwIfAborted();
      const response=await client.upsert({collection_name:this.collection,data:points.map((p,i)=>({
        id:p.id,source_id:p.sourceId,source_type:p.sourceType,user_id:p.userId,workspace_id:p.workspaceId,
        ...(sparse?{sparse_vector:sparse[i]}:{text:p.content,language:languages[i]}),index_status:'ready',
        ...(this.config.kind!=='keyword'?{dense_vector:f32ArrayToF16Bytes([...p.embedding!])}:{}),
      }))});ok(response,'upsert');
      if(response.err_index?.length||Number(response.upsert_cnt)!==points.length)throw new MilvusError('MILVUS_UPSERT_INCOMPLETE','Incomplete index write');
    }));
  }
  async search(vector:readonly number[],options:SearchOptions):Promise<RecallHit[]>{
    validateSearch(options);if(this.config.kind==='keyword')incompatible('Dense search is not enabled');this.validateVector(vector,this.config.dimensions??1024);await this.ensureReady();
    const response=await this.gate.run(()=>this.operation('search',c=>c.search({collection_name:this.collection,data:[f32ArrayToF16Bytes([...vector])],anns_field:'dense_vector',filter:milvusScopeFilter(options.scope,options.filter),limit:options.limit,metric_type:MetricType.COSINE,params:{ef:Math.max(64,options.limit)},output_fields:this.outputFields,consistency_level:STRONG})));
    return this.parseHits(response);
  }
  async prepareKeywordSearch(query:string){
    if(this.config.kind==='vector')incompatible('Keyword search is not enabled');
    if(!query.trim())throw new SearchIndexError('SEARCH_INDEX_QUERY_INVALID');
    await this.ensureReady();
    const routes=await this.prepareKeywordRoutes(query);
    return async (options:SearchOptions):Promise<RecallHit[]>=>{
      validateSearch(options);
      const filter=milvusScopeFilter(options.scope,options.filter);
      const responses=await Promise.all(routes.map(route=>this.gate.run(()=>this.operation('keyword',c=>c.search({
        collection_name:this.collection,data:route.data,anns_field:'sparse_vector',filter:filter+route.filter,
        limit:options.limit,metric_type:route.metric,params:route.params,output_fields:this.outputFields,consistency_level:STRONG,
      })))));
      return this.parseHits(...responses).slice(0,options.limit);
    };
  }
  private async prepareKeywordRoutes(query:string):Promise<KeywordRoute[]>{
    const routes=keywordRoutes(query,'');
    if(!this.config.dictionary)return routes.map(route=>({
      filter:route.filter,data:query,metric:MetricType.BM25,params:{analyzer_name:route.analyzer,drop_ratio_search:0},
    }));
    const key=digest(query);
    const cached=this.preparedQueries.get(key);
    if(cached){
      this.preparedQueries.delete(key);
      this.preparedQueries.set(key,cached);
      if(!cached.terms)return cached.routes;
    }
    const terms=cached?.terms??await this.analyzeKeywordQuery(query,routes);
    const coordinates=new Map(cached?.coordinates);
    const missing=terms.filter(term=>!coordinates.has(term));
    if(missing.length)for(const [term,id] of await this.config.dictionary.coordinates(missing,false))coordinates.set(term,id);
    const vector=Object.fromEntries([...coordinates.values()].map(id=>[id,1]));
    const prepared:KeywordRoute[]=coordinates.size?[{filter:'',data:[vector],metric:MetricType.IP,params:{drop_ratio_search:0}}]:[];
    // Never cache a missing coordinate: it may be allocated by a later write.
    this.preparedQueries.set(key,coordinates.size===terms.length?{routes:prepared}:{routes:prepared,terms,coordinates});
    if(this.preparedQueries.size>MAX_PREPARED_QUERIES)this.preparedQueries.delete(this.preparedQueries.keys().next().value!);
    return prepared;
  }
  private async analyzeKeywordQuery(query:string,routes:ReturnType<typeof keywordRoutes>):Promise<string[]>{
    const analyzed=await Promise.all(routes.map(route=>this.gate.run(()=>this.operation('analyze',async c=>(await this.analyze(c,route.analyzer,[query]))[0]!))));
    // Encode routing in the coordinates so both language groups share one IP search.
    const terms=analyzed.length===2
      ? analyzed.flatMap((tokens,i)=>tokens.map(token=>termInGroup(keywordGroup(routes[i]!.analyzer),token)))
      : analyzed[0]!.flatMap(token=>[termInGroup('unicode',token),termInGroup('jieba',token)]);
    return [...new Set(terms)];
  }
  async searchKeyword(query:string,options:SearchOptions):Promise<RecallHit[]>{
    validateSearch(options);
    return (await this.prepareKeywordSearch(query))(options);
  }
  async hybridSearch(vector:readonly number[],query:string,options:SearchOptions):Promise<RecallHit[]>{
    validateSearch(options);if(this.config.kind!=='hybrid')incompatible('Hybrid search is not enabled');if(!query.trim())throw new SearchIndexError('SEARCH_INDEX_QUERY_INVALID');this.validateVector(vector,this.config.dimensions??1024);await this.ensureReady();
    const filter=milvusScopeFilter(options.scope,options.filter);
    const routes=await this.prepareKeywordRoutes(query);
    const response=await this.gate.run(()=>this.operation('hybrid',c=>c.hybridSearch({collection_name:this.collection,data:[
      {data:[f32ArrayToF16Bytes([...vector])],anns_field:'dense_vector',expr:filter,params:{topk:this.config.denseCandidates,metric_type:MetricType.COSINE,params:JSON.stringify({ef:Math.max(64,this.config.denseCandidates)})}},
      ...routes.map(route=>({data:route.data,anns_field:'sparse_vector',expr:filter+route.filter,params:{topk:this.config.bm25Candidates,metric_type:route.metric,...(route.params.analyzer_name?{analyzer_name:route.params.analyzer_name}:{}),params:JSON.stringify({drop_ratio_search:0})}})),
    ],rerank:RRFRanker(this.config.rrfK),limit:options.limit,output_fields:this.outputFields,consistency_level:STRONG})));
    return this.parseHits(response);
  }
  private parseHits(...responses:unknown[]):RecallHit[]{
    const unique=new Map<string,RecallHit>();
    for(const response of responses){ok(response,'search');const rows=record(response).results;
      if(!Array.isArray(rows))throw new MilvusError('MILVUS_RESPONSE_INVALID','Missing results',false);
      for(const value of rows){const row=record(value);const id=String(row.id??'');const score=Number(row.score);
        if(!id||!Number.isFinite(score)||row.index_status!=='ready'||(!this.config.dictionary&&typeof row.text!=='string'))continue;
        if(!unique.has(id)||unique.get(id)!.score<score)unique.set(id,{chunkKey:id,score,...(!this.config.dictionary?{content:String(row.text)}:{})});
      }
    }
    return [...unique.values()].sort((a,b)=>b.score-a.score);
  }
  async deletePoints(ids:readonly string[],options?:OperationOptions):Promise<void>{
    options?.signal?.throwIfAborted();
    for(let offset=0;offset<ids.length;offset+=128){const batch=ids.slice(offset,offset+128);if(batch.some(id=>!id))incompatible('Empty deletion ID');
      await this.gate.run(()=>this.operation('delete',async c=>{options?.signal?.throwIfAborted();ok(await c.deleteEntities({collection_name:this.collection,expr:`id in [${batch.map(quote).join(',')}]`}), 'delete');}));
    }
  }
}

/** Separate capability facades share the same driver. Keyword clients never
 * expose dense or native hybrid methods; no placeholder vectors are needed. */
export function createMilvusKeywordIndex(config:MilvusIndexConfig,clientFactory?:()=>MilvusClient):KeywordIndex {
 const driver=new MilvusIndexDriver({...config,kind:'keyword'},clientFactory);
 return {
  kind:'keyword',ensureReady:()=>driver.ensureReady(),
  upsert:(points,options)=>driver.upsert(points,options),
  searchKeyword:(query,options)=>driver.searchKeyword(query,options),
  prepareKeywordSearch:query=>driver.prepareKeywordSearch(query),
  deletePoints:(ids,options)=>driver.deletePoints(ids,options),close:()=>driver.close(),
 };
}
export function createMilvusVectorIndex(config:MilvusIndexConfig,clientFactory?:()=>MilvusClient):VectorIndex {
 const driver=new MilvusIndexDriver({...config,kind:'vector'},clientFactory);
 return {
  kind:'vector',ensureReady:()=>driver.ensureReady(),
  upsert:(points,options)=>driver.upsert(points,options),
  search:(vector,options)=>driver.search(vector,options),
  deletePoints:(ids,options)=>driver.deletePoints(ids,options),close:()=>driver.close(),
 };
}
export function createMilvusHybridIndex(config:MilvusIndexConfig,clientFactory?:()=>MilvusClient):HybridIndex {
 const driver=new MilvusIndexDriver({...config,kind:'hybrid'},clientFactory);
 return {
  kind:'hybrid',ensureReady:()=>driver.ensureReady(),
  upsert:(points,options)=>driver.upsert(points,options),
  searchKeyword:(query,options)=>driver.searchKeyword(query,options),
  prepareKeywordSearch:query=>driver.prepareKeywordSearch(query),
  search:(vector,options)=>driver.search(vector,options),
  hybridSearch:(vector,query,options)=>driver.hybridSearch(vector,query,options),
  deletePoints:(ids,options)=>driver.deletePoints(ids,options),close:()=>driver.close(),
 };
}
