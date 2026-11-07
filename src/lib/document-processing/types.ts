/** Offsets always address the unchanged JavaScript string: UTF-16 [start,end). */
export interface TocItem { sectionId: string; kind: 'heading' | 'preamble' | 'body'; title: string; level: number; anchor: string; headingPath: string[]; sourceStart: number; sourceEnd: number; children: TocItem[]; }
export type TocStatus = 'pending' | 'ready' | 'failed';
export interface SectionNode extends Omit<TocItem, 'children'> { parentSectionId: string | null; children: SectionNode[]; }
/** Non-overlapping traversal of the body, unlike the overlapping section tree. */
export interface SectionRange { sourceStart: number; sourceEnd: number; sectionId: string | null; headingPath: string[]; }
export interface DocumentStructure { toc: TocItem[]; sections: SectionNode[]; ranges: SectionRange[]; offsetUnit: 'utf16'; version: string; }
export interface StructureOptions {
  format?: 'markdown' | 'text'; maxHeadingDepth?: number;
  /** Existing parser evidence such as OCR prose; never a second heading tree. */
  ignoreHeadingRanges?: Array<{ sourceStart: number; sourceEnd: number }>;
}
export interface TokenCounter { readonly id: string; readonly model: string; readonly maxInputTokens: number; count(text: string): number | Promise<number>; }
export interface SplitOptions {
  targetTokens: number;
  maxEmbeddingTokens: number;
  overlapTokens: number;
  /** Prefer a nearby paragraph or sentence boundary before using the hard cap. */
  targetSourceChars?: number;
  /** Hard cap on the exact source text, in Unicode code points including overlap. */
  maxSourceChars?: number;
  respectSections: boolean;
  tokenizer: TokenCounter;
}
export interface SplitTextInput { content: string; format: 'markdown' | 'text'; options: SplitOptions; structureHints?: DocumentStructure; }
export interface ChunkDraft {
  ordinal: number; content: string; embedding_text: string;
  source_start: number; source_end: number; heading_path: string[];
  /** Core source range before adding the previous chunk's overlap. */
  core_start: number; core_end: number;
  char_count: number; embedding_char_count: number;
  token_count: number; embedding_token_count: number;
  content_hash: string; embedding_text_hash: string;
  metadata: { splitterVersion: string; tokenizerId: string; structureHintsUsed: boolean; sectionId: string | null; assetRefs: string[]; prefixReduced: boolean };
}

export class DocumentProcessingError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'DocumentProcessingError'; }
}
