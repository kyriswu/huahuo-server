import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import { kbImageAttributes, kbImages, kbImageTag, renderKbImages } from '../../src/lib/kb-images.js';

const id = '998d9ecb-45d2-5624-a050-9cfcadf99ae6';
const other = '019b5312-70ab-7200-8951-45bd914c6daa';
const tag = `<KBIMAGE uuid="${id}" alt="图" />`;
const paired = `<KBIMAGE uuid="${id}" role="chart" page="1"><![CDATA[OCR 正文 😀]]></KBIMAGE>`;
const target = `https://images.test/${id}?Expires=42&Signature=signed`;

describe('canonical KBIMAGE scan without a Markdown tree', () => {
  it('does not allocate image records for large ordinary Markdown', () => {
    const source = '普通正文 **bold** `code` [link](https://example.test)\n\n'.repeat(30000);
    expect(source.length).toBeGreaterThan(1024 * 1024);
    expect(kbImages(source)).toEqual([]);
    expect(kbImages('![图](asset://' + id + ') <img src="asset://' + id + '">')).toEqual([]);
  });
  it('handles many unmatched ticks, malformed quotes, definitions and multiline tags without rescanning prefixes', () => {
    const ticks = Array.from({ length: 1000 }, (_, i) => `text ${'`'.repeat(i + 1)} line\n`).join('');
    const definitions = Array.from({ length: 10000 }, (_, i) => `[label${i}]: https://example.test\n`).join('');
    expect(kbImages(`${ticks}text ${tag}`)).toHaveLength(1);
    expect(kbImages(`${'<a title="\'\n'.repeat(10000)}\n${tag}`)).toHaveLength(1);
    expect(kbImages(`${definitions}\n${tag}`)).toHaveLength(1);
    expect(kbImages(`${tag}\n`.repeat(2000))).toHaveLength(2000);
  });
  it('retains UTF-16 coordinates, full paired-tag spans and occurrence order', () => {
    const source = `😀\r\n${tag}\r\n前文 ${paired}\r\n末尾`;
    const images = kbImages(source);
    expect(images.map(image => image.resourceId)).toEqual([id, id]);
    expect(images.map(image => source.slice(image.nodeStart, image.nodeEnd))).toEqual([tag, paired]);
    expect(images.map(image => source.slice(image.contentStart, image.contentEnd))).toEqual(['', '<![CDATA[OCR 正文 😀]]>']);
    expect(images[0]).toMatchObject({ nodeStart: 4, alt: '图' });
    expect(source).toContain(paired);
  });
  it('reads quoted > characters, case-insensitive attributes and decoded alt entities', () => {
    const source = `<KBIMAGE alt='a > b &amp; &quot;x&quot; &#x1F600;' UUID="${id.toUpperCase()}" role="table > chart" />`;
    expect(kbImages(source)).toEqual([{ resourceId: id, alt: 'a > b & "x" 😀', nodeStart: 0, nodeEnd: source.length, contentStart: source.length, contentEnd: source.length }]);
  });
  it.each([
    `<KBIMAGE uuid="${id}" UUID="${id}" />`,
    `<KBIMAGE uuid="${id}" alt="one" alt="two" />`,
    '<KBIMAGE />', '<KBIMAGE uuid="bad" />', '<KBIMAGE uuid="00000000-0000-0000-0000-000000000000" />',
    `<KBIMAGE uuid="${id}">unclosed`, `<KBIMAGE uuid="${id}"> <KBIMAGE uuid="${other}" /> </KBIMAGE>`,
    `</KBIMAGE>${tag}`, `<KBIMAGE uuid="${id}"`,
  ])('rejects invalid canonical image markup: %s', source => {
    expect(() => kbImages(source)).toThrow(/KB_IMAGE_/u);
  });
  it('does not treat similarly named tags or attribute values as images', () => {
    expect(kbImages(`<KBIMAGES uuid="${id}" /><div data-example='<KBIMAGE uuid="${id}" />'>text</div>`)).toEqual([]);
  });
  it.each(['```xml', '~~~~', '    ', '\t'])('ignores code blocks beginning with %s', marker => {
    const source = marker.trim() ? `${marker}\r\n${tag}\r\n${marker[0] === '`' ? '```' : '~~~~'}\r\n\r\n${paired}` : `${marker}${tag}\r\n\r\n${paired}`;
    expect(kbImages(source).map(image => source.slice(image.nodeStart, image.nodeEnd))).toEqual([paired]);
  });
  it('does not turn following Markdown code into HTML when an image is stored as a canonical tag', () => {
    expect(kbImages(`${tag}\n\`<KBIMAGE uuid="invalid" />\``)).toHaveLength(1);
    expect(kbImages(`${tag}\n\`\`\`xml\n<KBIMAGE uuid="invalid" />\n\`\`\``)).toHaveLength(1);
  });
  it('keeps quoted/list fenced examples opaque and resumes at their boundary', () => {
    const source = `> \\Example\n> ~~~xml\n> ${tag}\n> ~~~\n\n- \`\`\`xml\n  ${tag}\n  \`\`\`\n\n${paired}`;
    expect(kbImages(source).map(image => source.slice(image.nodeStart, image.nodeEnd))).toEqual([paired]);
    expect(kbImages(`> \`\`\`xml\n> ${tag}\n\n${paired}`).map(image => image.resourceId)).toEqual([id]);
  });
  it('ignores inline code, including multiline and mismatched tick runs', () => {
    for (const source of [`\`${tag}\``, `\`\`code \` ${tag}\`\``, `before \`\`multi\n${tag}\nline\`\` after`]) expect(kbImages(source)).toEqual([]);
    expect(kbImages(`unclosed \` ${tag}`)).toHaveLength(1);
    expect(kbImages(`unclosed \`\n\n${tag}\n\``)).toHaveLength(1);
    expect(kbImages(`unclosed \`\n# heading ${tag}\n\``)).toHaveLength(1);
  });
  it('matches code spans inside block quote and list containers', () => {
    for (const prefix of ['> ', '> > ', '- > ']) {
      const continuation = prefix === '- > ' ? '  > ' : prefix;
      expect(kbImages(`${prefix}\`\n${continuation}${tag}\n${continuation}\``)).toEqual([]);
    }
  });
  it('does not join code spans across headings, HTML blocks or setext boundaries', () => {
    for (const source of [`# \`\n${tag}\n\``, `\`x\n===\n${tag}\n\``, `\`x\n<div>\n${tag}\n</div>\n\``, `\`x\n<!-- comment -->\n${tag}\n\``]) expect(kbImages(source)).toHaveLength(1);
  });
  it('keeps link destinations, titles and standalone reference definitions opaque', () => {
    for (const source of [
      `[x](https://example.test "${tag.replaceAll('"', "'")}")`,
      `[x](https://example.test '\n${tag}\n')`,
      `[x](https://example.test/${tag.replaceAll(' ', '%20')})`,
      `[x]: https://example.test "${tag.replaceAll('"', "'")}"`,
      `[x]: https://example.test\n  '${tag}'`,
      `[x]: https://example.test\n  'multi\n${tag}\nline'`,
    ]) expect(kbImages(source)).toEqual([]);
    expect(kbImages(`[${tag}](https://example.test)`)).toHaveLength(1);
    expect(kbImages(`[x]: https://example.test\n\n${tag}`)).toHaveLength(1);
    expect(kbImages(`paragraph\n[x]: https://example.test "${tag.replaceAll('"', "'")}"`)).toHaveLength(1);
  });
  it('does not validate KBIMAGE examples inside Markdown image alt labels', () => {
    for (const example of ['<KBIMAGE />', '<KBIMAGE uuid="invalid" />', tag]) {
      expect(kbImages(`![${example}](asset://${id})`)).toEqual([]);
      expect(kbImages(`![nested [label] ${example}](asset://${id} "title")`)).toEqual([]);
    }
  });
  it('uses actual reference definitions before treating reference image labels as literal alt', () => {
    const example = '<KBIMAGE uuid="invalid" />';
    expect(kbImages(`![${example}][photo]\n\n[photo]: asset://${id}`)).toEqual([]);
    expect(kbImages(`[photo]: asset://${id}\n\n![${example}][PHOTO]`)).toEqual([]);
    expect(kbImages(`![${example}][]\n\n[${example}]: asset://${id}`)).toEqual([]);
    expect(kbImages(`![${example}]\n\n[${example}]: asset://${id}`)).toEqual([]);
    expect(kbImages(`![${tag}][absent]`)).toHaveLength(1);
    expect(() => kbImages(`text <KBIMAGE uuid="${id}">\n\n[photo]: asset://${id}\n\n</KBIMAGE>\n\n![${example}][photo]`)).toThrow('KB_IMAGE_UUID_INVALID');
    expect(() => kbImages(`![${example}][photo]\n\n\`\`\`\n[photo]: asset://${id}\n\`\`\``)).toThrow('KB_IMAGE_UUID_INVALID');
  });
  it('ignores escapes, comments and literal CDATA without hiding later images', () => {
    const source = `\\${tag}\n<!-- ${tag} -->\n<![CDATA[${tag}]]>\n\n${paired}`;
    expect(kbImages(source).map(image => source.slice(image.nodeStart, image.nodeEnd))).toEqual([paired]);
    expect(kbImages(`\\\\${tag}`)).toHaveLength(1);
    expect(kbImages(`<!-- ${tag}`)).toEqual([]);
  });
  it.each(['script', 'style', 'pre', 'code', 'textarea'])('ignores raw text in %s', name => {
    const source = `<${name} title=">">\n${tag}\n</${name}>\n\n${paired}`;
    expect(kbImages(source).map(image => source.slice(image.nodeStart, image.nodeEnd))).toEqual([paired]);
  });
  it('treats quoted image samples inside OCR CDATA as text', () => {
    const content = `OCR: ${tag} and </KBIMAGE> and ![sample](asset://${other})`;
    const source = `<KBIMAGE uuid="${id}"><![CDATA[${content}]]></KBIMAGE>`;
    const images = kbImages(source);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ resourceId: id, nodeEnd: source.length });
    expect(source.slice(images[0]!.contentStart, images[0]!.contentEnd)).toBe(`<![CDATA[${content}]]>`);
  });
  it('recognizes images embedded in merged-table HTML without interpreting its Markdown punctuation', () => {
    const source = `<table><tr><td colspan="2">\n    ${tag}\n\`${paired}\`\n</td></tr></table>`;
    expect(kbImages(source)).toHaveLength(2);
    expect(kbImages(source).every(image => image.htmlBlock === true)).toBe(true);
    expect(kbImages(tag)[0]).not.toHaveProperty('htmlBlock');
  });
  it('does not lose an image in an indented paragraph continuation or list item', () => {
    expect(kbImages(`paragraph\n    ${tag}`)).toHaveLength(1);
    expect(kbImages(`- first\n\n  ${tag}`)).toHaveLength(1);
    expect(kbImages(`- first\n\n      ${tag}`)).toHaveLength(0);
  });
});

