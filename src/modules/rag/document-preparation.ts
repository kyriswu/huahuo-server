import { isIP } from 'node:net';
import type { AppConfig } from '../../config/config.js';

export class DocumentPreparationError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); this.name = 'DocumentPreparationError'; }
}
function signedDate(value: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(value);
  return match ? Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`) : NaN;
}
function assertNotExpired(url: URL): void {
  const absolute = url.searchParams.get('Expires') ?? url.searchParams.get('expires') ?? url.searchParams.get('expires_at');
  if (absolute) {
    const numeric = Number(absolute);
    const expiry = Number.isFinite(numeric) ? numeric * (numeric < 10_000_000_000 ? 1000 : 1) : Date.parse(absolute);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new DocumentPreparationError('RAG_SOURCE_URL_EXPIRED');
  }
  for (const [dateKey, expiresKey] of [['X-Amz-Date', 'X-Amz-Expires'], ['X-Tos-Date', 'X-Tos-Expires'], ['x-oss-date', 'x-oss-expires']] as const) {
    const seconds = url.searchParams.get(expiresKey), date = url.searchParams.get(dateKey);
    const ossV4 = expiresKey === 'x-oss-expires' && url.searchParams.get('x-oss-signature-version') === 'OSS4-HMAC-SHA256';
    if (seconds !== null || date !== null || ossV4) {
      const start = signedDate(date ?? '');
      if (!Number.isFinite(start) || seconds === null || !/^\d+$/u.test(seconds) || !Number.isSafeInteger(Number(seconds)) || Number(seconds) <= 0 || start + Number(seconds) * 1000 <= Date.now()) throw new DocumentPreparationError('RAG_SOURCE_URL_EXPIRED');
    }
  }
}
/** Validate the source before dispatch. The parser owns downloading and redirect policy. */
export function validateSourceUri(value: string, config: { appEnv: string; rag: Pick<AppConfig['rag'], 'sourceAllowedHosts'> }): URL {
  if (typeof value !== 'string' || value.length > 4096 || /\s/u.test(value)) throw new DocumentPreparationError('RAG_SOURCE_URL_INVALID');
  let url: URL;
  try { url = new URL(value); } catch { throw new DocumentPreparationError('RAG_SOURCE_URL_INVALID'); }
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || (config.appEnv === 'production' && url.protocol !== 'https:')) throw new DocumentPreparationError('RAG_SOURCE_URL_INVALID');
  if (!config.rag.sourceAllowedHosts.some(allowed => host === allowed.toLowerCase() || host.endsWith(`.${allowed.toLowerCase()}`))) throw new DocumentPreparationError('RAG_SOURCE_HOST_NOT_ALLOWED');
  if (config.appEnv === 'production' && (isIP(host.replace(/^\[|\]$/gu, '')) || host === 'localhost' || host.endsWith('.local'))) throw new DocumentPreparationError('RAG_SOURCE_HOST_NOT_ALLOWED');
  assertNotExpired(url);
  return url;
}
export interface DocumentSource { url: string; fileName: string; mimeType: string; }
const mimes: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv',
};
/** Metadata for an accepted source; dispatch policy belongs to the managed extractor. No network access. */
export function sourceMetadataFromUrl(value: string): DocumentSource {
  let url: URL;
  try { url = new URL(value); } catch { throw new DocumentPreparationError('RAG_SOURCE_URL_INVALID'); }
  let fileName: string;
  try { fileName = decodeURIComponent(url.pathname.split('/').pop() || 'document'); }
  catch { throw new DocumentPreparationError('RAG_FILE_NAME_INVALID'); }
  if (fileName.length > 255 || /[\0\r\n\\/]/.test(fileName)) throw new DocumentPreparationError('RAG_FILE_NAME_INVALID');
  const extension = fileName.split('.').at(-1)!.toLowerCase();
  return { url: url.toString(), fileName, mimeType: mimes[extension] ?? 'application/octet-stream' };
}
/** Validate a new URL before accepting it. File fetching and format detection remain external. */
export function sourceFromUrl(value: string, config: Pick<AppConfig, 'appEnv' | 'rag'>): DocumentSource {
  return sourceMetadataFromUrl(validateSourceUri(value, config).toString());
}
