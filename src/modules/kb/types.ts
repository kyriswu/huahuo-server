import type { VectorTarget } from '../../lib/rag-indexing/index.js';
export type IndexMode='note-hybrid'|'document-keyword';
export type KbSourceType='note'|'file'|'text';
export interface KbSnapshot {
  mode:IndexMode; providerMode:'live'|'mock'|'disabled'; format:'markdown'|'text';
  businessStore:string; rules:{maxChars:number;overlapChars:number;version:'paragraph-sections'};
  target:VectorTarget; configHash:string;
  embedding?:{model:string;dimensions:number;profile:string;baseUrl?:string};
  /** Conservative input budget, not the proprietary model tokenizer or billing usage. */
  tokenizer?:{model:string;id:string;maxInputTokens:number};
  indexing:{batchSize:number;concurrency:number;timeoutMs:number;maxRetries:number};
}
export interface KbSource {type:KbSourceType;id:string;revision:string;userId:string;workspaceId:string;content:string;format:'text'|'markdown';}
export interface KbBuild {
 note_revision_id?:string;id:string; source_type:KbSourceType; source_id:string; source_revision:string; user_id:string;workspace_id:string;
 task_id:string;content_hash:string;config_hash:string;snapshot:KbSnapshot;status:string;published:boolean;
 cleanup_status:string;chunk_count:number;planned:boolean;toc_status:'pending'|'ready'|'failed';toc:import('../../lib/document-processing/types.js').TocItem[]|null;
}
export const tablesFor=(mode:IndexMode)=>mode==='note-hybrid'
 ? {builds:'kb_note_hybrid_builds',chunks:'kb_note_hybrid_chunks'} as const
 : {builds:'kb_document_keyword_builds',chunks:'kb_document_keyword_chunks'} as const;
