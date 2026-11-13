/** Acquisition method, distinct from the RAG business source (`note` / `file`). */
export const TEXT_INGESTION_MAX_CHARS = 50_000;
export const TEXT_INGESTION_MAX_URI_LENGTH = 4096;

export enum TextIngestionSourceType {
  MANUAL_INPUT = 'MANUAL_INPUT',
  WEB_CRAWL = 'WEB_CRAWL',
  IMAGE_OCR = 'IMAGE_OCR',
  MEDIA_ASR = 'MEDIA_ASR',
  BOOK_OCR = 'BOOK_OCR',
  FILE_UPLOAD = 'FILE_UPLOAD',
}

export type TextIngestionStatus = 'pending' | 'parsing' | 'chunking' | 'success' | 'failed';

export interface TextIngestionJob {
  id: string;
  source_type: TextIngestionSourceType;
  /** Null until an external source has produced text. Otherwise exact source text. */
  raw_content: string | null;
  origin_resource_uri: string | null;
  ingest_status: TextIngestionStatus;
  error_msg: string | null;
  /** Unix milliseconds, never seconds or database-local time. */
  created_at: number;
  updated_at: number;
  /** Set by the Server from verified JWT.sub, never by a request body. */
  created_by: string;
}

export type ExternalTextIngestionSourceType = Exclude<TextIngestionSourceType, TextIngestionSourceType.MANUAL_INPUT>;
export type CreateTextIngestionInput =
  | { source_type: TextIngestionSourceType.MANUAL_INPUT; raw_content: string; origin_resource_uri?: null }
  | { source_type: ExternalTextIngestionSourceType; origin_resource_uri: string; raw_content?: never };

/** Only editable source text; identity, source and execution state are Server-owned. */
export interface UpdateTextIngestionInput { raw_content: string; }
