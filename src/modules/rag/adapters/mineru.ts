/* eslint-disable @typescript-eslint/no-explicit-any */
import { unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import type { DocumentBlock, ParsedAsset, ParsedDocument } from '../types.js';

export class MineruError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = true, options?: { cause?: unknown }) {
    super(message, options); this.name = 'MineruError';
  }
}
function hash(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex'); }
function text(value: Uint8Array | undefined): string { return value ? new TextDecoder('utf-8', { fatal: false }).decode(value) : ''; }
function normalizeMime(mime: string): string { return mime.split(';', 1)[0]!.trim().toLowerCase(); }
function assetMime(path: string): string {
  const ext = path.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.avif': 'image/avif' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}
function assetType(path: string): ParsedAsset['assetType'] {
  const lower = path.toLowerCase();
  if (lower.includes('formula') || lower.includes('equation')) return 'formula';
  if (lower.includes('table')) return 'table_image';
  if (lower.includes('chart') || lower.includes('graph')) return 'chart';
  return /^image\//.test(assetMime(path)) ? 'image' : 'other';
}
export function blocksFromMarkdown(markdown: string): DocumentBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const result: DocumentBlock[] = [];
  let path: string[] = [];
  let offset = 0;
  let body: string[] = [];
  let bodyStart = 0;
  const flush = (): void => {
    const value = body.join('\n').trim();
    if (value) result.push({ id: `block-${result.length}`, type: /!\[[^\]]*\]\(/.test(value) ? 'image' : 'paragraph', text: value, sectionPath: [...path], charStart: bodyStart, charEnd: bodyStart + body.join('\n').length, sourceOrder: result.length });
    body = [];
  };
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) { flush(); const level = heading[1]!.length; path = [...path.slice(0, level - 1), heading[2]!.trim()]; result.push({ id: `block-${result.length}`, type: 'heading', text: line, headingLevel: level, sectionPath: [...path], charStart: offset, charEnd: offset + line.length, sourceOrder: result.length }); }
    else if (!line.trim()) flush();
    else { if (!body.length) bodyStart = offset; body.push(line); }
    offset += line.length + 1;
  }
  flush();
  return result;
}
function contentRows(value: unknown): DocumentBlock[] {
  if (!Array.isArray(value)) return [];
  const result: DocumentBlock[] = [];
  let path: string[] = [];
  for (const [index, item] of value.entries()) {
    const row = item as Record<string, unknown>;
    const raw = row.text ?? row.content ?? row.md;
    const content = typeof raw === 'string' ? raw.trim() : '';
    if (!content) continue;
    const rawType = String(row.type ?? 'paragraph').toLowerCase();
    const type: DocumentBlock['type'] = rawType.includes('title') || rawType.includes('header') ? 'heading' : rawType.includes('table') ? 'table' : rawType.includes('image') ? 'image' : rawType.includes('equation') || rawType.includes('formula') ? 'formula' : rawType.includes('code') ? 'code' : rawType.includes('list') ? 'list' : 'paragraph';
    const level = Number(row.level ?? row.heading_level ?? 0);
    if (type === 'heading' && level > 0) path = [...path.slice(0, level - 1), content.replace(/^#+\s*/, '').trim()];
    const page = Number(row.page_idx ?? row.page_no ?? row.page);
    result.push({ id: String(row.id ?? `block-${index}`), type, text: content, headingLevel: level > 0 ? level : undefined, sectionPath: [...path], pageStart: Number.isFinite(page) ? page + 1 : undefined, pageEnd: Number.isFinite(page) ? page + 1 : undefined, sourceOrder: index, metadata: { ...row } });
  }
  return result;
}
function findJson(files: Record<string, Uint8Array>, names: RegExp[]): string | undefined {
  return Object.keys(files).find((name) => names.some((pattern) => pattern.test(name)));
}

function modelOcrRecords(value: unknown): unknown[] {
  const result: unknown[] = [];
  const visit = (item: unknown, pageNo?: number): void => {
    if (Array.isArray(item)) { for (const child of item) visit(child, pageNo); return; }
    if (!item || typeof item !== 'object') return;
    const row = item as Record<string, unknown>;
    const pageInfo = row.page_info && typeof row.page_info === 'object' ? row.page_info as Record<string, unknown> : undefined;
    const currentPage = Number(pageInfo?.page_no ?? row.page_no ?? pageNo);
    const effectivePage = Number.isFinite(currentPage) ? currentPage : pageNo;
    const label = String(row.label ?? '').toLowerCase();
    const ocr = label === 'ocr_text' && typeof row.text === 'string' ? row.text.trim() : undefined;
    if (ocr) {
      result.push({
        ...(effectivePage !== undefined ? { page_no: effectivePage } : {}),
        ...(Array.isArray(row.bbox) ? { bbox: row.bbox.slice(0, 4) } : {}),
        ...(row.path ? { path: row.path } : {}),
        ocr_text: ocr,
      });
    }
    for (const [key, child] of Object.entries(row)) {
      if (key === 'page_info') continue;
      if (Array.isArray(child) || (child && typeof child === 'object')) visit(child, effectivePage);
    }
  };
  visit(value);
  return result;
}

export interface MineruParser { parse(input: { ossUrl: string; fileName: string; mimeType: string; sourceBytes: Uint8Array }): Promise<ParsedDocument>; }

export class MineruParserAdapter implements MineruParser {
  constructor(private readonly options: { baseUrl: string; token: string; model: string; pollIntervalMs: number; timeoutMs: number; fetchImpl?: typeof fetch }) {}
  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await (this.options.fetchImpl ?? fetch)(url, { ...init, headers: { authorization: `Bearer ${this.options.token}`, accept: '*/*', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } });
    if (!response.ok) throw new MineruError('MINERU_PROVIDER_UNAVAILABLE', `MinerU HTTP ${response.status}`, response.status >= 500 || response.status === 429);
    return response;
  }
  async parse(input: { ossUrl: string; fileName: string; mimeType: string; sourceBytes: Uint8Array }): Promise<ParsedDocument> {
    const base = this.options.baseUrl.replace(/\/$/, '');
    const dataId = hash(input.sourceBytes).slice(0, 32);
    const submit = await this.request(`${base}/api/v4/extract/task`, { method: 'POST', body: JSON.stringify({ url: input.ossUrl, model_version: this.options.model, is_ocr: true, enable_formula: true, enable_table: true, data_id: dataId }) });
    const created = await submit.json() as any;
    const taskId = String(created?.data?.task_id ?? '');
    if (!taskId) throw new MineruError('MINERU_RESPONSE_INVALID', 'MinerU submit response missing task id', false);
    const started = Date.now();
    let done: any;
    let traceId = typeof created?.trace_id === 'string' ? created.trace_id : undefined;
    while (Date.now() - started < this.options.timeoutMs) {
      const response = await this.request(`${base}/api/v4/extract/task/${encodeURIComponent(taskId)}`);
      const payload = await response.json() as any;
      traceId = typeof payload?.trace_id === 'string' ? payload.trace_id : traceId;
      const data = payload?.data;
      if (data?.state === 'done') { done = data; break; }
      if (data?.state === 'failed') throw new MineruError('MINERU_PARSE_FAILED', String(data.err_msg ?? 'MinerU parse failed'), false);
      await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs));
    }
    if (!done) throw new MineruError('MINERU_TIMEOUT', 'MinerU parse timed out', true);
    const zipUrl = String(done.full_zip_url ?? '');
    if (!zipUrl) throw new MineruError('MINERU_RESPONSE_INVALID', 'MinerU response missing full_zip_url', false);
    const zipResponse = await (this.options.fetchImpl ?? fetch)(zipUrl, { headers: { accept: 'application/zip' } });
    if (!zipResponse.ok) throw new MineruError('MINERU_ARTIFACT_UNAVAILABLE', `MinerU artifact HTTP ${zipResponse.status}`, true);
    const archive = new Uint8Array(await zipResponse.arrayBuffer());
    const files = unzipSync(archive);
    const names = Object.keys(files);
    const markdownName = names.find((name) => /(^|\/)full\.md$/i.test(name));
    const contentListName = findJson(files, [/content_list_v2\.json$/i, /_content_list\.json$/i, /content_list\.json$/i]);
    const modelName = findJson(files, [/_model\.json$/i, /(^|\/)model\.json$/i]);
    const markdown = markdownName ? text(files[markdownName]) : '';
    let contentListV2: unknown;
    let model: unknown;
    try { contentListV2 = contentListName ? JSON.parse(text(files[contentListName])) : undefined; } catch { contentListV2 = undefined; }
    try {
      const parsedModel = modelName ? JSON.parse(text(files[modelName])) : undefined;
      model = modelOcrRecords(parsedModel);
    } catch { model = undefined; }
    const blocks = contentRows(contentListV2);
    const assets: ParsedAsset[] = names.filter((name) => /(^|\/)images?\//i.test(name) && !name.endsWith('/')).map((path) => ({ path, bytes: files[path]!, mimeType: assetMime(path), assetType: assetType(path), sha256: hash(files[path]!) }));
    return { source: { fileName: input.fileName, mimeType: normalizeMime(input.mimeType), sha256: hash(input.sourceBytes) }, blocks: blocks.length ? blocks : blocksFromMarkdown(markdown), markdown, rawMarkdown: markdown, artifacts: { zipUri: zipUrl, zipBytes: archive, jsonText: contentListName ? text(files[contentListName]) : undefined, contentListV2, model, assets }, parserProvider: 'mineru', parserVersion: 'mineru-v4', parserMeta: { taskId, dataId, traceId, model: this.options.model } };
  }
}

export class MockMineruParser implements MineruParser {
  async parse(input: { ossUrl: string; fileName: string; mimeType: string; sourceBytes: Uint8Array }): Promise<ParsedDocument> {
    let markdown = new TextDecoder('utf-8', { fatal: false }).decode(input.sourceBytes);
    if (normalizeMime(input.mimeType) === 'application/pdf') markdown = markdown.replace(/^%PDF-[^\n]*\n/, '').replace(/\n%%EOF\s*$/, '');
    return { source: { fileName: input.fileName, mimeType: normalizeMime(input.mimeType), sha256: hash(input.sourceBytes) }, blocks: blocksFromMarkdown(markdown), markdown, rawMarkdown: markdown, artifacts: {}, parserProvider: 'mock-mineru', parserVersion: 'mock-mineru-v1' };
  }
}
