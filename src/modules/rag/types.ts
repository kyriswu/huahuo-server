import type { RagConfig } from '../../config/config.js';

export type RagMode = 'structured_document' | 'plain_text';
export type RagStage = 'RECEIVED'|'DOWNLOADING'|'PARSE_SUBMITTED'|'PARSING'|'PARSED'|'SEGMENTING'|'CHUNKED'|'EMBEDDING'|'INDEXING'|'SUCCEEDED'|'FAILED';

export interface DocumentBlock {
  id: string;
  type: 'heading'|'paragraph'|'list'|'table'|'formula'|'image'|'code'|'other';
  text: string;
  headingLevel?: number;
  sectionPath: string[];
  pageStart?: number;
  pageEnd?: number;
  charStart?: number;
  charEnd?: number;
  sourceOrder: number;
  metadata?: Record<string, unknown>;
}

export interface ParsedDocument {
  source: { fileName: string; mimeType: string; sha256: string };
  blocks: DocumentBlock[];
  markdown?: string;
  rawMarkdown?: string;
  artifacts: { zipUri?: string; markdownUri?: string; jsonUri?: string; zipBytes?: Uint8Array; jsonText?: string; canonicalMarkdown?: string; imageFailures?: string[]; contentListV2?: unknown; model?: unknown; assets?: ParsedAsset[] };
  parserProvider: string;
  parserVersion: string;
  parserMeta?: { taskId?: string; batchId?: string; dataId?: string; traceId?: string; model?: string; imageFailures?: string[] };
}

export interface ParsedAsset {
  path: string;
  sourceAssetKey?: string;
  assetRef?: string;
  bytes: Uint8Array;
  mimeType: string;
  assetType: 'image'|'chart'|'table_image'|'formula'|'other';
  sha256: string;
  pageNo?: number;
  sourceBlockId?: string;
  caption?: string;
  ocrText?: string;
  captionText?: string;
  enrichmentStatus?: 'bound'|'unresolved'|'none';
  enrichmentProvider?: string;
  enrichmentSource?: string;
  enrichmentHash?: string;
}

export interface ChildChunk {
  /** The complete source record, never a section or another chunk. */
  parentId: string;
  sourceType?: string;
  sourceRevision?: string;
  id: string;
  documentKey?: string;
  chunkKey?: string;
  chunkProfile?: string;
  chunkCount?: number;
  ordinal: number;
  content: string;
  embeddingText: string;
  contentHash: string;
  embeddingTextHash: string;
  headingPath: string[];
  tokenCount: number;
  charStart?: number;
  charEnd?: number;
  metadata: Record<string, unknown>;
}

export interface RagRuntime {
  config: RagConfig;
}
