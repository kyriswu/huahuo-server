import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const examples = ['.env.example', '.env.compose.local.example', '.env.compose.cloud.example', '.env.host.example',
  'specs/backend-plan/examples/.env.compose.local.example', 'specs/backend-plan/examples/.env.compose.cloud.example'];
const contract = {
  RAG_EMBEDDING_MODEL: 'BAAI/bge-m3', RAG_EMBEDDING_DIMENSIONS: '1024', RAG_EMBEDDING_PROFILE: 'bge-m3-1024',
  RAG_TOKENIZER_PATH: 'resources/tokenizers/bge-m3/tokenizer.json',
  RAG_TOKENIZER_CONFIG_PATH: 'resources/tokenizers/bge-m3/tokenizer_config.json', RAG_TOKENIZER_MAX_INPUT_TOKENS: '8192',
  KB_NOTE_INDEXING_ENABLED: 'true', KB_NOTE_HYBRID_COLLECTION: 'huahuo_kb_note_hybrid_chunks',
  KB_DOCUMENT_KEYWORD_COLLECTION: 'huahuo_kb_keyword_chunks', MILVUS_SEARCH_CONCURRENCY: '50',
};
describe('knowledge deployment configuration contract', () => {
  it.each(examples)('%s uses the same model, tokenizer and business targets', file => {
    const entries = readFileSync(file, 'utf8').split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] as const;
    });
    const env = Object.fromEntries(entries);
    for (const [key, value] of Object.entries(contract)) {
      expect(env[key], key).toBe(value);
      expect(entries.filter(([name]) => name === key), key).toHaveLength(1);
    }
    expect(Object.keys(env).some(key => key === 'MILVUS_COLLECTION' || key === 'RAG_INDEX_BUILD_ID'
      || key === 'RAG_EMBEDDING_SEND_DIMENSIONS' || key.startsWith('MANUAL_TEXT_') || key.startsWith('RAG_CHILD_'))).toBe(false);
  });
});
