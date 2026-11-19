import type pg from 'pg';
import { PgLexicalDictionary } from './lexical-dictionary.js';
import { DEFAULT_CONTENT_ASSET_COLLECTION, type AppConfig } from '../../config/config.js';
import type { TokenCounter } from '../../lib/document-processing/types.js';
import { storeIdentity } from '../../plugins/store-identity.js';
import { DeterministicEmbeddingClient, BailianEmbeddingClient } from '../rag/adapters/embedding.js';
import { CONTENT_ASSET_EMBEDDING_MODEL, CONTENT_ASSET_EMBEDDING_PROFILE, CONTENT_ASSET_EMBEDDING_MAX_INPUT_TOKENS, CONTENT_ASSET_EMBEDDING_MAX_BATCH_SIZE } from '../rag/model-profile.js';
import { createMilvusKeywordIndex, createMilvusHybridIndex } from '../../integrations/search-index/milvus.js';
import { createSearchIndex, type IndexFactories } from '../../lib/search-index/factory.js';
import type { HybridIndex, KeywordIndex } from '../../lib/search-index/types.js';
import { digest } from '../../lib/crypto.js';
import type { IndexMode, KbSnapshot, KbSourceType } from './types.js';
export const connectionId=(config:AppConfig)=>'milvus-'+digest(JSON.stringify([config.milvus.address??'mock',config.milvus.tls])).slice(0,20);
export function snapshotForSource(config:AppConfig,sourceType:KbSourceType,format:'text'|'markdown'):KbSnapshot {
 const mode:IndexMode=sourceType==='content_asset'?'hybrid':'keyword';
 const target={connectionId:connectionId(config),database:config.milvus.database,collection:sourceType==='content_asset'?config.kb.contentAssetCollection:config.kb.documentCollection};
 const snapshot:KbSnapshot={mode,providerMode:config.rag.providerMode,format,businessStore:storeIdentity(config.databaseUrl),target,
  rules:{maxChars:mode==='hybrid'?500:2000,overlapChars:mode==='hybrid'?50:0,version:'paragraph-sections'},
  indexing:{batchSize:mode==='hybrid'?Math.min(CONTENT_ASSET_EMBEDDING_MAX_BATCH_SIZE,config.rag.embeddingBatchSize):config.rag.embeddingBatchSize,concurrency:config.rag.indexingConcurrency,timeoutMs:config.rag.embeddingTimeoutMs,maxRetries:config.rag.embeddingMaxRetries},configHash:''};
 if(mode==='hybrid'){
  snapshot.embedding={model:config.rag.embeddingModel,dimensions:config.rag.embeddingDimensions,profile:config.rag.embeddingProfile,...(config.rag.embeddingBaseUrl?{baseUrl:config.rag.embeddingBaseUrl}:{})};
  snapshot.tokenizer={model:CONTENT_ASSET_EMBEDDING_MODEL,id:'utf8-byte-upper-bound-v1',maxInputTokens:CONTENT_ASSET_EMBEDDING_MAX_INPUT_TOKENS};
 }
 snapshot.configHash=indexIdentityHash(snapshot);
 if(sourceType==='content_asset'){
  snapshot.pointIdentityHash=snapshot.configHash;
  snapshot.indexLayout='sparse-v1';
  snapshot.accountScope=true;
  snapshot.assetMetadata=true;
  snapshot.target={...target,collection:target.collection+'_asset_v2'};
  snapshot.configHash=indexIdentityHash(snapshot);
 }else if(config.kb.indexLayout==='sparse-v1'){
  snapshot.pointIdentityHash=snapshot.configHash;
  snapshot.indexLayout='sparse-v1';
  snapshot.target={...target,collection:target.collection+'_sparse_v1'};
  snapshot.configHash=indexIdentityHash(snapshot);
 }
 return snapshot;
}
function indexIdentityHash(snapshot:KbSnapshot):string {
 // Freeze the v1 hash input so naming-only changes preserve build and point IDs.
 const collection=snapshot.target.collection===DEFAULT_CONTENT_ASSET_COLLECTION
  ? 'huahuo_kb_note_hybrid_chunks'
  : snapshot.target.collection;
 const mode=snapshot.mode==='hybrid'?'content-asset-hybrid':'document-keyword';
 return digest(JSON.stringify({...snapshot,mode,target:{...snapshot.target,collection},configHash:''}));
}
export function kbTokenizer(snapshot:KbSnapshot):Promise<TokenCounter>{
 if(snapshot.mode!=='hybrid'||!snapshot.tokenizer)throw new Error('KB_TOKENIZER_NOT_APPLICABLE');
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
export function knowledgeIndex(config:AppConfig,snapshot:KbSnapshot,providers?:IndexFactories,pool?:pg.Pool):KeywordIndex|HybridIndex{
 if(snapshot.businessStore!==storeIdentity(config.databaseUrl)||!snapshot.target.database||!snapshot.target.collection)throw new Error('KB_TARGET_CHANGED');
 if(snapshot.indexLayout==='sparse-v1'&&!pool&&!providers)throw new Error('KB_LEXICAL_DICTIONARY_REQUIRED');
 const dictionary=snapshot.indexLayout==='sparse-v1'&&pool?new PgLexicalDictionary(pool):undefined;
 const defaultProviders:IndexFactories={
  keyword:binding=>{
   if(binding.connectionId!==connectionId(config))throw new Error('KB_TARGET_CHANGED');
   return createMilvusKeywordIndex({...config.milvus,database:binding.namespace!,collection:binding.index,dictionary,maxContentChars:snapshot.rules.maxChars});
  },
  hybrid:binding=>{
   if(binding.connectionId!==connectionId(config))throw new Error('KB_TARGET_CHANGED');
   return createMilvusHybridIndex({...config.milvus,database:binding.namespace!,collection:binding.index,dictionary,accountScope:snapshot.accountScope===true,assetMetadata:snapshot.assetMetadata===true,maxContentChars:snapshot.rules.maxChars,dimensions:snapshot.embedding?.dimensions});
  },
 };
 return createSearchIndex(snapshot.mode,{
  connectionId:snapshot.target.connectionId,namespace:snapshot.target.database,index:snapshot.target.collection,
 },providers??defaultProviders);
}
