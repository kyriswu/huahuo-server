import { analyzeDocumentStructure } from '../lib/document-processing/structure.js';
import { splitKnowledgeContent } from '../modules/kb/split.js';
import type { DocumentStructure, TokenCounter } from '../lib/document-processing/types.js';
import { indexChunks, type IndexDependencies, type IndexRecord, type IndexResult, type VectorTarget } from '../lib/rag-indexing/index.js';

export interface TypedTool<Input, Output> {
  readonly name: string;
  execute(input: Input): Promise<Output>;
}

export class DocumentToolError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'DocumentToolError'; }
}

export interface StructureToolInput {
  content: string;
  format?: 'markdown' | 'text';
  maxHeadingDepth?: number;
}

export interface SplitToolInput {
  content: string;
  format: 'markdown' | 'text';
  mode: 'note-hybrid'|'document-keyword';
  structureHints?: DocumentStructure;
}

export interface IndexToolInput { targetId: string; records: readonly IndexRecord[]; }

export interface DocumentToolDependencies {
  tokenizer?: TokenCounter;
  /** Bindings are registered by application code, never by a Tool caller. */
  indexTargets: ReadonlyMap<string, IndexDependencies>;
}

function object(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new DocumentToolError('TOOL_INPUT_INVALID');
}

function content(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new DocumentToolError('TOOL_INPUT_INVALID');
}

function sameTarget(left: VectorTarget, right: VectorTarget): boolean {
  return left.connectionId === right.connectionId && left.database === right.database && left.collection === right.collection && left.partition === right.partition;
}

/** The wrappers expose only data and allowed knobs. All algorithms and vector
 * operations delegate to the same standalone libraries used by business code. */
export function createDocumentProcessingTools(dependencies: DocumentToolDependencies): {
  analyzeStructure: TypedTool<StructureToolInput, Awaited<ReturnType<typeof analyzeDocumentStructure>>>;
  splitChunks: TypedTool<SplitToolInput, Awaited<ReturnType<typeof splitKnowledgeContent>>>;
  indexChunks: TypedTool<IndexToolInput, IndexResult>;
} {
  const targets = new Map([...dependencies.indexTargets].map(([id, binding]) => [id, { binding, target: Object.freeze({ ...binding.vectorStoreAdapter.target }) }]));
  return {
    analyzeStructure: {
      name: 'huahuo_analyze_document_structure',
      async execute(input) {
        object(input, ['content', 'format', 'maxHeadingDepth']); content(input.content);
        if (input.format !== undefined && !['markdown', 'text'].includes(input.format)) throw new DocumentToolError('TOOL_INPUT_INVALID');
        if (input.maxHeadingDepth !== undefined && (!Number.isInteger(input.maxHeadingDepth) || input.maxHeadingDepth < 1 || input.maxHeadingDepth > 6)) throw new DocumentToolError('TOOL_INPUT_INVALID');
        return analyzeDocumentStructure(input.content, { format: input.format, maxHeadingDepth: input.maxHeadingDepth });
      },
    },
    splitChunks: {
      name: 'huahuo_split_text_chunks',
      async execute(input) {
        object(input, ['content', 'format', 'mode', 'structureHints']); content(input.content);
        if (!['markdown', 'text'].includes(input.format)) throw new DocumentToolError('TOOL_INPUT_INVALID');
        if(!['note-hybrid','document-keyword'].includes(input.mode))throw new DocumentToolError('TOOL_INPUT_INVALID');
        return splitKnowledgeContent(input.content,input.mode,{format:input.format,structure:input.structureHints,tokenizer:dependencies.tokenizer});
      },
    },
    indexChunks: {
      name: 'huahuo_index_chunks',
      async execute(input) {
        object(input, ['targetId', 'records']);
        if (typeof input.targetId !== 'string' || !Array.isArray(input.records)) throw new DocumentToolError('TOOL_INPUT_INVALID');
        const registered = targets.get(input.targetId);
        if (!registered || !sameTarget(registered.target, registered.binding.vectorStoreAdapter.target)) throw new DocumentToolError('TOOL_TARGET_UNAVAILABLE');
        return indexChunks(input.records, registered.binding);
      },
    },
  };
}
