import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeDocumentStructure } from '../../../src/lib/document-processing/structure.js';
import { splitTextIntoChunks } from '../../../src/lib/document-processing/splitter.js';
import { loadModelTokenizer } from '../../../src/lib/document-processing/tokenizer.js';
import type { ChunkDraft, SplitOptions, TokenCounter } from '../../../src/lib/document-processing/types.js';

// Explicit deterministic test tokenizer, never used by a runtime profile.
const tokenizer: TokenCounter = { id: 'test-codepoints', model: 'test-model', maxInputTokens: 4096, count: text => Array.from(text).length };
const options: SplitOptions = { tokenizer, targetTokens: 30, maxEmbeddingTokens: 60, overlapTokens: 7, respectSections: false };
function exactCoverage(content: string, chunks: ChunkDraft[]): void {
  const covered = new Uint8Array(content.length);
  for (const [index, chunk] of chunks.entries()) {
    expect(chunk.ordinal).toBe(index);
    expect(chunk.content).toBe(content.slice(chunk.source_start, chunk.source_end));
    expect(chunk.char_count).toBe(Array.from(chunk.content).length);
    expect(chunk.content.trim()).not.toBe('');
    for (let i = chunk.source_start; i < chunk.source_end; i += 1) covered[i] = 1;
    if (chunk.source_start) expect(/[\uDC00-\uDFFF]/u.test(content[chunk.source_start]!)).toBe(false);
    if (chunk.source_end < content.length) expect(/[\uDC00-\uDFFF]/u.test(content[chunk.source_end]!)).toBe(false);
  }
  expect([...covered].every(Boolean)).toBe(true);
}

describe('standalone document structure', () => {
  it('derives TOC and hierarchy from the same AST, with stable duplicate anchors and skipped levels', async () => {
    const content = 'Intro\r\n\r\n# Same\r\nA\r\n### Deep\r\nB\r\n# Same\r\nC\r\n';
    const result = await analyzeDocumentStructure(content);
    expect(result.offsetUnit).toBe('utf16');
    expect(result.sections).toHaveLength(2);
    expect(result.toc.map(item => item.anchor)).toEqual(['same', 'same-2']);
    expect(result.sections[0]?.children[0]).toMatchObject({ level: 3, parentSectionId: result.sections[0]?.sectionId, headingPath: ['Same', 'Deep'] });
    expect(result.toc[0]?.children[0]?.sectionId).toBe(result.sections[0]?.children[0]?.sectionId);
    expect(result.sections[0]?.sourceEnd).toBe(result.sections[1]?.sourceStart);
    expect(result.ranges.map(range => content.slice(range.sourceStart, range.sourceEnd)).join('')).toBe(content);
    expect(result).toEqual(await analyzeDocumentStructure(content));
  });
  it('does not turn fences, indented code, lists, quotes or OCR prose into document headings', async () => {
    const content = '```md\n# fake\n```\n\n    # indented\n\n- # list heading\n\n> # quoted\n\n图片文字：# fake OCR\n\nReal title\n==========\n';
    const result = await analyzeDocumentStructure(content);
    expect(result.toc.map(item => item.title)).toEqual(['Real title']);
  });
  it('keeps YAML front matter in the source without treating it as a heading', async () => {
    const preamble = '---\r\nname: 花火😀\r\ndescription: 示例\r\n---\r\n\r\n';
    const content = preamble + '# 正文标题\r\n\r\n原文';
    const result = await analyzeDocumentStructure(content);
    expect(result.toc).toHaveLength(1);
    expect(result.toc[0]).toMatchObject({ kind: 'heading', title: '正文标题', sourceStart: preamble.length });
    expect(result.ranges.map(range => content.slice(range.sourceStart, range.sourceEnd)).join('')).toBe(content);
  });
  it('returns an empty TOC and whole-body traversal without fabricated titles', async () => {
    const content = '普通正文，没有标题。';
    expect(await analyzeDocumentStructure(content)).toMatchObject({ toc: [], sections: [], ranges: [{ sourceStart: 0, sourceEnd: content.length, sectionId: null }] });
    expect((await analyzeDocumentStructure('# text', { format: 'text' })).toc).toEqual([]);
  });
  it('does not collide generated repeat anchors with literal numbered headings', async () => {
    const result = await analyzeDocumentStructure('# Same\n\n# Same\n\n# Same-2\n\n# Same');
    expect(result.toc.map(item => item.anchor)).toEqual(['same', 'same-2', 'same-2-2', 'same-3']);
  });
  it('uses parser-provided OCR ranges without promoting OCR hash lines into TOC or losing their body', async () => {
    const ordinary = '# Chapter\n\nBody\n\n';
    const content = ordinary + '<!-- mineru-unresolved-ocr -->\n\n图片文字：poster text\n\n# screenshot title\n\n## OCR subheading\n\nbody OCR';
    const result = await analyzeDocumentStructure(content, { ignoreHeadingRanges: [{ sourceStart: ordinary.length, sourceEnd: content.length }] });
    expect(result.toc.map(item => item.title)).toEqual(['Chapter']);
    expect(result.ranges.map(range => content.slice(range.sourceStart, range.sourceEnd)).join('')).toBe(content);
  });
  it('rejects ignored heading ranges from another or invalid source', async () => {
    await expect(analyzeDocumentStructure('# heading', { ignoreHeadingRanges: [{ sourceStart: -1, sourceEnd: 4 }] })).rejects.toMatchObject({ code: 'STRUCTURE_OPTIONS_INVALID' });
    await expect(analyzeDocumentStructure('# heading', { ignoreHeadingRanges: [{ sourceStart: 0, sourceEnd: 100 }] })).rejects.toMatchObject({ code: 'STRUCTURE_OPTIONS_INVALID' });
    await expect(analyzeDocumentStructure('# 😀 heading', { ignoreHeadingRanges: [{ sourceStart: 3, sourceEnd: 4 }] })).rejects.toMatchObject({ code: 'STRUCTURE_OPTIONS_INVALID' });
  });
});

