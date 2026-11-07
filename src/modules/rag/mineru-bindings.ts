import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

export interface MineruAssetInput {
  sourcePath: string;
  bytes?: Uint8Array;
  filePath?: string;
  byteSize?: number;
  mimeType: string;
  assetType?: 'image' | 'chart' | 'table_image' | 'formula' | 'other';
  sha256?: string;
}

export interface MineruBoundAsset {
  sourceAssetKey: string;
  assetRef: string;
  sourcePath: string;
  bytes?: Uint8Array;
  filePath?: string;
  byteSize: number;
  sha256: string;
  mimeType: string;
  assetType: 'image' | 'chart' | 'table_image' | 'formula' | 'other';
  sourceType?: string;
  pageNo?: number;
  sourceBlockId?: string;
  bbox?: number[];
  ocrText?: string;
  captionText?: string;
  enrichmentStatus: 'bound' | 'unresolved' | 'none';
  enrichmentProvider?: string;
  enrichmentSource?: string;
  enrichmentHash?: string;
}

export interface MineruBindingDiagnostics {
  missingRefs: string[];
  orphanAssets: string[];
  duplicatePaths: string[];
  unresolvedOcr: Array<{ text: string; pageNo?: number }>;
}

export interface MineruContentBindings {
  assets: MineruBoundAsset[];
  orderedBlocks: Array<{ type: 'text' | 'image'; sourceAssetKey?: string; text: string; start: number; end: number }>;
  canonicalMarkdown: string;
  diagnostics: MineruBindingDiagnostics;
}

export interface MineruContentBindingInput {
  rootDir?: string;
  rawMarkdown: string;
  contentListV2?: unknown;
  model?: unknown;
  assets?: MineruAssetInput[];
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
};

function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileHash(filePath: string): { sha256: string; byteSize: number } {
  const bytes = readFileSync(filePath);
  return { sha256: hash(bytes), byteSize: bytes.byteLength };
}

function normalizePath(value: string): string {
  const decoded = value.trim().replaceAll('\\', '/').split(/[?#]/, 1)[0] ?? '';
  const withoutPrefix = decoded.replace(/^\.\//, '').replace(/^\/+/, '');
  if (withoutPrefix.split('/').some((part) => part === '..')) throw new Error('MINERU_ASSET_PATH_INVALID');
  const imageIndex = withoutPrefix.toLowerCase().indexOf('images/');
  const candidate = imageIndex >= 0 ? withoutPrefix.slice(imageIndex) : `images/${withoutPrefix}`;
  const parts = candidate.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '..' || part === '.')) throw new Error('MINERU_ASSET_PATH_INVALID');
  return parts.join('/');
}

function assetRef(key: string): string { return `asset://${key}`; }

function mimeFor(path: string): string { return MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream'; }
function typeFor(path: string): MineruBoundAsset['assetType'] {
  const value = path.toLowerCase();
  if (value.includes('formula') || value.includes('equation')) return 'formula';
  if (value.includes('table')) return 'table_image';
  if (value.includes('chart') || value.includes('graph')) return 'chart';
  return 'image';
}
function typeFromSourceType(sourceType: string | undefined, fallback: MineruBoundAsset['assetType']): MineruBoundAsset['assetType'] {
  const value = sourceType?.toLowerCase() ?? '';
  if (value.includes('formula') || value.includes('equation')) return 'formula';
  if (value.includes('table')) return 'table_image';
  if (value.includes('chart') || value.includes('graph')) return 'chart';
  return fallback;
}

function records(value: unknown): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { for (const child of item) visit(child); return; }
    if (!item || typeof item !== 'object') return;
    const row = item as Record<string, unknown>;
    result.push(row);
    for (const child of Object.values(row)) {
      if (Array.isArray(child) || (child && typeof child === 'object')) visit(child);
    }
  };
  visit(value);
  return result;
}

function stringField(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    const text = valueText(value);
    if (text) return text;
  }
  if (String(row.label ?? '').toLowerCase() === 'ocr_text' && keys.some((key) => ['ocr_text', 'ocrtext', 'ocr', 'text_content'].includes(key.toLowerCase()))) {
    return valueText(row.text);
  }
  return undefined;
}
function valueText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const parts = value.map(valueText).filter((item): item is string => Boolean(item));
    return parts.length ? parts.join('\n') : undefined;
  }
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    for (const key of ['text', 'content', 'value', 'ocr_text']) {
      const nested = valueText(row[key]);
      if (nested) return nested;
    }
  }
  return undefined;
}
function numberField(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = Number(row[key]);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}
function pathField(row: Record<string, unknown>): string | undefined {
  const nested = row.image_source;
  if (nested && typeof nested === 'object') {
    const path = stringField(nested as Record<string, unknown>, ['path', 'image_path', 'img_path', 'src']);
    if (path) return path;
  }
  return stringField(row, ['source_path', 'image_path', 'img_path', 'path', 'image', 'src']);
}
function bboxField(row: Record<string, unknown>): number[] | undefined {
  const value = row.bbox ?? row.box;
  if (!Array.isArray(value)) return undefined;
  const bbox = value.map(Number).filter(Number.isFinite);
  return bbox.length >= 4 ? bbox.slice(0, 4) : undefined;
}
function pageField(row: Record<string, unknown>): number | undefined {
  const page = numberField(row, ['page_index', 'page_idx', 'page_no', 'page']);
  return page === undefined ? undefined : page + (String(row.page_index ?? row.page_idx) === String(page) ? 1 : 0);
}

function contentListImageRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const result: Array<Record<string, unknown>> = [];
  for (const [pageIndex, page] of value.entries()) {
    if (!Array.isArray(page)) continue;
    for (const item of page) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const nested = row.content && typeof row.content === 'object' && !Array.isArray(row.content) ? row.content as Record<string, unknown> : {};
      const merged: Record<string, unknown> = { ...row, ...nested };
      if (merged.page_index === undefined && merged.page_idx === undefined && merged.page_no === undefined && merged.page === undefined) merged.page_index = pageIndex;
      result.push(merged);
    }
  }
  return result;
}

function collectMetadata(contentListV2: unknown, model: unknown): Map<string, { pageNo?: number; sourceBlockId?: string; bbox?: number[]; captionText?: string; ocrText?: string; modelSource?: string; sourceType?: string }> {
  const map = new Map<string, { pageNo?: number; sourceBlockId?: string; bbox?: number[]; captionText?: string; ocrText?: string; modelSource?: string; sourceType?: string }>();
  const add = (rawPath: string | undefined, row: Record<string, unknown>, source: string): void => {
    if (!rawPath) return;
    let path: string;
    try { path = normalizePath(rawPath); } catch { return; }
    const current = map.get(path) ?? {};
    const caption = stringField(row, ['caption', 'caption_text', 'image_caption', 'image_footnote', 'description', 'footnote']);
    const ocr = stringField(row, ['ocr_text', 'ocrText', 'ocr', 'text_content']);
    const combinedOcr = [current.ocrText, ocr].filter((item, index, values): item is string => Boolean(item) && values.indexOf(item) === index).join('\n');
    const combinedCaption = [current.captionText, caption].filter((item, index, values): item is string => Boolean(item) && values.indexOf(item) === index).join('\n');
    map.set(path, {
      ...current,
      pageNo: current.pageNo ?? pageField(row),
      sourceBlockId: current.sourceBlockId ?? stringField(row, ['block_id', 'blockId', 'id']),
      bbox: current.bbox ?? bboxField(row),
      sourceType: current.sourceType ?? stringField(row, ['type']),
      captionText: combinedCaption || undefined,
      ocrText: combinedOcr || undefined,
      ...(ocr || caption ? { modelSource: source } : {}),
    });
  };
  for (const row of contentListImageRows(contentListV2)) add(pathField(row), row, 'content_list_v2');
  for (const row of records(contentListV2)) add(pathField(row), row, 'content_list_v2');
  for (const row of records(model)) add(pathField(row), row, 'model.json');
  return map;
}

function walkImageFiles(rootDir: string): MineruAssetInput[] {
  if (!existsSync(rootDir)) return [];
  const result: MineruAssetInput[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) { visit(full); continue; }
      const rel = relative(rootDir, full).replaceAll('\\', '/');
      if (!/(^|\/)images?\//i.test(rel)) continue;
      const file = fileHash(full);
      result.push({ sourcePath: rel, filePath: full, byteSize: file.byteSize, sha256: file.sha256, mimeType: mimeFor(rel), assetType: typeFor(rel) });
    }
  };
  visit(rootDir);
  return result;
}

function nearContains(markdown: string, start: number, end: number, value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return true;
  const window = markdown.slice(Math.max(0, start - 800), Math.min(markdown.length, end + 800));
  return window.includes(normalized);
}

function markdownImagePattern(): RegExp {
  return /!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+['"][^'"]*['"])?\s*\)/g;
}

