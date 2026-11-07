import { DomainError } from '../../lib/domain-error.js';
import { TEXT_INGESTION_MAX_CHARS, TEXT_INGESTION_MAX_URI_LENGTH, TextIngestionSourceType, type CreateTextIngestionInput, type UpdateTextIngestionInput } from './types.js';

const sources = new Set<string>(Object.values(TextIngestionSourceType));
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function allowedFields(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).some(key => !fields.includes(key))) throw new DomainError(400, 'TEXT_INGESTION_INPUT_INVALID');
}
export function assertTextEncoding(content: string): void {
  if (content.includes('\u0000') || /[\uD800-\uDFFF]/u.test(content)) throw new DomainError(400, 'TEXT_INGESTION_CONTENT_INVALID');
}

export function assertTextIngestionContent(content: unknown, maxChars = TEXT_INGESTION_MAX_CHARS): asserts content is string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('TEXT_INGESTION_LIMIT_INVALID');
  if (typeof content !== 'string' || !content.trim()) throw new DomainError(400, 'TEXT_INGESTION_CONTENT_EMPTY');
  assertTextEncoding(content);
  if (Array.from(content).length > maxChars) throw new DomainError(413, 'TEXT_INGESTION_CONTENT_TOO_LARGE');
}

/** Syntax only. Download adapters must additionally enforce their SSRF/host policy. */
export function assertTextIngestionOrigin(uri: unknown): asserts uri is string {
  if (typeof uri !== 'string' || !uri || uri.length > TEXT_INGESTION_MAX_URI_LENGTH || /\s/u.test(uri)) throw new DomainError(400, 'TEXT_INGESTION_ORIGIN_INVALID');
  try {
    const parsed = new URL(uri);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) throw new Error('invalid');
  } catch { throw new DomainError(400, 'TEXT_INGESTION_ORIGIN_INVALID'); }
}

export function assertCreateTextIngestionInput(input: unknown, maxChars = TEXT_INGESTION_MAX_CHARS): asserts input is CreateTextIngestionInput {
  if (!record(input) || typeof input.source_type !== 'string' || !sources.has(input.source_type)) throw new DomainError(400, 'TEXT_INGESTION_SOURCE_INVALID');
  if (input.source_type === TextIngestionSourceType.MANUAL_INPUT) {
    allowedFields(input, ['source_type', 'raw_content', 'origin_resource_uri']);
    if (input.origin_resource_uri !== undefined && input.origin_resource_uri !== null) throw new DomainError(400, 'TEXT_INGESTION_ORIGIN_INVALID');
    assertTextIngestionContent(input.raw_content, maxChars);
  } else {
    allowedFields(input, ['source_type', 'origin_resource_uri']);
    assertTextIngestionOrigin(input.origin_resource_uri);
  }
}

export function assertManualTextEditable(sourceType: TextIngestionSourceType): void {
  if (sourceType !== TextIngestionSourceType.MANUAL_INPUT) throw new DomainError(409, 'TEXT_INGESTION_SOURCE_READ_ONLY');
}

export function assertUpdateTextIngestionInput(input: unknown, maxChars = TEXT_INGESTION_MAX_CHARS): asserts input is UpdateTextIngestionInput {
  if (!record(input)) throw new DomainError(400, 'TEXT_INGESTION_INPUT_INVALID');
  allowedFields(input, ['raw_content']);
  assertTextIngestionContent(input.raw_content, maxChars);
}