describe('standalone LangChain chunk adapter', () => {
  it('preserves repeated text, CRLF, surrounding whitespace and exact offsets with real overlap', async () => {
    const content = '  \r\n' + '重复段落，Mixed English 👩‍💻。\r\n\r\n'.repeat(12) + '结束。  \r\n';
    const chunks = await splitTextIntoChunks({ content, format: 'markdown', options });
    expect(chunks.length).toBeGreaterThan(2); exactCoverage(content, chunks);
    expect(chunks.some((chunk, index) => index && chunk.source_start < chunks[index - 1]!.source_end)).toBe(true);
    expect(chunks.every(chunk => chunk.embedding_token_count <= options.maxEmbeddingTokens)).toBe(true);
    expect(chunks.every(chunk => chunk.metadata.tokenizerId === 'test-codepoints')).toBe(true);
  });
  it('works independently for manual Markdown without generating structure or TOC', async () => {
    const content = ' \n# User text\n\nUnicode é 😀 and spaces.  ';
    const chunks = await splitTextIntoChunks({ content, format: 'markdown', options: { ...options, targetTokens: 200, maxEmbeddingTokens: 300 } });
    expect(chunks).toHaveLength(1); expect(chunks[0]?.content).toBe(content);
    expect(chunks[0]?.heading_path).toEqual([]); expect(chunks[0]?.metadata.structureHintsUsed).toBe(false);
  });
  it('re-splits exact whitespace-bearing source spans when target equals the hard embedding cap', async () => {
    const content = '  # 主题\r\n\r\n第一段。😀第二段。\n尾部  ';
    const chunks = await splitTextIntoChunks({ content, format: 'markdown', options: { ...options, targetTokens: 16, maxEmbeddingTokens: 16, overlapTokens: 2 } });
    exactCoverage(content, chunks);
    expect(chunks.every(chunk => chunk.embedding_token_count <= 16)).toBe(true);
  });
  it('uses non-overlapping traversal of nested sections and never carries overlap across headings', async () => {
    const content = '# A\n\nA正文。'.repeat(1) + '\n\n### Nested\n\n' + '子章节内容。'.repeat(20) + '\n\n# B\n\n尾部正文。';
    const structureHints = await analyzeDocumentStructure(content);
    const chunks = await splitTextIntoChunks({ content, format: 'markdown', options: { ...options, respectSections: true }, structureHints });
    exactCoverage(content, chunks);
    for (const chunk of chunks) {
      const range = structureHints.ranges.find(range => range.sectionId === chunk.metadata.sectionId)!;
      expect(chunk.source_start).toBeGreaterThanOrEqual(range.sourceStart); expect(chunk.source_end).toBeLessThanOrEqual(range.sourceEnd);
    }
    expect(chunks.some(chunk => chunk.heading_path.join('/') === 'A/Nested')).toBe(true);
  });
  it('preserves whitespace-only preambles when using section hints', async () => {
    const content = ' \r\n\r\n# Heading\r\n\r\nbody  ';
    const chunks = await splitTextIntoChunks({ content, format: 'markdown', options: { ...options, respectSections: true }, structureHints: await analyzeDocumentStructure(content) });
    exactCoverage(content, chunks); expect(chunks[0]?.source_start).toBe(0); expect(chunks[0]?.heading_path).toEqual(['Heading']);
  });
  it('hard splits unseparated Unicode without splitting emoji grapheme clusters', async () => {
    const content = '👩‍💻'.repeat(15) + '中文字符'.repeat(10);
    const chunks = await splitTextIntoChunks({ content, format: 'text', options: { ...options, targetTokens: 8, maxEmbeddingTokens: 16, overlapTokens: 2 } });
    exactCoverage(content, chunks); expect(chunks.every(chunk => chunk.embedding_token_count <= 16)).toBe(true);
    expect(chunks.every(chunk => !chunk.content.startsWith('\u200d') && !chunk.content.endsWith('\u200d'))).toBe(true);
  });
  it.each([300, 2000])('enforces a %i-character source cap even with a permissive tokenizer and overlap', async maxSourceChars => {
    const compressed: TokenCounter = { ...tokenizer, count: text => Math.ceil(Array.from(text).length / 16) };
    const paragraph = '花火😀'.repeat(Math.floor((maxSourceChars - 20) / 3));
    const content = `# 标题\r\n\r\n${paragraph}\r\n\r\n${paragraph}\r\n\r\n${'中'.repeat(maxSourceChars + 11)}。`;
    const chunks = await splitTextIntoChunks({
      content, format: 'markdown', structureHints: await analyzeDocumentStructure(content),
      options: { tokenizer: compressed, targetTokens: 200, maxEmbeddingTokens: 250, overlapTokens: 4, maxSourceChars, respectSections: true },
    });
    exactCoverage(content, chunks);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every(chunk => chunk.char_count <= maxSourceChars && chunk.embedding_token_count <= 250)).toBe(true);
    expect(chunks.some((chunk, index) => index > 0 && chunk.source_start < chunks[index - 1]!.source_end)).toBe(true);
  });
  it('keeps readable source when a whitespace run alone exceeds the chunk budget', async () => {
    const content = ' '.repeat(650) + '😀有效内容' + ' '.repeat(980);
    const chunks = await splitTextIntoChunks({ content, format: 'text', options: { ...options, maxSourceChars: 300 } });
    expect(chunks.map(chunk => chunk.content).join('').trim()).toBe('😀有效内容');
    expect(chunks.every(chunk => chunk.char_count <= 300 && chunk.embedding_token_count <= 60)).toBe(true);
  });
  it.each([
    { boundary: 280, end: 280 },
    { boundary: 420, end: 420 },
    { boundary: 520, end: 500 },
  ])('cuts at $end characters with the first sentence ending at $boundary', async ({ boundary, end }) => {
    const content = '😀'.repeat(boundary - 1) + '。' + '下'.repeat(420);
    const chunks = await splitTextIntoChunks({
      content, format: 'text',
      options: { ...options, targetTokens: 500, maxEmbeddingTokens: 800, targetSourceChars: 300, maxSourceChars: 500 },
    });
    exactCoverage(content, chunks);
    expect(chunks[0]?.char_count).toBe(end);
    expect(chunks.every(chunk => chunk.char_count <= 500)).toBe(true);
  });
  it('counts model framing once per input rather than once per recursive fragment', async () => {
    const framed: TokenCounter = { ...tokenizer, id: 'explicit-test-framed-counter', count: text => Array.from(text).length + 1 };
    const chunks = await splitTextIntoChunks({ content: 'x'.repeat(100), format: 'text', options: { ...options, tokenizer: framed, overlapTokens: 0 } });
    expect(chunks[0]?.token_count).toBe(30);
    expect(chunks[0]?.content.length).toBe(29);
  });
  it('preserves long code/table content, adds table context and shrinks generated heading prefixes', async () => {
    const content = '# ' + '长标题'.repeat(35) + '\n\n| name | value |\n| --- | --- |\n' + Array.from({ length: 20 }, (_, i) => `| row${i} | 中文${i} |`).join('\n') + '\n\n```ts\n' + Array.from({ length: 15 }, (_, i) => `const value${i} = ${i};`).join('\n') + '\n```';
    const structureHints = await analyzeDocumentStructure(content);
    const chunks = await splitTextIntoChunks({ content, format: 'markdown', options: { ...options, respectSections: true }, structureHints });
    exactCoverage(content, chunks); expect(chunks.some(chunk => chunk.metadata.prefixReduced)).toBe(true);
    expect(chunks.every(chunk => chunk.embedding_token_count <= 60)).toBe(true);
    expect(chunks.some(chunk => chunk.embedding_text.includes('| name | value |'))).toBe(true);
  });
  it('keeps stable asset references with split OCR and never embeds fragments of transport URLs or base64', async () => {
    const content = '图片文字：' + '图片OCRtext。'.repeat(15) + '\n\n![poster](asset://images/hash.jpg)\n\n![temporary](https://cdn.example/x?Signature=SECRET1234567890)\n\ndata:image/png;base64,' + 'ABCD'.repeat(20);
    const chunks = await splitTextIntoChunks({ content, format: 'markdown', options: { ...options, targetTokens: 40, maxEmbeddingTokens: 100 } });
    exactCoverage(content, chunks);
    const ocrChunks = chunks.filter(chunk => chunk.content.includes('OCR'));
    expect(ocrChunks.length).toBeGreaterThan(1);
    expect(ocrChunks.every(chunk => chunk.metadata.assetRefs.includes('asset://images/hash.jpg') && chunk.embedding_text.includes('asset://images/hash.jpg'))).toBe(true);
    expect(chunks.map(chunk => chunk.embedding_text).join('')).not.toMatch(/SECRET|cdn\.example|ABCD|base64|https:\/\//);
  });
  it('does not generate empty chunks or duplicate a short input to satisfy overlap', async () => {
    expect(await splitTextIntoChunks({ content: ' \n\t ', format: 'text', options })).toEqual([]);
    expect(await splitTextIntoChunks({ content: 'Short', format: 'text', options })).toHaveLength(1);
  });
  it.each([
    { overlapTokens: -1 }, { overlapTokens: 30 }, { targetTokens: 61 }, { maxEmbeddingTokens: 5000 }, { maxSourceChars: 0 },
  ])('rejects invalid budgets %j', async patch => {
    await expect(splitTextIntoChunks({ content: 'text', format: 'text', options: { ...options, ...patch } })).rejects.toMatchObject({ code: 'SPLIT_OPTIONS_INVALID' });
  });
  it('rejects incomplete or overlapping hints instead of silently losing or duplicating text', async () => {
    const hints = await analyzeDocumentStructure('# A\n\ntext'); hints.ranges[0]!.sourceStart = 1;
    await expect(splitTextIntoChunks({ content: '# A\n\ntext', format: 'markdown', options, structureHints: hints })).rejects.toMatchObject({ code: 'STRUCTURE_HINTS_INVALID' });
    const content = '# 😀\n\nbody';
    const unsafe = await analyzeDocumentStructure(content);
    unsafe.ranges = [{ sourceStart: 0, sourceEnd: 3, sectionId: null, headingPath: [] }, { sourceStart: 3, sourceEnd: content.length, sectionId: null, headingPath: [] }];
    await expect(splitTextIntoChunks({ content, format: 'markdown', options, structureHints: unsafe })).rejects.toMatchObject({ code: 'STRUCTURE_HINTS_INVALID' });
  });
});

