import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { kbImages } from '../../src/lib/kb-images.js';
import { renderEditableKbImages } from '../../src/lib/kb-image-markdown.js';
import { inputImages } from '../../src/lib/markdown-images.js';

const id = '12345678-1234-4234-8234-123456789abc';
const link = `https://media.test/${id}?Expires=1&Signature=a%2Fb%3D`;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const render = (source: string) => renderEditableKbImages(source, kbImages(source), new Map([[id, link]]));

describe('editable standard Markdown image view', () => {
  it('preserves the signed request URL and identifies the original OCR node in a fragment', () => {
    const tag = `<KBIMAGE uuid="${id}" page="2" alt="图"><![CDATA[private OCR]]></KBIMAGE>`;
    const content = `😀 before\r\n${tag}\r\nafter`, view = render(content);
    expect(view).toBe(`😀 before\r\n![图](<${link}#kbimage=${sha(tag)}>)\r\nafter`);
    expect(view).not.toContain('private OCR');
    const image = inputImages(view)[0]!, url = new URL(image.url);
    expect(url.search).toBe(new URL(link).search);
    expect(url.hash).toBe('#kbimage=' + sha(tag));
    expect(image.alt).toBe('图');
  });
  it('round-trips punctuation, entities and quotes in alt and title through standard Markdown', () => {
    const content = `<KBIMAGE uuid="${id}" alt="a[图] &amp; &lt;tag&gt; \\ *星* _字_ ~~字~~ |列" title="a &quot;quote&quot; &amp; \\ [title]" />`;
    const image = inputImages(render(content))[0]!;
    expect(image.alt).toBe('a[图] & <tag> \\ *星* _字_ ~~字~~ |列');
    expect(image.title).toBe('a "quote" & \\ [title]');
  });
  it('distinguishes multiple OCR nodes sharing a resource UUID', () => {
    const first = `<KBIMAGE uuid="${id}" page="1">first</KBIMAGE>`, second = `<KBIMAGE uuid="${id}" page="2">second</KBIMAGE>`;
    const images = inputImages(render(`${first}\n\n${second}`));
    expect(images.map(image => new URL(image.url).hash)).toEqual(['#kbimage=' + sha(first), '#kbimage=' + sha(second)]);
  });
  it('uses standard HTML in raw HTML tables and preserves safe dimensions', () => {
    const content = `<table><tr><td><KBIMAGE uuid="${id}" alt="图" width="40" height="30" /></td></tr></table>`;
    const view = render(content);
    expect(view).toMatch(/^<table><tr><td><img src=/u);
    expect(view).toContain(' width="40" height="30"');
    expect(inputImages(view)[0]).toMatchObject({ alt: '图', width: '40', height: '30' });
  });
  it('does not expose arbitrary canonical attributes or unsafe links', () => {
    const content = `<KBIMAGE uuid="${id}" alt="&lt;script&gt;" onerror="alert(1)" width="calc(1)" />`;
    expect(render(content)).not.toMatch(/onerror|calc\(1\)|<script>/u);
    expect(() => renderEditableKbImages(content, kbImages(content), new Map([[id, 'javascript:alert(1)']]))).toThrow('KB_IMAGE_DISPLAY_URL_INVALID');
    expect(() => renderEditableKbImages(content, kbImages(content), new Map())).toThrow('KB_IMAGE_DISPLAY_URL_REQUIRED');
  });
});
