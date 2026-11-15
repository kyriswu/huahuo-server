import { readFileSync } from 'node:fs';
import type { AppConfig } from '../../config/config.js';
import { loadModelTokenizer } from '../../lib/document-processing/tokenizer.js';
import type { TokenCounter } from '../../lib/document-processing/types.js';
import { storeIdentity } from '../../plugins/store-identity.js';
import { DeterministicEmbeddingClient, OpenAICompatibleEmbeddingClient } from '../rag/adapters/embedding.js';
import { MilvusRepository } from '../rag/adapters/milvus.js';
import { digest } from './split.js';
import type { HybridIndex, IndexMode, KbSnapshot } from './types.js';
export const connectionId=(config:AppConfig)=>'milvus-'+digest(JSON.stringify([config.milvus.address??'mock',config.milvus.tls])).slice(0,20);
export function kbSnapshot(config:AppConfig,mode:IndexMode,format:'text'|'markdown'):KbSnapshot {
 const target={connectionId:connectionId(config),database:config.milvus.database,collection:mode==='note-hybrid'?config.kb.noteCollection:config.kb.documentCollection};
 const snapshot:KbSnapshot={mode,providerMode:config.rag.providerMode,format,businessStore:storeIdentity(config.databaseUrl),target,
  rules:{maxChars:mode==='note-hybrid'?500:2000,overlapChars:mode==='note-hybrid'?50:0,version:'paragraph-sections'},
  indexing:{batchSize:config.rag.embeddingBatchSize,concurrency:config.rag.indexingConcurrency,timeoutMs:config.rag.embeddingTimeoutMs,maxRetries:config.rag.embeddingMaxRetries},configHash:''};
 if(mode==='note-hybrid'){
  const manifest=JSON.parse(readFileSync('resources/tokenizers/bge-m3/manifest.json','utf8')) as {files:Record<string,{sha256:string}>};
  snapshot.embedding={model:config.rag.embeddingModel,dimensions:config.rag.embeddingDimensions,profile:config.rag.embeddingProfile,...(config.rag.embeddingBaseUrl?{baseUrl:config.rag.embeddingBaseUrl}:{})};
  snapshot.tokenizer={model:'BAAI/bge-m3',tokenizerPath:config.rag.tokenizerPath,tokenizerConfigPath:config.rag.tokenizerConfigPath,maxInputTokens:8192,expectedSha256:manifest.files['tokenizer.json']!.sha256,expectedConfigSha256:manifest.files['tokenizer_config.json']!.sha256};
 }
 snapshot.configHash=digest(JSON.stringify(snapshot));return snapshot;
}
const tokenizers=new Map<string,Promise<TokenCounter>>();
export function kbTokenizer(snapshot:KbSnapshot):Promise<TokenCounter>{
 if(snapshot.mode!=='note-hybrid'||!snapshot.tokenizer)throw new Error('KB_TOKENIZER_NOT_APPLICABLE');
 const key=JSON.stringify([snapshot.tokenizer.model,snapshot.tokenizer.tokenizerPath,snapshot.tokenizer.tokenizerConfigPath,snapshot.tokenizer.maxInputTokens,snapshot.tokenizer.expectedSha256,snapshot.tokenizer.expectedConfigSha256]);
 if(!tokenizers.has(key))tokenizers.set(key,loadModelTokenizer(snapshot.tokenizer).catch(e=>{tokenizers.delete(key);throw e;}));
 return tokenizers.get(key)!;
}
export function kbEmbedding(config:AppConfig,snapshot:KbSnapshot){
 if(!snapshot.embedding)throw new Error('KB_EMBEDDING_NOT_APPLICABLE');
 if(config.rag.providerMode==='disabled')throw new Error('KB_EMBEDDING_DISABLED');
 const {model,dimensions}=snapshot.embedding;
 if(config.rag.providerMode==='mock')return Object.assign(new DeterministicEmbeddingClient(dimensions),{model});
 if(snapshot.embedding.baseUrl!==config.rag.embeddingBaseUrl||!config.rag.embeddingApiKey||!config.rag.embeddingBaseUrl)throw new Error('KB_EMBEDDING_UNAVAILABLE');
 return new OpenAICompatibleEmbeddingClient({baseUrl:config.rag.embeddingBaseUrl,apiKey:config.rag.embeddingApiKey,model,dimensions,sendDimensions:false,timeoutMs:snapshot.indexing.timeoutMs,maxRetries:0});
}
export type IndexFactory=(snapshot:KbSnapshot)=>HybridIndex;
export function knowledgeIndex(config:AppConfig,snapshot:KbSnapshot):HybridIndex{
 if(snapshot.businessStore!==storeIdentity(config.databaseUrl)||snapshot.target.connectionId!==connectionId(config)||!snapshot.target.database||!snapshot.target.collection)throw new Error('KB_TARGET_CHANGED');
 return new MilvusRepository({...config.milvus,database:snapshot.target.database,collection:snapshot.target.collection,mode:snapshot.mode});
}
