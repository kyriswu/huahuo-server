import { describe, expect, it } from 'vitest';
import { DocumentParseError, parseDocument } from '../../../src/modules/ingestion/document-parser.js';

describe('document parser boundary', () => {
  it('accepts markdown bytes and preserves parser metadata', async () => {
    const result = await parseDocument({
      content: new TextEncoder().encode('# Title\n\n正文'),
      fileName: 'guide.md',
      title: 'Guide',
    });
    expect(result).toMatchObject({
      content: '# Title\n\n正文',
      format: 'markdown',
      parserVersion: 'markdown-text',
      title: 'Guide',
    });
  });

  it('rejects unsupported binary formats before indexing', async () => {
    await expect(parseDocument({ content: new Uint8Array([0, 1, 2]), mimeType: 'application/pdf' }))
      .rejects.toBeInstanceOf(DocumentParseError);
  });
});
