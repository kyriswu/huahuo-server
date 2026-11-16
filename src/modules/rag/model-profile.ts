/** One embedding space per Note collection. A profile change requires rebuilding
 * the derived index; vectors from different models must never be mixed. */
export const NOTE_EMBEDDING_MODEL = 'qwen3.7-text-embedding-flash';
export const NOTE_EMBEDDING_DIMENSIONS = 1024;
export const NOTE_EMBEDDING_PROFILE = 'qwen3.7-text-embedding-flash-1024-fp16';
export const NOTE_EMBEDDING_MAX_INPUT_TOKENS = 128_000;
export const NOTE_EMBEDDING_MAX_BATCH_SIZE = 20;
export const NOTE_RERANK_MODEL = 'qwen3.7-text-rerank';
