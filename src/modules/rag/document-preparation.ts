import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { fileTypeFromBuffer } from 'file-type';
import type { AppConfig } from '../../config/config.js';
import type { StoragePort } from '../storage/port.js';
import { parseDocument } from '../ingestion/document-parser.js';
import { MineruParserAdapter, MockMineruParser, type MineruParser } from './adapters/mineru.js';
import { stableUuid } from './chunkers.js';
import { buildMineruContentBindingsFromAssets, type MineruBindingDiagnostics } from './mineru-bindings.js';
import type { ParsedDocument } from './types.js';

export class DocumentPreparationError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); this.name = 'DocumentPreparationError'; }
}
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const normalizedMime = (value: string | null) => value?.split(';', 1)[0]?.trim().toLowerCase() || null;

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
  for (const prefix of ['X-Amz', 'X-Tos']) {
    const seconds = url.searchParams.get(`${prefix}-Expires`);
    if (seconds !== null) {
      const start = signedDate(url.searchParams.get(`${prefix}-Date`) ?? '');
      if (!Number.isFinite(start) || !/^\d+$/u.test(seconds) || !Number.isSafeInteger(Number(seconds)) || Number(seconds) <= 0 || start + Number(seconds) * 1000 <= Date.now()) throw new DocumentPreparationError('RAG_SOURCE_URL_EXPIRED');
    }
  }
}
/** URL policy is also enforced at every redirect, before another request leaves. */
export function validateSourceUri(value: string, config: { appEnv: string; rag: Pick<AppConfig['rag'], 'sourceAllowedHosts'> }): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new DocumentPreparationError('RAG_SOURCE_URL_INVALID'); }
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || (config.appEnv === 'production' && url.protocol !== 'https:')) throw new DocumentPreparationError('RAG_SOURCE_URL_INVALID');
  if (!config.rag.sourceAllowedHosts.some(allowed => host === allowed.toLowerCase() || host.endsWith(`.${allowed.toLowerCase()}`))) throw new DocumentPreparationError('RAG_SOURCE_HOST_NOT_ALLOWED');
  if (config.appEnv === 'production' && (isIP(host.replace(/^\[|\]$/gu, '')) || host === 'localhost' || host.endsWith('.local'))) throw new DocumentPreparationError('RAG_SOURCE_HOST_NOT_ALLOWED');
  assertNotExpired(url);
  return url;
}
async function boundedResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) { await response.body?.cancel(); throw new DocumentPreparationError('RAG_SOURCE_TOO_LARGE'); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let total = 0;
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DocumentPreparationError('RAG_SOURCE_TIMEOUT', true));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    while (true) {
      const item = await Promise.race([reader.read(), aborted]);
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBytes) throw new DocumentPreparationError('RAG_SOURCE_TOO_LARGE');
      parts.push(item.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return bytes;
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export interface DownloadedSource { bytes: Uint8Array; contentType: string | null; fileName: string; finalUrl: string; }
export async function downloadSourceBytes(uri: string, config: Pick<AppConfig, 'appEnv' | 'rag'>, fetchImpl: typeof fetch = fetch): Promise<DownloadedSource> {
  const signal = AbortSignal.timeout(config.rag.downloadTimeoutMs);
  let next = uri;
  try {
    for (let hop = 0; hop < 4; hop += 1) {
      const url = validateSourceUri(next, config);
      const response = await fetchImpl(url.toString(), { redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new DocumentPreparationError('RAG_SOURCE_REDIRECT_INVALID');
        next = new URL(location, url).toString();
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new DocumentPreparationError('RAG_SOURCE_UNAVAILABLE', response.status >= 500 || response.status === 429); }
      let fileName: string;
      try { fileName = decodeURIComponent(url.pathname.split('/').pop() || 'document'); } catch { throw new DocumentPreparationError('RAG_FILE_NAME_INVALID'); }
      if (fileName.length > 255 || /[\0\\/]/u.test(fileName)) throw new DocumentPreparationError('RAG_FILE_NAME_INVALID');
      return { bytes: await boundedResponse(response, config.rag.maxSourceBytes, signal), contentType: normalizedMime(response.headers.get('content-type')), fileName, finalUrl: url.toString() };
    }
    throw new DocumentPreparationError('RAG_SOURCE_REDIRECT_INVALID');
  } catch (error) {
    if (error instanceof DocumentPreparationError) throw error;
    throw new DocumentPreparationError(signal.aborted ? 'RAG_SOURCE_TIMEOUT' : 'RAG_SOURCE_UNAVAILABLE', true);
  }
}

export interface PreparedAsset {
  id: string; sourceAssetKey: string; assetRef: string; sourcePath: string; objectKey: string;
  sha256: string; mimeType: string; byteSize: number; assetType: string; pageNo: number | null;
  sourceBlockId: string | null; charStart: number | null; charEnd: number | null;
  caption: string | null; altText: string | null; ocrText: string | null; captionText: string | null;
  uploadStatus: 'ready' | 'failed'; enrichmentStatus: 'none' | 'bound' | 'unresolved' | 'failed';
  enrichmentProvider: string | null; enrichmentSource: string | null; enrichmentHash: string | null;
  metadata: Record<string, unknown>;
}
export interface PreparedContent { canonical: string; assets: PreparedAsset[]; diagnostics?: MineruBindingDiagnostics; }
async function putStable(storage: StoragePort, key: string, input: Readable, mimeType: string, maxBytes: number) {
  try { const result = await storage.stat(key, mimeType); input.destroy(); return result; }
  catch { return storage.put(key, input, mimeType, maxBytes); }
}
function assetExtension(path: string, mimeType: string): string {
  const extension = path.toLowerCase().match(/\.[a-z0-9]+$/u)?.[0];
  return extension && extension.length <= 8 ? extension : ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg' } as Record<string, string>)[mimeType] ?? '.bin';
}
/** Uses the existing binding algorithm. The caller owns database persistence. */
export async function prepareParsedContent(parsed: ParsedDocument, options: { storage: StoragePort; prefix: string; identity: string; rawMarkdown?: string }): Promise<PreparedContent> {
  const rawMarkdown = options.rawMarkdown ?? parsed.artifacts.canonicalMarkdown ?? parsed.markdown ?? parsed.rawMarkdown ?? '';
  const bindings = buildMineruContentBindingsFromAssets({ rawMarkdown, contentListV2: parsed.artifacts.contentListV2, model: parsed.artifacts.model, assets: (parsed.artifacts.assets ?? []).map(asset => ({ sourcePath: asset.path, bytes: asset.bytes, mimeType: asset.mimeType, assetType: asset.assetType, sha256: asset.sha256 })) });
  const rows: PreparedAsset[] = [];
  for (const asset of bindings.assets) {
    const objectKey = `${options.prefix}/${asset.sha256}${assetExtension(asset.sourcePath, asset.mimeType)}`;
    const input = asset.bytes ? Readable.from([asset.bytes]) : asset.filePath ? createReadStream(asset.filePath) : undefined;
    if (!input) throw new DocumentPreparationError('RAG_ASSET_CONTENT_MISSING');
    try { await putStable(options.storage, objectKey, input, asset.mimeType, Math.max(asset.byteSize, 1)); }
    catch { input.destroy(); throw new DocumentPreparationError('RAG_ASSET_UPLOAD_FAILED', true); }
    rows.push({ id: stableUuid(`asset:${options.identity}:${asset.sourceAssetKey}`), sourceAssetKey: asset.sourceAssetKey, assetRef: asset.assetRef, sourcePath: asset.sourcePath, objectKey, sha256: asset.sha256, mimeType: asset.mimeType, byteSize: asset.byteSize, assetType: asset.assetType, pageNo: asset.pageNo ?? null, sourceBlockId: asset.sourceBlockId ?? null, charStart: null, charEnd: null, caption: asset.captionText ?? null, altText: asset.captionText ?? null, ocrText: asset.ocrText ?? null, captionText: asset.captionText ?? null, uploadStatus: 'ready', enrichmentStatus: asset.enrichmentStatus, enrichmentProvider: asset.enrichmentProvider ?? null, enrichmentSource: asset.enrichmentSource ?? null, enrichmentHash: asset.enrichmentHash ?? null, metadata: { sourceAssetKey: asset.sourceAssetKey, assetRef: asset.assetRef, sourcePath: asset.sourcePath, sourceType: asset.sourceType ?? null, bbox: asset.bbox ?? null } });
  }
  return { canonical: bindings.canonicalMarkdown, assets: rows, diagnostics: bindings.diagnostics };
}

const structured = new Set(['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const textMimes = new Set(['text/plain', 'text/markdown', 'text/x-markdown', 'text/csv']);
const extensionMimes: Record<string, string> = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
async function verifiedType(source: DownloadedSource): Promise<{ mimeType: string; plain: boolean }> {
  let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
  try { detected = await fileTypeFromBuffer(source.bytes); } catch { detected = undefined; }
  const declared = source.contentType, extension = source.fileName.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1] ?? '';
  if (detected) {
    // Legacy Office files share the CFB container and need a declared Office type.
    const cfb = detected.ext === 'cfb' || detected.mime === 'application/x-cfb';
    const legacy = ['doc', 'ppt', 'xls'].includes(extension) ? extensionMimes[extension] : ['application/msword', 'application/vnd.ms-powerpoint', 'application/vnd.ms-excel'].includes(declared ?? '') ? declared! : undefined;
    const actual = cfb && legacy ? legacy : detected.mime;
    if (!structured.has(actual)) throw new DocumentPreparationError('RAG_FILE_TYPE_UNSUPPORTED');
    if (declared && declared !== 'application/octet-stream' && declared !== actual) throw new DocumentPreparationError('RAG_FILE_TYPE_MISMATCH');
    if (extensionMimes[extension] && extensionMimes[extension] !== actual) throw new DocumentPreparationError('RAG_FILE_TYPE_MISMATCH');
    return { mimeType: actual, plain: false };
  }
  if (declared && structured.has(declared)) throw new DocumentPreparationError('RAG_FILE_TYPE_MISMATCH');
  if (extensionMimes[extension]) throw new DocumentPreparationError('RAG_FILE_TYPE_MISMATCH');
  if ((declared && !textMimes.has(declared) && declared !== 'application/octet-stream') || (!textMimes.has(declared ?? '') && !['txt', 'md', 'markdown', 'csv'].includes(extension))) throw new DocumentPreparationError('RAG_FILE_TYPE_UNSUPPORTED');
  if (source.bytes.includes(0)) throw new DocumentPreparationError('RAG_FILE_TYPE_MISMATCH');
  return { mimeType: ['md', 'markdown'].includes(extension) || declared === 'text/markdown' || declared === 'text/x-markdown' ? 'text/markdown' : declared === 'text/csv' ? 'text/csv' : 'text/plain', plain: true };
}
export interface PreparedFileText { content: string; format: 'markdown' | 'text'; artifactUri?: string; }
export async function prepareFileText(config: AppConfig, storage: StoragePort, input: { id: string; uri: string }, dependencies: { fetchImpl?: typeof fetch; parser?: MineruParser } = {}): Promise<PreparedFileText> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(input.id)) throw new DocumentPreparationError('TEXT_INGESTION_ID_INVALID');
  if (config.rag.providerMode === 'disabled' || (config.rag.providerMode === 'mock' && config.appEnv === 'production')) throw new DocumentPreparationError('TEXT_SOURCE_ADAPTER_UNAVAILABLE');
  const source = await downloadSourceBytes(input.uri, config, dependencies.fetchImpl);
  const type = await verifiedType(source);
  if (type.plain) {
    const result = await parseDocument({ content: source.bytes, fileName: source.fileName, mimeType: type.mimeType });
    if ([...result.content].length > config.rag.plainTextMaxChars) throw new DocumentPreparationError('RAG_PLAIN_TEXT_TOO_LARGE');
    return { content: result.content, format: result.format };
  }
  if (!dependencies.parser && config.rag.providerMode === 'live' && !config.rag.mineruToken) throw new DocumentPreparationError('RAG_MINERU_CONFIG_MISSING');
  const parser = dependencies.parser ?? (config.rag.providerMode === 'mock' ? new MockMineruParser() : new MineruParserAdapter({ baseUrl: config.rag.mineruBaseUrl, token: config.rag.mineruToken!, model: config.rag.mineruModel, pollIntervalMs: config.rag.mineruPollIntervalMs, timeoutMs: config.rag.mineruTimeoutMs }));
  const parsed = await parser.parse({ ossUrl: source.finalUrl, fileName: source.fileName, mimeType: type.mimeType, sourceBytes: source.bytes });
  const prepared = await prepareParsedContent(parsed, { storage, prefix: `text-ingestions/${input.id}/assets`, identity: input.id });
  if (!prepared.canonical.trim()) throw new DocumentPreparationError('RAG_SOURCE_EMPTY');
  const raw = parsed.rawMarkdown ?? parsed.markdown ?? '';
  const rawUri = `text-ingestions/${input.id}/raw/${digest(raw)}.md`;
  await putStable(storage, rawUri, Readable.from([raw]), 'text/markdown', Math.max(Buffer.byteLength(raw), 1));
  const manifest = JSON.stringify({ assets: prepared.assets, diagnostics: prepared.diagnostics, rawMarkdownUri: rawUri, parserProvider: parsed.parserProvider, parserVersion: parsed.parserVersion, parserMeta: parsed.parserMeta });
  const artifactUri = `text-ingestions/${input.id}/artifacts/manifest-${digest(manifest)}.json`;
  await putStable(storage, artifactUri, Readable.from([manifest]), 'application/json', Buffer.byteLength(manifest));
  return { content: prepared.canonical, format: 'markdown', artifactUri };
}
