import {describe,expect,it} from 'vitest';
import {analyzeDocumentStructure} from '../../../src/lib/document-processing/structure.js';
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
});
