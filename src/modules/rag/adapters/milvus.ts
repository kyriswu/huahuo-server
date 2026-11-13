import { ConsistencyLevelEnum, DataType, FunctionType, IndexType, MetricType, MilvusClient, RRFRanker, type FieldSchema, type IndexDescription } from '@zilliz/milvus2-sdk-node';
import type { MilvusConfig } from '../../../config/config.js';
import type { HybridIndex, IndexMode, IndexPoint, RecallHit, RecallScope } from '../../kb/types.js';
import { BM25_FUNCTION, buildMilvusSchema, DENSE_INDEX_NAME, detectChunkLanguage, MILVUS_OUTPUT_FIELDS, MULTI_ANALYZER_PARAMS, SPARSE_INDEX_NAME } from './milvus-schema.js';
// SDK 2.6.17 treats numeric Strong=0 as falsy; send its supported wire enum name.
const STRONG='Strong' as unknown as ConsistencyLevelEnum;
export class MilvusError extends Error {
 constructor(readonly code:string,message:string,readonly retryable=true,options?:{cause?:unknown}){super(message,options);this.name='MilvusError';}
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

export function milvusScopeFilter(scope:RecallScope):string {
 if(!scope.userId||!scope.workspaceId||!scope.pointIds.length||scope.pointIds.some(id=>!id))throw new MilvusError('MILVUS_SCOPE_REQUIRED','Verified ownership and ready point IDs required',false);
 return `user_id == ${quote(scope.userId)} && workspace_id == ${quote(scope.workspaceId)} && index_status == "ready" && id in [${scope.pointIds.map(quote).join(',')}]`;
}
function keywordRoutes(query:string,filter:string){
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
export class MilvusRepository implements HybridIndex {
 private client:MilvusClient|undefined;private connectPromise:Promise<void>|undefined;private readyPromise:Promise<void>|undefined;
 private closed=false;private readonly collection:string;private readonly gate:AsyncGate;
 constructor(private readonly config:MilvusConfig & {collection:string;mode:IndexMode},private readonly clientFactory=()=>createMilvusClient(config)){
  this.collection=config.collection;this.gate=new AsyncGate(config.searchConcurrency);
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
    this.connectPromise = undefined; this.readyPromise = undefined;
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
  private async ensureReadyOnce(): Promise<void> {
    await this.operation('ensureReady', async client => {
      const exists = await client.hasCollection({ collection_name: this.collection }); ok(exists, 'hasCollection');
      if (!exists.value) {
        if (!this.config.createIfMissing) throw new MilvusError('MILVUS_COLLECTION_MISSING', 'Configured collection does not exist', false);
        // Another process may create the same collection; validate it rather than drop/recreate.
        try { ok(await client.createCollection({ collection_name: this.collection, enable_dynamic_field: false, fields: buildMilvusSchema(this.config.mode), functions: [BM25_FUNCTION] }), 'createCollection'); }
        catch (error) { const raced = await client.hasCollection({ collection_name: this.collection }); ok(raced, 'hasCollection'); if (!raced.value) throw error; }
      }
      const desc = await client.describeCollection({ collection_name: this.collection }); ok(desc, 'describeCollection');
      if(this.config.mode==='document-keyword'&&desc.schema.fields.some(f=>typeId(f.data_type)===DataType.FloatVector))incompatible('Keyword collection must not contain dense vectors');
      for (const expected of buildMilvusSchema(this.config.mode)) {
        const field = desc.schema.fields.find(f => f.name === expected.name);
        if (!field || typeId(field.data_type) !== typeId(expected.data_type)) incompatible(`Invalid field ${expected.name}`);
        const params = fieldParams(field);
        if (expected.is_primary_key && (!field.is_primary_key || field.autoID)) incompatible('Primary key must be a stable caller supplied ID');
        if (expected.max_length && (!Number.isFinite(Number(params.max_length)) || Number(params.max_length) < Number(expected.max_length))) incompatible(`Field ${expected.name} is too short or missing max_length`);
        if (expected.name === 'dense_vector' && Number(params.dim) !== 1024) incompatible('Dense embedding dimension mismatch');
        if (expected.name === 'sparse_vector' && !field.is_function_output) incompatible('Sparse vector must be generated by BM25');
        if (expected.name === 'text') {
          if (![true, 'true'].includes(params.enable_analyzer as boolean | string)) incompatible('Text analyzer must be enabled');
          let multi: unknown = params.multi_analyzer_params;
          if (typeof multi === 'string') { try { multi = JSON.parse(multi); } catch { incompatible('Invalid multi-language analyzer'); } }
          if (canonical(multi) !== canonical(MULTI_ANALYZER_PARAMS)) incompatible('Multi-language analyzer does not match the collection schema');
        }
      }
      const functions = [...(desc.schema.functions ?? []), ...(desc.functions ?? [])];
      if (!functions.some(fn => fn.name === BM25_FUNCTION.name && (fn.type === FunctionType.BM25 || String(fn.type) === 'BM25') && canonical(fn.input_field_names) === canonical(['text']) && canonical(fn.output_field_names) === canonical(['sparse_vector']))) incompatible('BM25 text to sparse_vector function is missing');
      if(this.config.mode==='note-hybrid')await this.ensureIndex(client, 'dense_vector', DENSE_INDEX_NAME, IndexType.HNSW, MetricType.COSINE, { M: 16, efConstruction: 128 });
      await this.ensureIndex(client, 'sparse_vector', SPARSE_INDEX_NAME, 'SPARSE_INVERTED_INDEX', MetricType.BM25, { inverted_index_algo: 'DAAT_MAXSCORE' });
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
  private validateVector(vector: number[], dimensions: number): void {
    if (vector.length !== dimensions || vector.some(v => !Number.isFinite(v)) || vector.every(v => v === 0)) incompatible('Invalid embedding vector or dimension');
  }
  async upsert(points:IndexPoint[],options?:{signal?:AbortSignal}):Promise<void>{
    options?.signal?.throwIfAborted();
    if(!points.length)return;
    for(const point of points){
      if(!point.id||!point.sourceId||!point.sourceType||!point.userId||!point.workspaceId||!point.content.trim())incompatible('Incomplete point');
      if(Array.from(point.content).length>(this.config.mode==='note-hybrid'?500:2000))incompatible('Chunk exceeds mode limit');
      if(this.config.mode==='note-hybrid')this.validateVector(point.embedding??[],1024);
      else if(point.embedding!==undefined)incompatible('Keyword collection does not accept dense vectors');
    }
    await this.ensureReady();
    await this.gate.run(()=>this.operation('upsert',async client=>{
      const response=await client.upsert({collection_name:this.collection,data:points.map(p=>({
        id:p.id,source_id:p.sourceId,source_type:p.sourceType,user_id:p.userId,workspace_id:p.workspaceId,
        text:p.content,language:detectChunkLanguage(p.content),index_status:'ready',
        ...(this.config.mode==='note-hybrid'?{dense_vector:p.embedding!}:{}),
      }))});ok(response,'upsert');
      if(response.err_index?.length||Number(response.upsert_cnt)!==points.length)throw new MilvusError('MILVUS_UPSERT_INCOMPLETE','Incomplete index write');
    }));
  }
  async search(vector:number[],options:{scope:RecallScope;limit:number}):Promise<RecallHit[]>{
    if(this.config.mode!=='note-hybrid')incompatible('Dense search is not enabled');this.validateVector(vector,1024);await this.ensureReady();
    const response=await this.gate.run(()=>this.operation('search',c=>c.search({collection_name:this.collection,data:[vector],anns_field:'dense_vector',filter:milvusScopeFilter(options.scope),limit:options.limit,metric_type:MetricType.COSINE,params:{ef:Math.max(64,options.limit)},output_fields:MILVUS_OUTPUT_FIELDS,consistency_level:STRONG})));
    return this.parseHits(response);
  }
  async searchKeyword(query:string,options:{scope:RecallScope;limit:number}):Promise<RecallHit[]>{
    await this.ensureReady();const filter=milvusScopeFilter(options.scope);const routes=keywordRoutes(query,filter);
    const responses=await Promise.all(routes.map(route=>this.gate.run(()=>this.operation('keyword',c=>c.search({collection_name:this.collection,data:query,anns_field:'sparse_vector',filter:route.filter,limit:options.limit,metric_type:MetricType.BM25,params:{analyzer_name:route.analyzer,drop_ratio_search:0},output_fields:MILVUS_OUTPUT_FIELDS,consistency_level:STRONG})))));
    return this.parseHits(...responses).slice(0,options.limit);
  }
  async hybridSearch(vector:number[],query:string,options:{scope:RecallScope;limit:number}):Promise<RecallHit[]>{
    if(this.config.mode!=='note-hybrid')incompatible('Hybrid search is not enabled');this.validateVector(vector,1024);await this.ensureReady();
    const filter=milvusScopeFilter(options.scope);
    const response=await this.gate.run(()=>this.operation('hybrid',c=>c.hybridSearch({collection_name:this.collection,data:[
      {data:[vector],anns_field:'dense_vector',expr:filter,params:{topk:this.config.denseCandidates,metric_type:MetricType.COSINE,params:JSON.stringify({ef:Math.max(64,this.config.denseCandidates)})}},
      ...(keywordRoutes(query,filter).map(route=>({data:query,anns_field:'sparse_vector',expr:route.filter,params:{topk:this.config.bm25Candidates,metric_type:MetricType.BM25,analyzer_name:route.analyzer,params:JSON.stringify({drop_ratio_search:0})}}))),
    ],rerank:RRFRanker(this.config.rrfK),limit:options.limit,output_fields:MILVUS_OUTPUT_FIELDS,consistency_level:STRONG})));
    return this.parseHits(response);
  }
  private parseHits(...responses:unknown[]):RecallHit[]{
    const unique=new Map<string,RecallHit>();
    for(const response of responses){ok(response,'search');const rows=record(response).results;
      if(!Array.isArray(rows))throw new MilvusError('MILVUS_RESPONSE_INVALID','Missing results',false);
      for(const value of rows){const row=record(value);const id=String(row.id??'');const score=Number(row.score);
        if(!id||!Number.isFinite(score)||row.index_status!=='ready'||typeof row.text!=='string')continue;
        if(!unique.has(id)||unique.get(id)!.score<score)unique.set(id,{chunkKey:id,score,content:row.text});
      }
    }
    return [...unique.values()].sort((a,b)=>b.score-a.score);
  }
  async deletePoints(ids:readonly string[]):Promise<void>{
    for(let offset=0;offset<ids.length;offset+=128){const batch=ids.slice(offset,offset+128);if(batch.some(id=>!id))incompatible('Empty deletion ID');
      await this.gate.run(()=>this.operation('delete',async c=>{ok(await c.deleteEntities({collection_name:this.collection,expr:`id in [${batch.map(quote).join(',')}]`}), 'delete');}));
    }
  }
}
