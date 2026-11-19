/** One embedding space per content asset collection. A profile change requires rebuilding
 * the derived index; vectors from different models must never be mixed. */
export const CONTENT_ASSET_EMBEDDING_MODEL = 'qwen3.7-text-embedding-flash';
export const CONTENT_ASSET_EMBEDDING_DIMENSIONS = 1024;
export const CONTENT_ASSET_EMBEDDING_PROFILE = 'qwen3.7-text-embedding-flash-1024-fp16';
export const CONTENT_ASSET_EMBEDDING_MAX_INPUT_TOKENS = 128_000;
export const CONTENT_ASSET_EMBEDDING_MAX_BATCH_SIZE = 20;
export const CONTENT_ASSET_RERANK_MODEL = 'qwen3.7-text-rerank';
