import type { AppConfig } from '../../config/config.js';
import type { TokenCounter } from '../../lib/document-processing/types.js';
import { storeIdentity } from '../../plugins/store-identity.js';
import { DeterministicEmbeddingClient, BailianEmbeddingClient } from '../rag/adapters/embedding.js';
import { CONTENT_ASSET_EMBEDDING_MODEL, CONTENT_ASSET_EMBEDDING_PROFILE, CONTENT_ASSET_EMBEDDING_MAX_INPUT_TOKENS, CONTENT_ASSET_EMBEDDING_MAX_BATCH_SIZE } from '../rag/model-profile.js';
import { createMilvusKeywordIndex, createMilvusHybridIndex } from '../../integrations/search-index/milvus.js';
import { createSearchIndex, type IndexFactories } from '../../lib/search-index/factory.js';
import type { HybridIndex, KeywordIndex } from '../../lib/search-index/types.js';
import { digest } from '../../lib/crypto.js';
import type { IndexMode, KbSnapshot } from './types.js';
export const connectionId=(config:AppConfig)=>'milvus-'+digest(JSON.stringify([config.milvus.address??'mock',config.milvus.tls])).slice(0,20);
export function kbSnapshot(config:AppConfig,mode:IndexMode,format:'text'|'markdown'):KbSnapshot {
 const target={connectionId:connectionId(config),database:config.milvus.database,collection:mode==='content-asset-hybrid'?config.kb.contentAssetCollection:config.kb.documentCollection};
 const snapshot:KbSnapshot={mode,providerMode:config.rag.providerMode,format,businessStore:storeIdentity(config.databaseUrl),target,
  rules:{maxChars:mode==='content-asset-hybrid'?500:2000,overlapChars:mode==='content-asset-hybrid'?50:0,version:'paragraph-sections'},
  indexing:{batchSize:mode==='content-asset-hybrid'?Math.min(CONTENT_ASSET_EMBEDDING_MAX_BATCH_SIZE,config.rag.embeddingBatchSize):config.rag.embeddingBatchSize,concurrency:config.rag.indexingConcurrency,timeoutMs:config.rag.embeddingTimeoutMs,maxRetries:config.rag.embeddingMaxRetries},configHash:''};
 if(mode==='content-asset-hybrid'){
  snapshot.embedding={model:config.rag.embeddingModel,dimensions:config.rag.embeddingDimensions,profile:config.rag.embeddingProfile,...(config.rag.embeddingBaseUrl?{baseUrl:config.rag.embeddingBaseUrl}:{})};
  snapshot.tokenizer={model:CONTENT_ASSET_EMBEDDING_MODEL,id:'utf8-byte-upper-bound-v1',maxInputTokens:CONTENT_ASSET_EMBEDDING_MAX_INPUT_TOKENS};
 }
 snapshot.configHash=digest(JSON.stringify(snapshot));return snapshot;
}
export function kbTokenizer(snapshot:KbSnapshot):Promise<TokenCounter>{
 if(snapshot.mode!=='content-asset-hybrid'||!snapshot.tokenizer)throw new Error('KB_TOKENIZER_NOT_APPLICABLE');
 if(snapshot.tokenizer.model!==CONTENT_ASSET_EMBEDDING_MODEL||snapshot.tokenizer.id!=='utf8-byte-upper-bound-v1')throw new Error('KB_PROFILE_CHANGED');
 // The hosted model does not publish a matching local tokenizer. UTF-8 bytes
 // plus special-token allowance conservatively bound these short inputs;
 // provider usage is still the only source of actual token/billing counts.
 return Promise.resolve({...snapshot.tokenizer,count:(text:string)=>Buffer.byteLength(text,'utf8')+16});
}
export function kbEmbedding(config:AppConfig,snapshot:KbSnapshot){
 if(!snapshot.embedding)throw new Error('KB_EMBEDDING_NOT_APPLICABLE');
 if(config.rag.providerMode==='disabled')throw new Error('KB_EMBEDDING_DISABLED');
 const {model,dimensions}=snapshot.embedding;
 if(model!==CONTENT_ASSET_EMBEDDING_MODEL||snapshot.embedding.profile!==CONTENT_ASSET_EMBEDDING_PROFILE||dimensions!==1024)throw new Error('KB_PROFILE_CHANGED');
 if(config.rag.providerMode==='mock')return Object.assign(new DeterministicEmbeddingClient(dimensions),{model});
 if(snapshot.embedding.baseUrl!==config.rag.embeddingBaseUrl||!config.rag.embeddingApiKey||!config.rag.embeddingBaseUrl)throw new Error('KB_EMBEDDING_UNAVAILABLE');
 return new BailianEmbeddingClient({baseUrl:config.rag.embeddingBaseUrl,apiKey:config.rag.embeddingApiKey,model,dimensions,timeoutMs:snapshot.indexing.timeoutMs,maxRetries:0});
}
export type IndexFactory=(snapshot:KbSnapshot)=>KeywordIndex|HybridIndex;
export function knowledgeIndex(config:AppConfig,snapshot:KbSnapshot,providers?:IndexFactories):KeywordIndex|HybridIndex{
 if(snapshot.businessStore!==storeIdentity(config.databaseUrl)||!snapshot.target.database||!snapshot.target.collection)throw new Error('KB_TARGET_CHANGED');
 const defaultProviders:IndexFactories={
  keyword:binding=>{
   if(binding.connectionId!==connectionId(config))throw new Error('KB_TARGET_CHANGED');
   return createMilvusKeywordIndex({...config.milvus,database:binding.namespace!,collection:binding.index,maxContentChars:snapshot.rules.maxChars});
  },
  hybrid:binding=>{
   if(binding.connectionId!==connectionId(config))throw new Error('KB_TARGET_CHANGED');
   return createMilvusHybridIndex({...config.milvus,database:binding.namespace!,collection:binding.index,maxContentChars:snapshot.rules.maxChars,dimensions:snapshot.embedding?.dimensions});
  },
 };
 return createSearchIndex(snapshot.mode==='content-asset-hybrid'?'hybrid':'keyword',{
  connectionId:snapshot.target.connectionId,namespace:snapshot.target.database,index:snapshot.target.collection,
 },providers??defaultProviders);
}
