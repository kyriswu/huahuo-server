import { ConsistencyLevelEnum, DataType, FunctionType, IndexType, MetricType, MilvusClient, RRFRanker, type FieldSchema, type IndexDescription } from '@zilliz/milvus2-sdk-node';
import type { MilvusConfig } from '../../../config/config.js';
import type { ChildChunk } from '../types.js';
import type { VectorDeleteSelector } from '../../../lib/rag-indexing/index.js';
import { BM25_FUNCTION, buildMilvusSchema, DENSE_INDEX_NAME, detectChunkLanguage, MILVUS_OUTPUT_FIELDS, MULTI_ANALYZER_PARAMS, SPARSE_INDEX_NAME } from './milvus-schema.js';

export class MilvusError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = true, options?: { cause?: unknown }) { super(message, options); this.name = 'MilvusError'; }
}
export interface MilvusSearchHit {
  chunkKey: string; score: number; documentId?: string; documentVersion?: string;
  state?: string; chunkIndex?: number; parentId?: string;
  embeddingModel?: string; embeddingDimensions?: number;
}
interface MilvusOwnerScope { userId: string; workspaceId: string; }
export type MilvusSearchScope = MilvusOwnerScope & (
  | { sourceType?: 'file' | 'text'; versions: Array<{ documentId: string; versionId: string; embeddingProfile: string; indexBuildId: string }> }
  | { sourceType: 'note'; note: { documentId: string; embeddingProfile: string; chunkIds: readonly string[] } }
);
export interface MilvusSearchOptions { limit: number; dimensions: number; scope: MilvusSearchScope; ef?: number; }
export interface MilvusChunkInput {
  chunk: ChildChunk; embedding: number[]; documentId: string; documentVersion: string;
  state: 'building' | 'ready'; model: string; dimensions: number; userId: string;
  workspaceId: string; embeddingProfile: string; indexBuildId: string;
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

/** Business scope is mapped to physical fields only here; both recall paths share it. */
export function milvusScopeFilter(scope: MilvusSearchScope): string {
  if (!scope.userId || !scope.workspaceId) throw new MilvusError('MILVUS_SCOPE_REQUIRED', 'A verified user and workspace are required', false);
  const owner = `user_id == ${quote(scope.userId)} && workspace_id == ${quote(scope.workspaceId)} && index_status == "ready"`;
  if (scope.sourceType === 'note') {
    const note = scope.note;
    if (!note?.documentId || !note.embeddingProfile || !note.chunkIds?.length || note.chunkIds.some(id => !id)) {
      throw new MilvusError('MILVUS_SCOPE_REQUIRED', 'An authorized Note and ready chunk IDs are required', false);
    }
    return `${owner} && source_type == "note" && doc_id == ${quote(note.documentId)} && embedding_profile == ${quote(note.embeddingProfile)} && id in [${note.chunkIds.map(quote).join(',')}]`;
  }
  if (!scope.versions.length) throw new MilvusError('MILVUS_SCOPE_REQUIRED', 'Allowed versions are required', false);
  const versions = scope.versions.map(v => {
    if (![v.documentId, v.versionId, v.embeddingProfile, v.indexBuildId].every(Boolean)) throw new MilvusError('MILVUS_SCOPE_REQUIRED', 'Incomplete index scope', false);
    return `(doc_id == ${quote(v.documentId)} && document_version == ${quote(v.versionId)} && embedding_profile == ${quote(v.embeddingProfile)} && index_build_id == ${quote(v.indexBuildId)})`;
  });
  return `${owner}${scope.sourceType ? ` && source_type == ${quote(scope.sourceType)}` : ''} && (${versions.join(' || ')})`;
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
  const client = new MilvusClient({ address: config.address!, username: config.username!, password: config.password!, database: config.database, timeout: 15_000, maxRetries: 2, ssl: config.tls, logLevel: 'error' });
  void client.connectPromise.catch(() => undefined);
  return client;
}
export class MilvusRepository {
  private client: MilvusClient | undefined;
  private connectPromise: Promise<void> | undefined;
  private readyPromise: Promise<void> | undefined;
  private readyDimensions: number | undefined;
  private closed = false;
  private readonly collection: string;
  private readonly gate: AsyncGate;
  constructor(private readonly config: MilvusConfig, private readonly clientFactory = () => createMilvusClient(config)) {
    this.collection = config.collection;
    this.gate = new AsyncGate(config.searchConcurrency);
    if (!config.address || !config.username || !config.password) throw new MilvusError('MILVUS_CONFIG_INVALID', 'Milvus connection configuration is incomplete', false);
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
    this.connectPromise = undefined; this.readyPromise = undefined; this.readyDimensions = undefined;
    await client?.closeConnection().catch(() => undefined);
  }
  private async operation<T>(name: string, operation: (client: MilvusClient) => Promise<T>): Promise<T> {
    await this.connect();
    if (!this.client) throw new MilvusError('MILVUS_UNAVAILABLE', 'Milvus client is not connected');
    try { return await operation(this.client); }
    catch (error) { if (error instanceof MilvusError) throw error; throw new MilvusError('MILVUS_UNAVAILABLE', `${name} failed`, true, { cause: error }); }
  }
  async ensureReady(dimensions: number): Promise<void> {
    if (!Number.isInteger(dimensions) || dimensions < 1) incompatible('Invalid embedding dimensions');
    await this.connect();
    if (this.readyPromise) {
      if (this.readyDimensions !== dimensions) incompatible('Repository initialized with a different embedding dimension');
      return this.readyPromise;
    }
    this.readyDimensions = dimensions;
    this.readyPromise = this.ensureReadyOnce(dimensions).catch(error => { this.readyPromise = undefined; throw error; });
    return this.readyPromise;
  }
  private async ensureReadyOnce(dimensions: number): Promise<void> {
    await this.operation('ensureReady', async client => {
      const exists = await client.hasCollection({ collection_name: this.collection }); ok(exists, 'hasCollection');
      if (!exists.value) {
        if (!this.config.createIfMissing) throw new MilvusError('MILVUS_COLLECTION_MISSING', 'Configured collection does not exist', false);
        // Another process may create the same collection; validate it rather than drop/recreate.
        try { ok(await client.createCollection({ collection_name: this.collection, enable_dynamic_field: false, fields: buildMilvusSchema(dimensions), functions: [BM25_FUNCTION] }), 'createCollection'); }
        catch (error) { const raced = await client.hasCollection({ collection_name: this.collection }); ok(raced, 'hasCollection'); if (!raced.value) throw error; }
      }
      const desc = await client.describeCollection({ collection_name: this.collection }); ok(desc, 'describeCollection');
      for (const expected of buildMilvusSchema(dimensions)) {
        const field = desc.schema.fields.find(f => f.name === expected.name);
        if (!field || typeId(field.data_type) !== typeId(expected.data_type)) incompatible(`Invalid field ${expected.name}`);
        const params = fieldParams(field);
        if (expected.is_primary_key && (!field.is_primary_key || field.autoID)) incompatible('Primary key must be a stable caller supplied ID');
        if (expected.max_length && (!Number.isFinite(Number(params.max_length)) || Number(params.max_length) < Number(expected.max_length))) incompatible(`Field ${expected.name} is too short or missing max_length`);
        if (expected.name === 'dense_vector' && Number(params.dim) !== dimensions) incompatible('Dense embedding dimension mismatch');
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
      await this.ensureIndex(client, 'dense_vector', DENSE_INDEX_NAME, IndexType.HNSW, MetricType.COSINE, { M: 16, efConstruction: 128 });
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
  async upsert(chunks: MilvusChunkInput[]): Promise<void> {
    if (!chunks.length) return;
    const dimensions = chunks[0]!.dimensions;
    for (const row of chunks) {
      this.validateVector(row.embedding, dimensions);
      const versioned = row.chunk.sourceType !== 'note';
      if (row.dimensions !== dimensions || !row.chunk.chunkKey || !row.chunk.parentId || !row.chunk.sourceType || !row.embeddingProfile || !row.userId || !row.workspaceId || !row.documentId
        || (versioned && (!row.chunk.sourceRevision || !row.indexBuildId || !row.documentVersion))) incompatible('Incomplete chunk identity or embedding profile');
      if (Buffer.byteLength(row.chunk.content, 'utf8') > 65535) throw new MilvusError('MILVUS_TEXT_TOO_LARGE', 'Chunk exceeds text field byte limit', false);
    }
    await this.ensureReady(dimensions);
    await this.gate.run(() => this.operation('upsert', async client => {
      // No sparse_vector: the server BM25 Function owns it. Dense embeds embeddingText unchanged.
      const response = await client.upsert({ collection_name: this.collection, data: chunks.map(row => ({
        id: row.chunk.chunkKey!, doc_id: row.documentId, parent_id: row.chunk.parentId,
        source_type: row.chunk.sourceType, source_revision: row.chunk.sourceType === 'note' ? '' : row.chunk.sourceRevision,
        user_id: row.userId, workspace_id: row.workspaceId, document_version: row.chunk.sourceType === 'note' ? '' : row.documentVersion,
        index_status: row.state, chunk_index: row.chunk.sourceType === 'note' ? 0 : row.chunk.ordinal, embedding_profile: row.embeddingProfile,
        index_build_id: row.chunk.sourceType === 'note' ? '' : row.indexBuildId, embedding_model: row.model, embedding_dimensions: row.dimensions,
        embedding_text_hash: row.chunk.embeddingTextHash, text: row.chunk.content,
        language: detectChunkLanguage(row.chunk.content), dense_vector: row.embedding,
      })) }); ok(response, 'upsert');
      // Cloud Milvus can leave protobuf acknowledged=false even after a
      // successful upsert. Status, mutation counts and per-row results are the
      // write contract; reads use explicit strong consistency.
      const succeeded = response.succ_index?.map(Number) ?? [];
      const complete = !succeeded.length || (succeeded.length === chunks.length
        && new Set(succeeded).size === chunks.length
        && succeeded.every(index => Number.isInteger(index) && index >= 0 && index < chunks.length));
      if (response.err_index?.length || Number(response.upsert_cnt) !== chunks.length || !complete) throw new MilvusError('MILVUS_UPSERT_INCOMPLETE', 'Milvus did not acknowledge every chunk');
    }));
  }
  async search(embedding: number[], options: MilvusSearchOptions): Promise<MilvusSearchHit[]> {
    this.validateVector(embedding, options.dimensions);
    const response = await this.gate.run(() => this.operation('search', client => client.search({
      collection_name: this.collection, data: [embedding], anns_field: 'dense_vector', limit: options.limit,
      filter: milvusScopeFilter(options.scope), metric_type: MetricType.COSINE, output_fields: [...MILVUS_OUTPUT_FIELDS],
      params: { ef: Math.max(options.ef ?? 64, options.limit) }, consistency_level: ConsistencyLevelEnum.Strong,
    })));
    return this.parseHits('search', response);
  }
  async searchKeyword(query: string, options: { limit: number; scope: MilvusSearchScope }): Promise<MilvusSearchHit[]> {
    const filter = milvusScopeFilter(options.scope);
    const analyzer = detectChunkLanguage(query);
    const routes = [{ analyzer, filter }];
    // English stemming can remove a term that Jieba preserves in a Note.
    if (options.scope.sourceType === 'note' && analyzer === 'en') {
      routes.push({ analyzer: 'mixed', filter: `${filter} && language in ["zh","mixed"]` });
    }
    const responses = await Promise.all(routes.map(route => this.gate.run(() => this.operation('searchKeyword', client => client.search({
      collection_name: this.collection, data: query, anns_field: 'sparse_vector', limit: options.limit,
      filter: route.filter, metric_type: MetricType.BM25, output_fields: [...MILVUS_OUTPUT_FIELDS],
      params: { analyzer_name: route.analyzer, drop_ratio_search: 0 }, consistency_level: ConsistencyLevelEnum.Strong,
    })))));
    return this.parseHits('searchKeyword', ...responses).slice(0, options.limit);
  }
  async hybridSearch(embedding: number[], query: string, options: MilvusSearchOptions): Promise<MilvusSearchHit[]> {
    this.validateVector(embedding, options.dimensions);
    const filter = milvusScopeFilter(options.scope);
    const response = await this.gate.run(() => this.operation('hybridSearch', client => client.hybridSearch({
      collection_name: this.collection,
      data: [
        { data: [embedding], anns_field: 'dense_vector', expr: filter, params: { topk: this.config.denseCandidates, metric_type: MetricType.COSINE, params: JSON.stringify({ ef: Math.max(options.ef ?? 64, this.config.denseCandidates) }) } },
        { data: query, anns_field: 'sparse_vector', expr: filter, params: { topk: this.config.bm25Candidates, metric_type: MetricType.BM25, analyzer_name: detectChunkLanguage(query), params: JSON.stringify({ drop_ratio_search: 0 }) } },
      ],
      rerank: RRFRanker(this.config.rrfK), limit: options.limit, output_fields: [...MILVUS_OUTPUT_FIELDS], consistency_level: ConsistencyLevelEnum.Strong,
    })));
    return this.parseHits('hybridSearch', response);
  }
  private parseHits(operation: string, ...responses: unknown[]): MilvusSearchHit[] {
    const rows = responses.flatMap(response => {
      ok(response, operation);
      const results = record(response).results;
      if (!Array.isArray(results)) throw new MilvusError('MILVUS_RESPONSE_INVALID', 'Search results missing', false);
      return results;
    });
    const unique = new Map<string, MilvusSearchHit>();
    for (const value of rows) {
      const row = record(value); const score = Number(row.score); const key = String(row.id ?? '');
      if (!key || !Number.isFinite(score) || row.index_status !== 'ready') continue;
      const hit: MilvusSearchHit = { chunkKey: key, score, documentId: String(row.doc_id), documentVersion: String(row.document_version), state: 'ready', chunkIndex: Number(row.chunk_index), parentId: String(row.parent_id ?? ''), embeddingModel: String(row.embedding_model), embeddingDimensions: Number(row.embedding_dimensions) };
      if (!unique.has(key) || unique.get(key)!.score < score) unique.set(key, hit);
    }
    return [...unique.values()].sort((a, b) => b.score - a.score);
  }
  async count(documentId: string, documentVersion: string, state: 'building' | 'ready'): Promise<number> {
    const response = await this.operation('count', client => client.query({ collection_name: this.collection, filter: `doc_id == ${quote(documentId)} && document_version == ${quote(documentVersion)} && index_status == ${quote(state)}`, output_fields: ['count(*)'], consistency_level: ConsistencyLevelEnum.Strong }));
    ok(response, 'count'); return Number(response.data[0]?.['count(*)'] ?? 0);
  }
  async deleteVectors(selector: VectorDeleteSelector): Promise<void> {
    let filter:string;
    if(selector.ids){if(!selector.ids.length)return;filter=`id in [${selector.ids.map(quote).join(',')}]`;}
    else {
      const allowed=new Set(['parent_id','source_type','source_revision','user_id','workspace_id','document_version','index_build_id','doc_id']);
      const entries=Object.entries(selector.scope);
      if (selector.scope.source_type === 'note') throw new MilvusError('MILVUS_DELETE_SCOPE_INVALID', 'Note cleanup requires explicit physical point IDs', false);
      if(!entries.length||entries.some(([key])=>!allowed.has(key))||!selector.scope.source_type||!selector.scope.parent_id||!(selector.scope.source_revision||selector.scope.index_build_id))throw new MilvusError('MILVUS_DELETE_SCOPE_INVALID','Explicit source, whole parent and revision or index build are required',false);
      filter=entries.map(([key,value])=>`${key} == ${typeof value==='string'?quote(value):JSON.stringify(value)}`).join(' && ');
    }
    const response=await this.operation('delete',client=>client.deleteEntities({collection_name:this.collection,expr:filter}));ok(response,'delete');
  }
}
