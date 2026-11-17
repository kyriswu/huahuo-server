import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inputImages, normalizeImageTags } from '../../src/lib/markdown-images.js';
import { kbImages } from '../../src/lib/kb-images.js';
import { restoreOwnedImageParts, type NormalizedImageParts } from '../../src/modules/storage/image-origins.js';

const id = '019b5312-70ab-7200-8951-45bd914c6daa';
const other = '019b5312-70ab-7200-8951-45bd914c6dab';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function prepare(source: string, resourceId = id): NormalizedImageParts {
  const images = inputImages(source), mapping = new Map(images.map(image => [image.url, resourceId]));
  return { parts: { raw: normalizeImageTags(source, images, mapping) }, imageOrigins: images.flatMap((image, ordinal) => image.kind === 'kbimage' ? [] : [{
    part: 'raw', ordinal, resourceId, format: image.kind, ...(image.sourceHash ? { hash: image.sourceHash } : {}),
  }]) };
}
const original = `<KBIMAGE page='2' alt="图" uuid="${id}" title='说明' width="100" role="chart > table"><![CDATA[OCR ![literal](https://example.test/image)]]></KBIMAGE>`;

describe('editable Markdown image metadata recovery', () => {
  it('recovers the complete original node from its fingerprint despite expired playback tokens', () => {
    const markdown = `before\n![图](https://notes.test/api/v1/media/resources/${id}/object?playbackToken=expired#kbimage=${hash(original)} "说明")\nafter`;
    const prepared = prepare(markdown);
    expect(prepared.parts.raw).not.toContain('playbackToken');
    expect(prepared.parts.raw).not.toContain('#kbimage');
    expect(prepared.imageOrigins).toEqual([{ part: 'raw', ordinal: 0, resourceId: id, hash: hash(original), format: 'markdown' }]);
    expect(restoreOwnedImageParts({ raw: original }, prepared).raw).toBe(`before\n${original}\nafter`);
    expect(prepare(markdown.replace('expired', 'refreshed'))).toEqual(prepared);
  });
  it('updates only presentation attributes while retaining metadata and OCR bytes', () => {
    const markdown = `![新图](asset://${id}#kbimage=${hash(original)} "新标题")`;
    const result = restoreOwnedImageParts({ raw: original }, prepare(markdown)).raw;
    expect(result).toBe(original.replace('alt="图"', 'alt="新图"').replace("title='说明'", 'title="新标题"'));
    const removedTitle = restoreOwnedImageParts({ raw: original }, prepare(`![图](asset://${id}#kbimage=${hash(original)})`)).raw;
    expect(removedTitle).toBe(original.replace(" title='说明'", ''));
  });
  it('lets HTML edit dimensions and safely escapes attributes without changing OCR', () => {
    const incoming = `<img src="asset://${id}#kbimage=${hash(original)}" alt="图" title="说明" width="42" height="30">`;
    const result = restoreOwnedImageParts({ raw: original }, prepare(incoming)).raw!;
    expect(result).toContain('width="42"'); expect(result).toContain('height="30"');
    expect(result).toContain('role="chart > table"');
    expect(result).toContain(`><![CDATA[OCR ![literal](https://example.test/image)]]></KBIMAGE>`);
    expect(kbImages(result)).toHaveLength(1);
  });
  it('uses exact fingerprints to preserve separate OCR for reordered copies of one resource', () => {
    const second = original.replace("page='2'", "page='7'").replace('OCR ![literal]', 'different OCR ![literal]');
    const incoming = `![图](asset://${id}#kbimage=${hash(second)} "说明")\n![图](asset://${id}#kbimage=${hash(original)} "说明")`;
    expect(restoreOwnedImageParts({ raw: `${original}\n${second}` }, prepare(incoming)).raw).toBe(`${second}\n${original}`);
  });
  it('recovers unmarked unique metadata and rejects ambiguity rather than dropping OCR', () => {
    expect(restoreOwnedImageParts({ raw: original }, prepare(`![图](asset://${id} "说明")`)).raw).toBe(original);
    const otherAlt = original.replace('alt="图"', "alt='别名'");
    expect(restoreOwnedImageParts({ raw: `${original}\n${otherAlt}` }, prepare(`![图](asset://${id} "说明")`)).raw).toBe(original);
    const different = original.replace('OCR ![literal]', 'different OCR ![literal]');
    expect(() => restoreOwnedImageParts({ raw: `${original}\n${different}` }, prepare(`![图](asset://${id})`))).toThrowError(expect.objectContaining({ code: 'NOTE_IMAGE_ORIGIN_AMBIGUOUS' }));
  });
  it('rejects unknown or mismatched fingerprints, including create with no source body', () => {
    const prepared = prepare(`![图](asset://${id}#kbimage=${hash(original)})`);
    expect(() => restoreOwnedImageParts({}, prepared)).toThrowError(expect.objectContaining({ code: 'NOTE_IMAGE_ORIGIN_NOT_FOUND' }));
    expect(() => restoreOwnedImageParts({ raw: original.replace('OCR', 'changed OCR') }, prepared)).toThrowError(expect.objectContaining({ code: 'NOTE_IMAGE_ORIGIN_NOT_FOUND' }));
    expect(() => restoreOwnedImageParts({ raw: original }, prepare(`![图](asset://${other}#kbimage=${hash(original)})`, other))).toThrowError(expect.objectContaining({ code: 'NOTE_IMAGE_ORIGIN_NOT_FOUND' }));
    expect(() => inputImages(`![图](asset://${id}#kbimage=malformed)`)).toThrow('MARKDOWN_IMAGE_ORIGIN_INVALID');
  });
  it('accepts ordinary new images and already canonical input without recovery', () => {
    const prepared = prepare(`![新图](asset://${id})`);
    expect(restoreOwnedImageParts({}, prepared)).toEqual(prepared.parts);
    expect(restoreOwnedImageParts({}, prepare(original)).raw).toBe(original);
  });
  it('retains boolean and quoted attributes when adding or deleting presentation fields', () => {
    const body = `<KBIMAGE uuid='${id}' alt role='a > b' page="1" />`;
    const result = restoreOwnedImageParts({ raw: body }, prepare(`![next](asset://${id} "a & b")`)).raw!;
    expect(result).toBe(`<KBIMAGE uuid='${id}' alt="next" role='a > b' page="1" title="a &amp; b" />`);
    expect(kbImages(result)).toHaveLength(1);
  });
});