describe('real tokenizer adapter', () => {
  it('fails closed for missing model files', async () => {
    await expect(loadModelTokenizer({ model: 'Qwen/Qwen3-Embedding-8B', tokenizerPath: '/nonexistent/tokenizer.json', tokenizerConfigPath: '/nonexistent/config.json', maxInputTokens: 32768 })).rejects.toMatchObject({ code: 'TOKENIZER_FILES_UNAVAILABLE' });
  });
  const root = '.local/tokenizers/qwen3-embedding-8b/';
  it.skipIf(!existsSync(root + 'tokenizer.json'))('counts with pinned Qwen tokenizer and enforces final embedding budgets on multilingual text', async () => {
    const real = await loadModelTokenizer({ model: 'Qwen/Qwen3-Embedding-8B', tokenizerPath: root + 'tokenizer.json', tokenizerConfigPath: root + 'tokenizer_config.json', maxInputTokens: 32768 });
    expect(await real.count('Hello world')).toBe(3); // [9707,1879,151643(EOS)]
    expect(await real.count('你好世界')).toBe(3); // [108386,99489,151643(EOS)]
    const content = ('真实 tokenizer MVCC 数据库 👩‍💻。\n\n').repeat(40);
    const chunks = await splitTextIntoChunks({ content, format: 'markdown', options: { ...options, tokenizer: real, targetTokens: 40, maxEmbeddingTokens: 64, overlapTokens: 8 } });
    exactCoverage(content, chunks);
    for (const chunk of chunks) expect(chunk.embedding_token_count).toBe(await real.count(chunk.embedding_text));
    expect(chunks.every(chunk => chunk.embedding_token_count <= 64)).toBe(true);
  });
});
