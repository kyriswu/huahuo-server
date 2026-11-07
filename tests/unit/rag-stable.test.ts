import { describe, expect, it } from 'vitest';
import {
  documentKeyForVersion,
  embeddingProfileFor,
  indexBuildIdForVersion,
} from '../../src/modules/rag/stable.js';
import {fileChunkKey} from '../../src/modules/rag/processing-profile.js';

describe('RAG stable identifiers', () => {
  it('derives profile names from model and dimensions', () => {
    expect(embeddingProfileFor('Qwen/Qwen3-Embedding-8B', 4096)).toBe('qwen3-embedding-8b-4096');
    expect(embeddingProfileFor('BAAI/bge-m3', 1024)).toBe('bge-m3-1024');
  });

  it('keeps whole-source, revision and processing profile keys deterministic', () => {
    const documentKey = documentKeyForVersion('version-001');
    const profile = embeddingProfileFor('Qwen/Qwen3-Embedding-8B', 4096);
    expect(documentKey).toBe('version-001');
    expect(indexBuildIdForVersion(documentKey, profile)).toBe('version-001-qwen3-embedding-8b-4096');
    const key=fileChunkKey(documentKey,'body-r1','split-v3',3);
    expect(key).toBe(fileChunkKey(documentKey,'body-r1','split-v3',3));
    expect(key).not.toBe(fileChunkKey(documentKey,'body-r2','split-v3',3));
    expect(key).not.toBe(fileChunkKey(documentKey,'body-r1','other-profile',3));
    expect(key).not.toBe(fileChunkKey('other-source','body-r1','split-v3',3));
  });
});
