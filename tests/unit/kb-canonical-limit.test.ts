import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { DOCUMENT_CANONICAL_MAX_BYTES } from '../../src/config/document-extraction.js';
import { sourceContent } from '../../src/modules/kb/repository.js';
import { digest } from '../../src/modules/kb/split.js';
import type { KbBuild } from '../../src/modules/kb/types.js';
import { storageFor } from '../../src/modules/storage/port.js';
import { config } from '../helpers.js';

vi.mock('../../src/modules/storage/port.js', () => ({ storageFor: vi.fn() }));

function fixture(content: string, stream = Readable.from([Buffer.from(content)])) {
  const hash = digest(content);
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('rag_ingestion_versions')
    ? [{ revision: hash, uri: 'extractions/canonical.md', deleted_at: null, active: true }] : [] }));
  const pool = { connect: async () => Object.assign(new EventEmitter(), { query, release: vi.fn() }) } as unknown as pg.Pool;
  const build = { source_type: 'file', source_id: 'source', source_revision: hash, user_id: 'user', workspace_id: 'workspace',
    content_hash: hash, snapshot: { format: 'markdown' } } as KbBuild;
  const read = vi.fn(async () => stream);
  vi.mocked(storageFor).mockReturnValue({ read } as unknown as ReturnType<typeof storageFor>);
  return { pool, build, stream, read };
}

describe('external canonical body bounds during index recovery', () => {
  it('loads only the committed canonical artifact and preserves its content hash', async () => {
    const content = '# 已提取正文\n\nUnicode 😀\n', f = fixture(content);
    await expect(sourceContent(f.pool, config(), f.build)).resolves.toMatchObject({ content, revision: digest(content), format: 'markdown' });
    expect(f.read).toHaveBeenCalledExactlyOnceWith('extractions/canonical.md');
    expect(f.stream.destroyed).toBe(true);
  });

  it('accepts the same 16MiB canonical limit as external result admission', async () => {
    expect(DOCUMENT_CANONICAL_MAX_BYTES).toBe(16 * 1024 * 1024);
    const content = 'x'.repeat(DOCUMENT_CANONICAL_MAX_BYTES), f = fixture(content);
    await expect(sourceContent(f.pool, config(), f.build)).resolves.toMatchObject({ revision: digest(content) });
    expect(f.stream.destroyed).toBe(true);
  });

  it('stops and closes an oversized artifact stream before hashing or indexing its body', async () => {
    const f = fixture('unused', Readable.from([Buffer.alloc(DOCUMENT_CANONICAL_MAX_BYTES), Buffer.from('x')]));
    await expect(sourceContent(f.pool, config(), f.build)).rejects.toThrow('KB_BODY_TOO_LARGE');
    expect(f.stream.destroyed).toBe(true);
  });
});
