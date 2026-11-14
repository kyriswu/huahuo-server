import { describe, expect, it } from 'vitest';
import { markdownImages, rewriteImageUrls } from '../../src/lib/markdown-images.js';

const id = '019b5312-70ab-7200-8951-45bd914c6daa';
const url = `https://media.test/${id}?Expires=1&Signature=abc`;
const stable = `asset://${id}`;
const rewrite = (content: string) => rewriteImageUrls(content, markdownImages(content), new Map([[url, stable]]));

describe('positioned Markdown image references', () => {
  it('changes only an image destination and preserves CRLF, emoji, title and spacing', () => {
    const content = `😀 原文\r\n![示意](<${url}>  "保留标题")\r\n[普通链接](${url})\r\n`;
    expect(rewrite(content)).toBe(content.replace(`<${url}>`, `<${stable}>`));
    const image = markdownImages(content)[0]!;
    expect(content.slice(image.start, image.end)).toBe(url);
    expect(image.alt).toBe('示意');
  });
  it('understands escaped labels, nested destinations and repeated reference images', () => {
    const content = `![a\\]b][图]\n![第二张][图]\n\n[图]: <${url}> "title"\n`;
    expect(markdownImages(content)).toHaveLength(2);
    expect(rewrite(content)).toBe(content.replace(`<${url}>`, `<${stable}>`));
    const nested = '![a](https://media.test/a_(b).png "t")';
    expect(markdownImages(nested)[0]?.url).toBe('https://media.test/a_(b).png');
  });
  it('ignores fenced/indented/inline code, escaped syntax and HTML comments', () => {
    const image = `![例子](${url})`;
    const content = `\`\`\`md\n${image}\n\`\`\`\n\n    ${image}\n\n\`${image}\`\n\\${image}\n<!-- <img src="${url}"> -->`;
    expect(markdownImages(content)).toEqual([]);
    expect(rewrite(content)).toBe(content);
  });
  it('reads actual HTML attributes, decodes entities and preserves all other HTML bytes', () => {
    const encoded = url.replaceAll('&', '&amp;');
    const content = `<table><tr><td><img alt='图 > 表' src = '${encoded}' width="40"></td></tr></table>`;
    const images = markdownImages(content);
    expect(images).toHaveLength(1); expect(images[0]?.url).toBe(url);
    expect(rewrite(content)).toBe(content.replace(encoded, stable));
  });
  it('keeps KBIMAGE uuid semantic in a display view', () => {
    const content = `<KBIMAGE uuid="${id}" />\n文字 uuid=${id}`;
    const images = markdownImages(content);
    expect(images[0]).toMatchObject({ kind: 'kbimage', url: stable });
    expect(rewriteImageUrls(content, images, new Map([[stable, url]]))).toBe(content);
  });
  it('does not interpret HTML code/raw text contents as pictures', () => {
    for (const content of [`<script><img src="${url}"></script>`, `text <code><img src="${url}"></code>`, `<pre>\n<img src="${url}">\n</pre>`]) expect(markdownImages(content)).toEqual([]);
  });
  it('rejects ambiguous duplicate image attributes before normalization', () => {
    expect(() => markdownImages(`<img src="${url}" src="${stable}">`)).toThrow('MARKDOWN_IMAGE_ATTRIBUTE_DUPLICATE');
  });
  it('leaves an ordinary link intact when it shares an image definition', () => {
    const content = `![图][shared]\n[下载][shared]\n\n[shared]: <${url}> "说明"`;
    expect(rewrite(content)).toBe(content.replace('![图][shared]', `![图](<${stable}> "说明")`));
  });
  it('preserves blockquote continuation markers around a multiline image', () => {
    const content = `> ![图](\r\n> ${url}\r\n> "标题")`;
    expect(rewrite(content)).toBe(content.replace(url, stable));
  });
  it('preserves a 50,000-character source outside its image destinations', () => {
    const paragraph = '中文正文😀 mixed '.repeat(4200).slice(0, 50000);
    const content = `${paragraph}\n\n![图片](${url})\n\n${paragraph}`;
    expect(rewrite(content)).toBe(content.replace(`![图片](${url})`, `![图片](${stable})`));
  });
});
