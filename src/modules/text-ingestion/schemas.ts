import { Type } from '@sinclair/typebox';
import { Id, Strict } from '../identity/schemas.js';
import { TEXT_INGESTION_MAX_CHARS, TEXT_INGESTION_MAX_URI_LENGTH, TextIngestionSourceType } from './types.js';

const rawContent = Type.String({ minLength: 1, maxLength: TEXT_INGESTION_MAX_CHARS, pattern: '\\S' });
const originUri = Type.String({ minLength: 1, maxLength: TEXT_INGESTION_MAX_URI_LENGTH, pattern: '^https?://\\S+$' });
const nullableString = Type.Union([Type.String(), Type.Null()]);

export const TextIngestionSourceTypeSchema = Type.Enum(TextIngestionSourceType);
export const TextIngestionStatusSchema = Type.Union([
  Type.Literal('pending'), Type.Literal('parsing'), Type.Literal('chunking'),
  Type.Literal('embedding'), Type.Literal('success'), Type.Literal('failed'),
]);
export const TextIngestionJobSchema = Type.Object({
  id: Id,
  source_type: TextIngestionSourceTypeSchema,
  raw_content: nullableString,
  origin_resource_uri: nullableString,
  ingest_status: TextIngestionStatusSchema,
  error_msg: nullableString,
  created_at: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  updated_at: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  created_by: Id,
}, Strict);

const externalSource = Type.Union([
  Type.Literal(TextIngestionSourceType.WEB_CRAWL), Type.Literal(TextIngestionSourceType.IMAGE_OCR),
  Type.Literal(TextIngestionSourceType.MEDIA_ASR), Type.Literal(TextIngestionSourceType.BOOK_OCR),
  Type.Literal(TextIngestionSourceType.FILE_UPLOAD),
]);
export const CreateTextIngestionSchema = Type.Union([
  Type.Object({
    source_type: Type.Literal(TextIngestionSourceType.MANUAL_INPUT),
    raw_content: rawContent,
    origin_resource_uri: Type.Optional(Type.Null()),
  }, Strict),
  Type.Object({ source_type: externalSource, origin_resource_uri: originUri }, Strict),
]);
export const UpdateTextIngestionSchema = Type.Object({ raw_content: rawContent }, Strict);