function buildFromAssets(input: MineruContentBindingInput, sourceAssets: MineruAssetInput[]): MineruContentBindings {
  const metadata = collectMetadata(input.contentListV2, input.model);
  const diagnostics: MineruBindingDiagnostics = { missingRefs: [], orphanAssets: [], duplicatePaths: [], unresolvedOcr: [] };
  const seen = new Set<string>();
  const assets: MineruBoundAsset[] = [];
  for (const source of sourceAssets) {
    let key: string;
    try { key = normalizePath(source.sourcePath); } catch { continue; }
    if (seen.has(key)) { diagnostics.duplicatePaths.push(key); continue; }
    seen.add(key);
    const info = metadata.get(key) ?? {};
    const bytes = source.bytes;
    const file = !bytes && source.filePath ? fileHash(source.filePath) : undefined;
    const sha = source.sha256 ?? file?.sha256 ?? (bytes ? hash(bytes) : undefined);
    if (!sha) throw new Error(`MINERU_ASSET_CONTENT_MISSING:${key}`);
    const byteSize = source.byteSize ?? bytes?.byteLength ?? file?.byteSize ?? 0;
    const ocrText = info.ocrText;
    const captionText = info.captionText;
    assets.push({ sourceAssetKey: key, assetRef: assetRef(key), sourcePath: key, ...(bytes ? { bytes } : {}), ...(source.filePath ? { filePath: source.filePath } : {}), byteSize, sha256: sha, mimeType: source.mimeType, assetType: typeFromSourceType(info.sourceType, source.assetType ?? typeFor(key)), ...(info.sourceType ? { sourceType: info.sourceType } : {}), ...(info.pageNo !== undefined ? { pageNo: info.pageNo } : {}), ...(info.sourceBlockId ? { sourceBlockId: info.sourceBlockId } : {}), ...(info.bbox ? { bbox: info.bbox } : {}), ...(ocrText || captionText ? { enrichmentStatus: 'bound', enrichmentProvider: 'mineru', enrichmentSource: info.modelSource, enrichmentHash: hash(`${ocrText ?? ''}\n${captionText ?? ''}`) } : { enrichmentStatus: 'none' }), ...(ocrText ? { ocrText } : {}), ...(captionText ? { captionText } : {}) });
  }
  const byKey = new Map(assets.map((asset) => [asset.sourceAssetKey, asset]));
  let output = '';
  let cursor = 0;
  const orderedBlocks: MineruContentBindings['orderedBlocks'] = [];
  for (const match of input.rawMarkdown.matchAll(markdownImagePattern())) {
    const index = match.index ?? 0;
    const rawPath = match[2] ?? '';
    output += input.rawMarkdown.slice(cursor, index);
    let key: string;
    try { key = normalizePath(rawPath); } catch { diagnostics.missingRefs.push(rawPath); output += match[0]; cursor = index + match[0].length; continue; }
    const asset = byKey.get(key);
    if (!asset) { diagnostics.missingRefs.push(key); output += match[0]; cursor = index + match[0].length; continue; }
    const image = `![${match[1] ?? ''}](${asset.assetRef})`;
    const additions: string[] = [];
    if (asset.ocrText && !nearContains(input.rawMarkdown, index, index + match[0].length, asset.ocrText)) additions.push(`图片文字：${asset.ocrText}`);
    if (asset.captionText && !nearContains(input.rawMarkdown, index, index + match[0].length, asset.captionText)) additions.push(`图片描述：${asset.captionText}`);
    output += additions.length ? `${additions.join('\n\n')}\n\n${image}` : image;
    orderedBlocks.push({ type: 'image', sourceAssetKey: key, text: [asset.ocrText, asset.captionText].filter(Boolean).join('\n\n'), start: index, end: index + match[0].length });
    cursor = index + match[0].length;
  }
  output += input.rawMarkdown.slice(cursor);
  const referenced = new Set(orderedBlocks.flatMap((block) => block.sourceAssetKey ? [block.sourceAssetKey] : []));
  for (const asset of assets) if (!referenced.has(asset.sourceAssetKey)) diagnostics.orphanAssets.push(asset.sourceAssetKey);
  for (const row of records(input.model)) {
    const ocr = stringField(row, ['ocr_text', 'ocrText', 'ocr']);
    if (!ocr) continue;
    const path = pathField(row);
    if (!path) diagnostics.unresolvedOcr.push({ text: ocr, ...(pageField(row) !== undefined ? { pageNo: pageField(row) } : {}) });
  }
  if (diagnostics.unresolvedOcr.length) {
    output += `\n\n<!-- mineru-unresolved-ocr -->\n\n${diagnostics.unresolvedOcr.map((item) => `图片文字${item.pageNo ? `（第${item.pageNo}页）` : ''}：${item.text}`).join('\n\n')}`;
  }
  const textBlocks = output.split(/\n{2,}/).map((text, index) => ({ type: 'text' as const, text, start: index, end: index + text.length }));
  return { assets, orderedBlocks: [...textBlocks, ...orderedBlocks].sort((a, b) => a.start - b.start), canonicalMarkdown: output, diagnostics };
}

/** Bind an extracted MinerU directory to stable source asset keys and asset:// refs. */
export function buildMineruContentBindings(input: MineruContentBindingInput): MineruContentBindings {
  return buildFromAssets(input, input.assets ?? (input.rootDir ? walkImageFiles(input.rootDir) : []));
}

/** In-memory variant used by the Worker after reading a MinerU ZIP. */
export function buildMineruContentBindingsFromAssets(input: Omit<MineruContentBindingInput, 'rootDir'>): MineruContentBindings {
  return buildFromAssets(input, input.assets ?? []);
}
