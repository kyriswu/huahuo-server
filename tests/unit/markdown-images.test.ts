import { describe, expect, it } from 'vitest';
import { inputImages, normalizeImageTags } from '../../src/lib/markdown-images.js';

const id = '019b5312-70ab-7200-8951-45bd914c6daa';
const url = `https://media.test/${id}?Expires=1&Signature=abc`;
const normalize = (content: string) => normalizeImageTags(content, inputImages(content), new Map([[url, id], [`asset://${id}`, id]]));
const tag = (alt: string, title?: string) => `<KBIMAGE uuid="${id}" alt="${alt}"${title === undefined ? '' : ` title="${title}"`} />`;

describe('write-side image normalization into KBIMAGE', () => {
  it('replaces an entire image occurrence before hashing while preserving CRLF, emoji and ordinary links', () => {
    const input = `![示意](<${url}>  "保留标题")`;
    const content = `😀 原文\r\n${input}\r\n[普通链接](${url})\r\n`;
    expect(normalize(content)).toBe(content.replace(input, tag('示意', '保留标题')));
    expect(inputImages(content)).toEqual([{ url, alt: '示意', title: '保留标题', nodeStart: 7, nodeEnd: 7 + input.length, kind: 'markdown' }]);
  });
  it('handles escaped labels and removes image-only definitions so temporary signatures do not persist', () => {
    const content = `![a\\]b][图]\n![第二张][图]\n\n[图]: <${url}> "title"\n`;
    expect(inputImages(content)).toHaveLength(2);
    expect(normalize(content)).toBe(`${tag('a]b', 'title')}\n${tag('第二张', 'title')}\n\n\n`);
    const refreshed = content.replace(url, url.replace('Signature=abc', 'Signature=def'));
    expect(normalizeImageTags(refreshed, inputImages(refreshed), new Map([[url.replace('Signature=abc', 'Signature=def'), id]]))).toBe(normalize(content));
    expect(inputImages('![a](https://media.test/a_(b).png "t")')[0]?.url).toBe('https://media.test/a_(b).png');
  });
  it('ignores fenced/indented/inline code, escaped syntax and HTML comments', () => {
    const image = `![例子](${url})`;
    const content = `\`\`\`md\n${image}\n\`\`\`\n\n    ${image}\n\n\`${image}\`\n\\${image}\n<!-- <img src="${url}"> -->`;
    expect(inputImages(content)).toEqual([]);
    expect(normalize(content)).toBe(content);
  });
  it('converts HTML images, retaining alt, title and dimensions while preserving surrounding table markup', () => {
    const encoded = url.replaceAll('&', '&amp;');
    const input = `<img alt='图 > 表' src = '${encoded}' title="说明 &amp; 标题" width="40" height="30" onerror="alert(1)">`;
    const content = `<table><tr><td>${input}</td></tr></table>`;
    expect(inputImages(content)[0]).toMatchObject({ url, alt: '图 > 表', title: '说明 & 标题', width: '40', height: '30' });
    expect(normalize(content)).toBe(`<table><tr><td><KBIMAGE uuid="${id}" alt="图 &gt; 表" title="说明 &amp; 标题" width="40" height="30" /></td></tr></table>`);
  });
  it('keeps canonical KBIMAGE attributes and OCR exactly, including image-looking text in CDATA', () => {
    const content = `<KBIMAGE uuid="${id}" role="chart" page="8"><![CDATA[![fake](${url})\n<img src="https://foreign.test/image.png">]]></KBIMAGE>`;
    expect(inputImages(content)).toEqual([{ url: `asset://${id}`, alt: '', nodeStart: 0, nodeEnd: content.length, kind: 'kbimage' }]);
    expect(normalize(content)).toBe(content);
    expect(normalize(content + `\n<img src="${url}" alt="after">`)).toBe(content + '\n' + tag('after'));
  });
  it('does not interpret HTML code/raw text contents as pictures', () => {
    for (const content of [`<script><img src="${url}"></script>`, `text <code><img src="${url}"></code>`, `<pre>\n<img src="${url}">\n</pre>`]) expect(inputImages(content)).toEqual([]);
  });
  it('rejects duplicate relevant attributes and HTML images without a source', () => {
    expect(() => inputImages(`<img src="${url}" src="asset://${id}">`)).toThrow('MARKDOWN_IMAGE_ATTRIBUTE_DUPLICATE');
    expect(() => inputImages(`<img src="${url}" alt="one" alt="two">`)).toThrow('MARKDOWN_IMAGE_ATTRIBUTE_DUPLICATE');
    expect(() => inputImages('<img alt="missing">')).toThrow('MARKDOWN_IMAGE_SOURCE_REQUIRED');
  });
  it('leaves a shared ordinary reference link and its definition untouched', () => {
    const content = `![图][shared]\n[下载][shared]\n\n[shared]: <${url}> "说明"`;
    expect(normalize(content)).toBe(content.replace('![图][shared]', tag('图', '说明')));
  });
  it('does not treat KBIMAGE-looking literal text inside an image label as a separate image', () => {
    const label = `<KBIMAGE uuid="${id}" alt="x" />`;
    const content = `![${label}](${url})`;
    expect(inputImages(content)).toHaveLength(1);
    expect(normalize(content)).toBe(tag(`&lt;KBIMAGE uuid=&quot;${id}&quot; alt=&quot;x&quot; /&gt;`));
  });
  it('normalizes a multiline image inside a blockquote while preserving outside source bytes', () => {
    const image = `![图](\r\n> ${url}\r\n> "标题")`;
    const content = `before\r\n\r\n> ${image}\r\n\r\nafter`;
    expect(normalize(content)).toBe(content.replace(image, tag('图', '标题')));
  });
  it('preserves large source content outside the converted image', () => {
    const paragraph = '中文正文😀 mixed '.repeat(4200).slice(0, 50000);
    const content = `${paragraph}\n\n![图片](${url})\n\n${paragraph}`;
    expect(normalize(content)).toBe(content.replace(`![图片](${url})`, tag('图片')));
  });
  it('requires every accepted image to have an owned resource mapping', () => {
    const content = `![图片](${url})`;
    expect(() => normalizeImageTags(content, inputImages(content), new Map())).toThrow('MARKDOWN_IMAGE_RESOURCE_REQUIRED');
  });
});
