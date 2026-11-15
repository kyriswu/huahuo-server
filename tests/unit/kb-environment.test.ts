import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const examples = ['.env.example', '.env.compose.local.example', '.env.compose.cloud.example', '.env.host.example',
  'specs/backend-plan/examples/.env.compose.local.example', 'specs/backend-plan/examples/.env.compose.cloud.example'];
const contract = {
  RAG_EMBEDDING_MODEL: 'BAAI/bge-m3', RAG_EMBEDDING_DIMENSIONS: '1024', RAG_EMBEDDING_PROFILE: 'bge-m3-1024',
  RAG_TOKENIZER_PATH: 'resources/tokenizers/bge-m3/tokenizer.json',
  RAG_TOKENIZER_CONFIG_PATH: 'resources/tokenizers/bge-m3/tokenizer_config.json', RAG_TOKENIZER_MAX_INPUT_TOKENS: '8192',
  KB_NOTE_HYBRID_COLLECTION: 'huahuo_kb_note_hybrid_chunks',
  KB_DOCUMENT_KEYWORD_COLLECTION: 'huahuo_kb_keyword_chunks',
};
const retired = new Set(['BILLING_POLICY_VERSION','TAG_EXTRACTOR_PROVIDER','MAX_UPLOAD_BYTES','STORAGE_QUOTA_BYTES',
  'RAG_INGESTION_ENABLED','RAG_MAX_SOURCE_BYTES','RAG_DOWNLOAD_TIMEOUT_MS','TASK_MAX_ATTEMPTS',
  'TOOL_TOKEN_SECRET','INTERNAL_API_BASE_URL','TOOLS_PUBLIC_BASE_URL','MILVUS_BM25_ANALYZER',
  'MILVUS_SEARCH_CONCURRENCY','RAG_DENSE_CANDIDATES','RAG_BM25_CANDIDATES','RAG_HYBRID_CANDIDATES','RAG_RRF_K',
  'RAG_INGEST_BATCH_SIZE','RAG_INDEX_CONCURRENCY','RAG_EMBEDDING_TIMEOUT_MS','RAG_EMBEDDING_MAX_RETRIES',
  'RAG_RERANK_TIMEOUT_MS','RAG_NOTE_RERANK_BUDGET_MS','RAG_PLAIN_TEXT_MAX_CHARS','KB_NOTE_INDEXING_ENABLED']);
describe('knowledge deployment configuration contract', () => {
  it.each(examples)('%s uses the same model, tokenizer and business targets', file => {
    const entries = readFileSync(file, 'utf8').split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] as const;
    });
    const env = Object.fromEntries(entries);
    expect(new Set(entries.map(([key]) => key)).size, 'duplicate environment keys').toBe(entries.length);
    for (const [key, value] of Object.entries(contract)) {
      expect(env[key], key).toBe(value);
      expect(entries.filter(([name]) => name === key), key).toHaveLength(1);
    }
    expect(Object.keys(env).some(key => key === 'MILVUS_COLLECTION' || key === 'RAG_INDEX_BUILD_ID'
      || key === 'RAG_EMBEDDING_SEND_DIMENSIONS' || retired.has(key)
      || /^(?:MANUAL_TEXT_|RAG_CHILD_|RAG_PARENT_|DOCUMENT_PARSER_|DOCUMENT_EXTRACTION_|TASK_RETRY_|WORKER_CONCURRENCY_)/.test(key))).toBe(false);
  });
});
