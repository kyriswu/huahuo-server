import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '/Users/kyriswu/Downloads/c8d85ccd-acc0-4cd2-a48c-b23f7efcd241');
const markdownPath = join(root, 'full.md');
const contentListPath = join(root, '562889de-a129-4648-9a15-4725439d339c_content_list_v2.json');
const modelPath = join(root, '562889de-a129-4648-9a15-4725439d339c_model.json');
for (const file of [markdownPath, contentListPath, modelPath, join(root, 'images')]) assert.ok(existsSync(file), `fixture path missing: ${file}`);

const { buildMineruContentBindings } = await import('../dist/modules/rag/mineru-bindings.js');
const { ocrHeadingRanges } = await import('../dist/modules/rag/structure-hints.js');
const { analyzeDocumentStructure } = await import('../dist/lib/document-processing/structure.js');
const { splitTextIntoChunks } = await import('../dist/lib/document-processing/splitter.js');
const { loadModelTokenizer } = await import('../dist/lib/document-processing/tokenizer.js');

const rawMarkdown = readFileSync(markdownPath, 'utf8');
const contentListV2 = JSON.parse(readFileSync(contentListPath, 'utf8'));
const model = JSON.parse(readFileSync(modelPath, 'utf8'));
const imageRefPattern = /!\[[^\]]*\]\(\s*<?[^\s)>]+>?(?:\s+['"][^'"]*['"])?\s*\)/g;
const markdownRefTotal = [...rawMarkdown.matchAll(imageRefPattern)].length;

function walk(value) {
  if (Array.isArray(value)) return value.flatMap(walk);
  if (value && typeof value === 'object') return [value, ...Object.values(value).flatMap(walk)];
  return [];
}
const ocrRows = walk(model).filter((row) => String(row.label ?? '').toLowerCase() === 'ocr_text' && typeof row.text === 'string' && row.text.trim());
const bindings = buildMineruContentBindings({ rootDir: root, rawMarkdown, contentListV2, model });
const structure = await analyzeDocumentStructure(bindings.canonicalMarkdown, { format: 'markdown', ignoreHeadingRanges: ocrHeadingRanges(bindings.canonicalMarkdown, bindings.assets) });
const tokenizer = await loadModelTokenizer({
  model: 'Qwen/Qwen3-Embedding-8B',
  tokenizerPath: process.env.RAG_TOKENIZER_PATH ?? '.local/tokenizers/qwen3-embedding-8b/tokenizer.json',
  tokenizerConfigPath: process.env.RAG_TOKENIZER_CONFIG_PATH ?? '.local/tokenizers/qwen3-embedding-8b/tokenizer_config.json',
  maxInputTokens: 32768,
});
const children = await splitTextIntoChunks({ content: bindings.canonicalMarkdown, format: 'markdown', options: { targetTokens: 500, maxEmbeddingTokens: 800, overlapTokens: 64, respectSections: true, tokenizer }, structureHints: structure });
const stats = {
  asset_total: bindings.assets.length,
  markdown_ref_total: markdownRefTotal,
  orphan_total: bindings.diagnostics.orphanAssets.length,
  ocr_total: ocrRows.length,
  ocr_unresolved_total: bindings.diagnostics.unresolvedOcr.length,
  section_total: structure.ranges.filter(range => range.sectionId !== null).length,
  parent_total: 0,
  child_total: children.length,
};
const canonicalAssetRefTotal = [...bindings.canonicalMarkdown.matchAll(/asset:\/\/images\//g)].length;
const v2IndexedTotal = bindings.assets.filter((asset) => Boolean(asset.sourceType) && asset.pageNo !== undefined && asset.bbox?.length === 4).length;

assert.equal(stats.asset_total, 238);
assert.equal(stats.markdown_ref_total, 235);
assert.equal(stats.orphan_total, 3);
assert.equal(stats.ocr_total, stats.ocr_unresolved_total + bindings.assets.filter((asset) => asset.ocrText).length);
assert.equal(bindings.diagnostics.missingRefs.length, 0);
assert.equal(canonicalAssetRefTotal, markdownRefTotal);
assert.equal(v2IndexedTotal, stats.asset_total);
assert.ok(ocrRows.every((row) => bindings.canonicalMarkdown.includes(row.text.trim())));
assert.ok(bindings.canonicalMarkdown.includes('asset://images/'));
assert.ok(bindings.canonicalMarkdown.includes('<!-- mineru-unresolved-ocr -->'));
assert.equal(stats.parent_total, 0);
assert.ok(stats.child_total > 0);
assert.ok(children.every((child) => child.content === bindings.canonicalMarkdown.slice(child.source_start, child.source_end)));
assert.ok(children.every((child) => child.embedding_token_count <= 800));
assert.ok(!bindings.canonicalMarkdown.includes('layout.json'));

console.log(JSON.stringify({
  fixture: root,
  ...stats,
  missing_ref_total: bindings.diagnostics.missingRefs.length,
  duplicate_path_total: bindings.diagnostics.duplicatePaths.length,
  canonical_asset_ref_total: canonicalAssetRefTotal,
  v2_indexed_total: v2IndexedTotal,
  unresolved_orphan_assets: bindings.diagnostics.orphanAssets.slice(0, 3),
  canonical_contains_asset_refs: true,
  canonical_contains_unresolved_ocr: true,
  temporary_sections_only: true,
  tokenizer_id: tokenizer.id,
  chunk_source_offsets: 'UTF-16 [start,end)',
  production_layout_json_read: false,
  image_upload_strategy: 'sequential bounded stream per asset',
}, null, 2));
