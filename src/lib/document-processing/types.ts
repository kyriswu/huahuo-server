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
export class DocumentProcessingError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'DocumentProcessingError'; }
}
