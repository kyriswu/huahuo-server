import { describe, expect, it } from 'vitest';
import { buildMineruContentBindingsFromAssets } from '../../src/modules/rag/mineru-bindings.js';

describe('MinerU image/content bindings', () => {
  it('rewrites references to stable asset refs and injects upstream OCR/caption once', () => {
    const result = buildMineruContentBindingsFromAssets({
      rawMarkdown: '# Cover\n\n![poster](./images/abc123.jpg)\n\n已有标题',
      assets: [
        { sourcePath: 'images/abc123.jpg', bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' },
        { sourcePath: 'images/unreferenced.png', bytes: new Uint8Array([4]), mimeType: 'image/png' },
      ],
      contentListV2: [{ type: 'image', image_source: { path: 'images/abc123.jpg' }, caption: '活动海报' }],
      model: [{ image_path: 'images/abc123.jpg', ocr_text: '报名截止 12 月 1 日' }],
    });
    expect(result.canonicalMarkdown).toContain('asset://images/abc123.jpg');
    expect(result.canonicalMarkdown).toContain('报名截止 12 月 1 日');
    expect(result.canonicalMarkdown).toContain('图片描述：活动海报');
    expect(result.assets.map((asset) => asset.sourceAssetKey)).toEqual(['images/abc123.jpg', 'images/unreferenced.png']);
    expect(result.diagnostics.orphanAssets).toEqual(['images/unreferenced.png']);
    expect(result.canonicalMarkdown.match(/报名截止 12 月 1 日/g)?.length).toBe(1);
  });

  it('keeps OCR without a reliable image binding and reports missing references', () => {
    const result = buildMineruContentBindingsFromAssets({
      rawMarkdown: '![missing](images/missing.jpg)',
      assets: [],
      model: [{ ocr_text: '页面上的文字', page_index: 2 }],
    });
    expect(result.diagnostics.missingRefs).toEqual(['images/missing.jpg']);
    expect(result.diagnostics.unresolvedOcr).toEqual([{ text: '页面上的文字', pageNo: 3 }]);
    expect(result.canonicalMarkdown).toContain('页面上的文字');
  });

  it('rejects traversal paths instead of matching by basename', () => {
    const result = buildMineruContentBindingsFromAssets({
      rawMarkdown: '![bad](../images/a.jpg)',
      assets: [{ sourcePath: 'images/a.jpg', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' }],
    });
    expect(result.diagnostics.missingRefs).toEqual(['../images/a.jpg']);
    expect(result.canonicalMarkdown).toContain('../images/a.jpg');
  });
});
