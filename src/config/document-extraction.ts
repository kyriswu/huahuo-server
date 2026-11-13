import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonical, digest } from '../lib/crypto.js';

export type ExtractionParameters = Record<string, unknown>;
export interface EnabledDocumentExtractionConfig {
  enabled: true; mode: 'sync' | 'async'; parameters: ExtractionParameters;
  configHash: string; timeoutMs: number; pollMs: number; maxResponseBytes: number;
}
export type DocumentExtractionConfig = { enabled: false } | EnabledDocumentExtractionConfig;
// A supplied override replaces the whole configuration, never a shallow/deep merge.
export function assertCompleteExtractionConfig(value: unknown): asserts value is ExtractionParameters {
  const required: Record<string, unknown> = {
    output_format: '', use_cache: false, force_ocr: false,
    ocr: { backend: '', language: [''], paddle_ocr_settings: { model_version: '', model_tier: '', rec_batch_num: 1 } },
    acceleration: { provider: '', device_id: 0 }, extraction_timeout_secs: 1,
    images: { extract_images: true, target_dpi: 1, auto_adjust_dpi: false, max_image_dimension: 1, max_images_per_page: 1,
      inject_placeholders: true, include_page_rasters: false, run_ocr_on_images: true, include_data_base64: false, output_format: { type: '', quality: 1 } },
    ocr_embedded_images: true, use_layout_for_markdown: false, pages: { extract_pages: true },
    native_first: { ocr_fallback: true, min_native_body_chars: 1, min_image_dimension: 1 },
  };
  const fail = (): never => { throw new Error('INVALID_CONFIG:DOCUMENT_EXTRACTION_CONFIG'); };
  function check(actual: unknown, shape: unknown): void {
    if (Array.isArray(shape)) { if (!Array.isArray(actual) || actual.length === 0 || actual.some(v => typeof v !== 'string' || !v)) fail(); return; }
    if (typeof shape === 'object' && shape !== null) {
      if (!actual || typeof actual !== 'object' || Array.isArray(actual)) fail();
      for (const [key, child] of Object.entries(shape)) check((actual as Record<string, unknown>)[key], child);
      return;
    }
    if (typeof actual !== typeof shape || (typeof actual === 'number' && (!Number.isFinite(actual) || actual < 0))) fail();
  }
  check(value, required);
  const config = value as ExtractionParameters, images = config.images as Record<string, unknown>;
  if (config.output_format !== 'markdown' || images.include_data_base64 !== false
    || typeof config.extraction_timeout_secs !== 'number' || config.extraction_timeout_secs < 1 || config.extraction_timeout_secs > 86400) fail();
}
export function loadDocumentExtractionConfig(env: Readonly<Record<string, string | undefined>> = process.env): DocumentExtractionConfig {
  const mode = env.DOCUMENT_EXTRACTION_MODE ?? 'disabled';
  if (!['disabled', 'sync', 'async'].includes(mode)) throw new Error('INVALID_CONFIG:DOCUMENT_EXTRACTION_MODE');
  if (mode === 'disabled') return { enabled: false };
  let parameters: unknown;
  try { parameters = JSON.parse(readFileSync(resolve(env.DOCUMENT_EXTRACTION_CONFIG_PATH || 'resources/document-extraction/kbxml-request.json'), 'utf8')); }
  catch { throw new Error('INVALID_CONFIG:DOCUMENT_EXTRACTION_CONFIG_PATH'); }
  assertCompleteExtractionConfig(parameters);
  const number = (key: string, fallback: number, min: number, max: number) => {
    const n = Number(env[key]?.trim() || fallback);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`INVALID_CONFIG:${key}`);
    return n;
  };
  const minimum = (parameters.extraction_timeout_secs as number) * 1000 + 60_000;
  return {
    enabled: true, mode: mode as 'sync' | 'async', parameters, configHash: digest(canonical(parameters)),
    timeoutMs: number('DOCUMENT_EXTRACTION_TIMEOUT_MS', minimum + 60_000, minimum, 86_520_000),
    pollMs: number('DOCUMENT_EXTRACTION_POLL_MS', 2000, 100, 60_000),
    maxResponseBytes: number('DOCUMENT_EXTRACTION_MAX_RESPONSE_BYTES', 64 * 1024 * 1024, 1024, 64 * 1024 * 1024),
  };
}
