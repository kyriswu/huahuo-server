import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AppConfig } from '../../config/config.js';
import type { TokenCounter } from '../../lib/document-processing/types.js';
import { loadModelTokenizer } from '../../lib/document-processing/tokenizer.js';
import type { VectorTarget } from '../../lib/rag-indexing/index.js';
import { vectorConnectionId } from './vector-store.js';
import { DeterministicEmbeddingClient, OpenAICompatibleEmbeddingClient } from './adapters/embedding.js';
import { DomainError } from '../identity/store.js';
import { storeIdentity } from '../../plugins/store-identity.js';

export const FILE_CHUNK_MAX_CHARS = 2000;

export interface FileProcessingSnapshot {
  version:'file-processing';
  providerMode:AppConfig['rag']['providerMode'];
  businessStore:string;
  format:'markdown'|'text';
  split:{targetTokens:number;maxEmbeddingTokens:number;overlapTokens:number;maxSourceChars:number;respectSections:true};
  tokenizer:{model:string;tokenizerPath:string;tokenizerConfigPath:string;maxInputTokens:number;expectedSha256?:string;expectedConfigSha256?:string};
  embedding:{model:string;dimensions:number;profile:string;baseUrl?:string};
  indexing:{batchSize:number;concurrency:number;timeoutMs:number;maxRetries:number};
  parser:{model:AppConfig['rag']['mineruModel'];baseUrl:string;pollIntervalMs:number;timeoutMs:number};
  vectorTarget:VectorTarget;
  connectionAddress?:string;
}
export function fileSplitOptions(config: AppConfig['rag']): FileProcessingSnapshot['split'] {
  return {
    targetTokens: config.childTargetTokens,
    maxEmbeddingTokens: config.childMaxTokens,
    overlapTokens: config.childOverlapTokens,
    maxSourceChars: FILE_CHUNK_MAX_CHARS,
    respectSections: true,
  };
}
export function fileProcessingSnapshot(config:AppConfig,format:FileProcessingSnapshot['format']):FileProcessingSnapshot {
  if(!config.milvus.database||!config.milvus.collection)throw new Error('VECTOR_TARGET_REQUIRED');
  for(const endpoint of [config.rag.embeddingBaseUrl,config.rag.mineruBaseUrl].filter((v):v is string=>!!v)){
    const url=new URL(endpoint);if(url.username||url.password||url.search||url.hash)throw new DomainError(503,'PROCESSING_ENDPOINT_INVALID');
  }
  const snapshot:FileProcessingSnapshot={version:'file-processing',providerMode:config.rag.providerMode,businessStore:storeIdentity(config.databaseUrl),format,
    split:fileSplitOptions(config.rag),
    tokenizer:{model:config.rag.embeddingModel,tokenizerPath:config.rag.tokenizerPath,tokenizerConfigPath:config.rag.tokenizerConfigPath,maxInputTokens:config.rag.tokenizerMaxInputTokens},
    embedding:{model:config.rag.embeddingModel,dimensions:config.rag.embeddingDimensions,profile:config.rag.embeddingProfile,...(config.rag.embeddingBaseUrl?{baseUrl:config.rag.embeddingBaseUrl}:{})},
    indexing:{batchSize:config.rag.embeddingBatchSize,concurrency:config.rag.indexingConcurrency,timeoutMs:config.rag.embeddingTimeoutMs,maxRetries:config.rag.embeddingMaxRetries},
    parser:{model:config.rag.mineruModel,baseUrl:config.rag.mineruBaseUrl,pollIntervalMs:config.rag.mineruPollIntervalMs,timeoutMs:config.rag.mineruTimeoutMs},
    vectorTarget:{connectionId:vectorConnectionId(config),database:config.milvus.database,collection:config.milvus.collection},
    ...(config.milvus.address?{connectionAddress:config.milvus.address}:{}),};
  if(config.rag.providerMode==='live'){
    try{
    snapshot.tokenizer.expectedSha256=createHash('sha256').update(readFileSync(snapshot.tokenizer.tokenizerPath)).digest('hex');
    snapshot.tokenizer.expectedConfigSha256=createHash('sha256').update(readFileSync(snapshot.tokenizer.tokenizerConfigPath)).digest('hex');
    }catch{throw new DomainError(503,'RAG_TOKENIZER_FILES_UNAVAILABLE');}
  }
  return snapshot;
}
export async function processingTokenizer(config:AppConfig,snapshot:FileProcessingSnapshot):Promise<TokenCounter>{
  if(snapshot.providerMode!==config.rag.providerMode)throw new Error('RAG_PROVIDER_CHANGED');
  if(snapshot.businessStore!==storeIdentity(config.databaseUrl))throw new Error('RAG_BUSINESS_STORE_CHANGED');
  if(snapshot.embedding.baseUrl!==config.rag.embeddingBaseUrl)throw new Error('RAG_EMBEDDING_TARGET_CHANGED');
  if(config.rag.providerMode==='mock'&&config.appEnv!=='production')return {id:'explicit-test-codepoint-counter',model:snapshot.embedding.model,maxInputTokens:snapshot.tokenizer.maxInputTokens,count:text=>Array.from(text).length};
  return loadModelTokenizer(snapshot.tokenizer);
}
export function processingEmbedding(config:AppConfig,model:string,dimensions:number){
  if(config.rag.providerMode==='mock'){const mock=new DeterministicEmbeddingClient(dimensions);return {model,dimensions,embed:(texts:string[])=>mock.embed(texts)};}
  if(!config.rag.embeddingBaseUrl||!config.rag.embeddingApiKey)throw new Error('RAG_EMBEDDING_CONFIG_MISSING');
  return new OpenAICompatibleEmbeddingClient({baseUrl:config.rag.embeddingBaseUrl,apiKey:config.rag.embeddingApiKey,model,dimensions,sendDimensions:config.rag.embeddingSendDimensions,timeoutMs:config.rag.embeddingTimeoutMs,maxRetries:config.rag.embeddingMaxRetries});
}
export function fileChunkKey(parentId:string,revision:string,profile:string,ordinal:number):string{return 'file-'+createHash('sha256').update(JSON.stringify(['file',parentId,revision,profile,ordinal])).digest('hex');}
