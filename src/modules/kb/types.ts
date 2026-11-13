import type { VectorTarget } from '../../lib/rag-indexing/index.js';
export type IndexMode='note-hybrid'|'document-keyword';
export type KbSourceType='note'|'file'|'text';
export interface KbSnapshot {
  mode:IndexMode; providerMode:'live'|'mock'|'disabled'; format:'markdown'|'text';
  businessStore:string; rules:{maxChars:number;overlapChars:number;version:'paragraph-sections'};
  target:VectorTarget; configHash:string;
  embedding?:{model:string;dimensions:number;profile:string;baseUrl?:string};
  tokenizer?:{model:string;tokenizerPath:string;tokenizerConfigPath:string;maxInputTokens:number;expectedSha256:string;expectedConfigSha256:string};
  indexing:{batchSize:number;concurrency:number;timeoutMs:number;maxRetries:number};
}
export interface KbSource {type:KbSourceType;id:string;revision:string;userId:string;workspaceId:string;content:string;format:'text'|'markdown';}
export interface KbBuild {
 note_revision_id?:string;id:string; source_type:KbSourceType; source_id:string; source_revision:string; user_id:string;workspace_id:string;
 task_id:string;content_hash:string;config_hash:string;snapshot:KbSnapshot;status:string;published:boolean;
 cleanup_status:string;chunk_count:number;planned:boolean;toc_status:'pending'|'ready'|'failed';toc:import('../../lib/document-processing/types.js').TocItem[]|null;
}
export interface IndexPoint {id:string;sourceId:string;sourceType:KbSourceType;userId:string;workspaceId:string;content:string;embedding?:number[];}
export interface RecallScope {userId:string;workspaceId:string;pointIds:readonly string[];}
export interface RecallHit {chunkKey:string;score:number;content:string;}
/** Deliberately contains no model, tokenizer or dense-vector methods. */
export interface KeywordIndex {
 ensureReady():Promise<void>;upsert(points:IndexPoint[],options?:{signal?:AbortSignal}):Promise<void>;
 searchKeyword(query:string,options:{scope:RecallScope;limit:number}):Promise<RecallHit[]>;
 deletePoints(ids:readonly string[]):Promise<void>;close():Promise<void>;
}
export interface HybridIndex extends KeywordIndex {
 search(vector:number[],options:{scope:RecallScope;limit:number}):Promise<RecallHit[]>;
 hybridSearch(vector:number[],query:string,options:{scope:RecallScope;limit:number}):Promise<RecallHit[]>;
}
export const tablesFor=(mode:IndexMode)=>mode==='note-hybrid'
 ? {builds:'kb_note_hybrid_builds',chunks:'kb_note_hybrid_chunks'} as const
 : {builds:'kb_document_keyword_builds',chunks:'kb_document_keyword_chunks'} as const;
