import { DataType, FunctionType, type FieldType, type FunctionObject } from '@zilliz/milvus2-sdk-node';
import type { IndexKind } from '../../lib/search-index/types.js';

export type ChunkLanguage = 'zh' | 'en' | 'mixed' | 'unknown';

/**
 * Analyzer routing heuristic, not a linguistic classifier or an embedding model.
 * Compare Han characters with Latin word units so a few long technical names do
 * not outweigh Chinese prose. A Latin share of 20% marks mixed content. Text
 * without either script falls back to the collection's Unicode analyzer.
 */
export function detectChunkLanguage(text: string): ChunkLanguage {
  const prose = text.replace(/\b(?:https?:\/\/|asset:\/\/)\S+/giu, ' ');
  const han = prose.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latin = prose.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/gu)?.length ?? 0;
  if (!han && !latin) return 'unknown';
  if (!han) return 'en';
  if (!latin) return 'zh';
  return latin / (han + latin) >= 0.2 ? 'mixed' : 'zh';
}

type AnalyzerParams =
  | { type: 'english' }
  | { tokenizer: 'jieba' | 'icu'; filter: string[] };

export interface MultiAnalyzerParams {
  by_field: string;
  analyzers: Record<string, AnalyzerParams>;
  alias: Record<string, string>;
}

// Each row uses exactly one analyzer, selected by language. Jieba preserves
// Chinese boundaries; lowercase makes technical terms such as MVCC comparable
// with English queries. Unknown language values use the required default.
export const MULTI_ANALYZER_PARAMS: MultiAnalyzerParams = {
  by_field: 'language',
  analyzers: {
    zh: { tokenizer: 'jieba', filter: ['cnalphanumonly', 'lowercase'] },
    en: { type: 'english' },
    mixed: { tokenizer: 'jieba', filter: ['cnalphanumonly', 'lowercase'] },
    default: { tokenizer: 'icu', filter: ['lowercase'] },
  },
  alias: { unknown: 'default' },
};

export const BM25_FUNCTION: FunctionObject = {
  name: 'huahuo_text_bm25',
  type: FunctionType.BM25,
  input_field_names: ['text'],
  output_field_names: ['sparse_vector'],
  params: {},
};

export const DENSE_INDEX_NAME = 'huahuo_dense_hnsw';
export const SPARSE_INDEX_NAME = 'huahuo_sparse_bm25';

export const SPARSE_IP_INDEX_NAME = 'huahuo_sparse_ip';
export const MILVUS_POINT_FIELDS = ['id','index_status'];
export const MILVUS_OUTPUT_FIELDS = ['id','source_id','source_type','text','index_status'];

export function buildMilvusSchema(kind: IndexKind, dimensions=1024, sparse=false, accountScope=false): FieldType[] {
  return [
    {name:'id',data_type:DataType.VarChar,is_primary_key:true,autoID:false,max_length:256},
    {name:'source_id',data_type:DataType.VarChar,max_length:256},
    {name:'source_type',data_type:DataType.VarChar,max_length:32},
    {name:'user_id',data_type:DataType.VarChar,max_length:256},
    ...(!accountScope?[{name:'workspace_id',data_type:DataType.VarChar,max_length:256}]:[]),
    ...(!sparse?[{name:'text',data_type:DataType.VarChar,max_length:65535,enable_analyzer:true,multi_analyzer_params:structuredClone(MULTI_ANALYZER_PARAMS)}]:[]),
    ...(!sparse?[{name:'language',data_type:DataType.VarChar,max_length:16}]:[]),
    {name:'index_status',data_type:DataType.VarChar,max_length:16},
    ...(kind!=='vector'?[{name:'sparse_vector',data_type:DataType.SparseFloatVector,...(!sparse?{is_function_output:true}:{})}]:[]),
    ...(kind!=='keyword'?[{name:'dense_vector',data_type:DataType.Float16Vector,dim:dimensions}]:[]),
  ];
}
