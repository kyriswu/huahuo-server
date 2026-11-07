import { describe, expect, it } from 'vitest';
import { sha256, stableUuid } from '../../src/modules/rag/chunkers.js';

describe('RAG stable identity helpers', () => {
  it('keeps deterministic UUIDs and content digests without a Parent chunk model', () => {
    expect(stableUuid('same')).toBe(stableUuid('same'));
    expect(stableUuid('same')).not.toBe(stableUuid('different'));
    expect(stableUuid('same')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(sha256('same')).toMatch(/^[0-9a-f]{64}$/u);
    expect(sha256('same')).not.toBe(sha256('different'));
  });
});
