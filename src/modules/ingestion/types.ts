import type { TocStatus } from '../../lib/document-processing/types.js';

export type IngestionSourceType = 'article' | 'file' | 'note';
export type NoteIndexJobStatus = 'processing' | 'ready' | 'failed';
export interface NoteIndexJob {
  idempotencyKey: string;
  workspaceId: string;
  documentId: string;
  documentVersion: string;
  contentHash: string;
  pipelineVersion: string;
  parserVersion: string;
  chunkerVersion: string;
  sourceType: IngestionSourceType;
  status: NoteIndexJobStatus;
  chunkCount: number;
  jobId: string | null;
  tocStatus: TocStatus;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}