describe('canonical tags and authorized display projection', () => {
  it('creates one escaped canonical tag and normalizes UUID case', () => {
    const result = kbImageTag(id.toUpperCase(), '图 "A" & <B>\n下一行', '说明 > 标题');
    expect(result).toBe(`<KBIMAGE uuid="${id}" alt="图 &quot;A&quot; &amp; &lt;B&gt;&#10;下一行" title="说明 &gt; 标题" />`);
    expect(kbImages(result)[0]!.alt).toBe('图 "A" & <B>\n下一行');
    expect(() => kbImageTag('not-a-uuid', 'image')).toThrow('KB_IMAGE_UUID_INVALID');
  });
  it('changes only selected complete tags and preserves canonical input and other tags', () => {
    const source = `前\r\n${tag}\r\n中 <KBIMAGE uuid="${other}" alt="other" />\n后`;
    const images = kbImages(source), result = renderKbImages(source, images, new Map([[id, target]]));
    expect(result).toBe(source.replace(tag, `<img src="${target.replaceAll('&', '&amp;')}" alt="图" />`));
    expect(renderKbImages(source, images, new Map())).toBe(source);
    expect(source).toContain(tag);
    expect(result).toContain(`<KBIMAGE uuid="${other}" alt="other" />`);
  });
  it('renders paired OCR as escaped text rather than active markup or image syntax', () => {
    const ocr = `<KBIMAGE uuid="${other}" /> <script>alert(1)</script> **bold** & "quoted" ![remote](https://external.test/image.png)`;
    const source = `<KBIMAGE uuid="${id}" alt="图"><![CDATA[${ocr}]]></KBIMAGE>`;
    const result = renderKbImages(source, kbImages(source), new Map([[id, target]]));
    expect(result).toContain('<img src=');
    expect(result).toContain('<span>&lt;KBIMAGE');
    expect(result).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &#42;&#42;bold&#42;&#42; &amp; &quot;quoted&quot;');
    const html = new MarkdownIt({ html: true }).render(result);
    expect(html.match(/<img /gu)).toHaveLength(1);
    expect(html).not.toContain('<strong>');
    expect(result).not.toContain('<script>');
    expect(kbImages(result)).toEqual([]);
  });
  it('retains escaped titles and only bounded numeric display dimensions', () => {
    const source = `<KBIMAGE uuid="${id}" alt="图" title="A &quot;title&quot;" width="040" height="80" other="preserved" />`;
    expect(kbImageAttributes(source, kbImages(source)[0]!).get('other')).toBe('preserved');
    expect(renderKbImages(source, kbImages(source), new Map([[id, target]]))).toContain('title="A &quot;title&quot;" width="40" height="80"');
    const invalid = `<KBIMAGE uuid="${id}" width="999999" height="10;position:absolute" />`;
    const rendered = renderKbImages(invalid, kbImages(invalid), new Map([[id, target]]));
    expect(rendered).not.toContain('width=');
    expect(rendered).not.toContain('height=');
  });
  it('supports a complete image within a selected chunk using shifted UTF-16 offsets', () => {
    const source = `prefix 😀\n${paired}\nsuffix`, image = kbImages(source)[0]!;
    const chunk = source.slice(image.nodeStart, image.nodeEnd), start = image.nodeStart;
    const local = { ...image, nodeStart: 0, nodeEnd: image.nodeEnd - start, contentStart: image.contentStart - start, contentEnd: image.contentEnd - start };
    expect(renderKbImages(chunk, [local], new Map([[id, target]]))).toContain('OCR 正文 😀');
    expect(() => renderKbImages(chunk.slice(0, 5), [local], new Map([[id, target]]))).toThrow('KB_IMAGE_RANGE_INVALID');
  });
  it('rejects unsafe display URLs and preserves a valid original tag', () => {
    for (const value of ['javascript:alert(1)', 'data:image/svg+xml,x', 'https://user:password@images.test/a']) expect(() => renderKbImages(tag, kbImages(tag), new Map([[id, value]]))).toThrow('KB_IMAGE_DISPLAY_URL_INVALID');
  });
});
