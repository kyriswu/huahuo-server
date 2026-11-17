import { describe, expect, it } from 'vitest';
import { sha256 } from '../../src/modules/rag/chunkers.js';

describe('RAG content digest', () => {
  it('keeps deterministic content digests', () => {
    expect(sha256('same')).toBe(sha256('same'));
    expect(sha256('same')).toMatch(/^[0-9a-f]{64}$/u);
    expect(sha256('same')).not.toBe(sha256('different'));
  });
});
