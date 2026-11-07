import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AppConfig } from '../../config/config.js';
import { DomainError } from '../identity/store.js';
import type { TokenCounter } from '../../lib/document-processing/types.js';
import { loadModelTokenizer } from '../../lib/document-processing/tokenizer.js';
import type { VectorTarget } from '../../lib/rag-indexing/index.js';
import { storeIdentity } from '../../plugins/store-identity.js';
import { vectorConnectionId } from '../rag/vector-store.js';

export const NOTE_CHUNK_TARGET_CHARS = 300;
export const NOTE_CHUNK_MAX_CHARS = 500;

export interface ManualTextSnapshot {
  profileVersion: 'manual-text';
  providerMode: 'live' | 'mock';
  sourceType: 'note';
  businessStore:string;
  parentId: string;
  sourceRevision: string;
  expectedNoteRevision: string;
  expectedRawRevision?: string;
  format: 'text' | 'markdown';
  chunkProfile: string;
  split: { targetTokens: number; maxEmbeddingTokens: number; overlapTokens: number; targetSourceChars: number; maxSourceChars: number; respectSections: true };
  tokenizer: { model: string; path: string; configPath: string; maxInputTokens: number; sha256?: string; configSha256?: string };
  embedding: { model: string; dimensions: number; profile: string; baseUrl?: string };
  vectorTarget: VectorTarget;
  indexing: { batchSize: number; concurrency: number; timeoutMs: number; maxRetries: number };
}

export function manualTextSnapshot(config: AppConfig, input: { parentId: string; revision: string; expectedNoteRevision: string; expectedRawRevision?: string; format: 'text' | 'markdown'; maxTokens?: number; overlapTokens?: number; pipelineVersion?: string }): ManualTextSnapshot {
  if (!config.manualText.enabled || !config.manualText.collection || !config.manualText.database) throw new DomainError(503, 'MANUAL_TEXT_TARGET_NOT_CONFIGURED');
  if (config.rag.providerMode === 'disabled') throw new DomainError(503, 'RAG_INGESTION_DISABLED');
  if (config.rag.embeddingBaseUrl) {
    try {
      const endpoint = new URL(config.rag.embeddingBaseUrl);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('invalid');
    } catch { throw new DomainError(503, 'INGEST_EMBEDDING_TARGET_INVALID'); }
  }
  if (config.rag.providerMode !== 'mock' && (!config.rag.tokenizerPath || !config.rag.tokenizerConfigPath)) throw new DomainError(503, 'INGEST_TOKENIZER_UNAVAILABLE');
  const maxEmbeddingTokens = input.maxTokens ?? config.manualText.maxEmbeddingTokens;
  const targetTokens = Math.min(config.manualText.targetTokens, maxEmbeddingTokens);
  const overlapTokens = input.overlapTokens ?? Math.min(config.manualText.overlapTokens, targetTokens - 1);
  if (!Number.isInteger(maxEmbeddingTokens) || !Number.isInteger(overlapTokens) || maxEmbeddingTokens < 1 || maxEmbeddingTokens > config.rag.tokenizerMaxInputTokens || overlapTokens < 0 || overlapTokens >= targetTokens) throw new DomainError(400, 'INGEST_CHUNK_OPTIONS_INVALID');
  const snapshot: ManualTextSnapshot = {
    profileVersion: 'manual-text', providerMode: config.rag.providerMode, sourceType: 'note', businessStore:storeIdentity(config.databaseUrl), parentId: input.parentId, sourceRevision: input.revision, expectedNoteRevision: input.expectedNoteRevision, ...(input.expectedRawRevision ? { expectedRawRevision: input.expectedRawRevision } : {}), format: input.format,
    chunkProfile: input.pipelineVersion ?? 'manual-text',
    split: { targetTokens, maxEmbeddingTokens, overlapTokens, targetSourceChars: NOTE_CHUNK_TARGET_CHARS, maxSourceChars: NOTE_CHUNK_MAX_CHARS, respectSections: true },
    tokenizer: { model: config.rag.embeddingModel, path: config.rag.tokenizerPath ?? '', configPath: config.rag.tokenizerConfigPath ?? '', maxInputTokens: config.rag.tokenizerMaxInputTokens },
    embedding: { model: config.rag.embeddingModel, dimensions: config.rag.embeddingDimensions, profile: config.rag.embeddingProfile, ...(config.rag.embeddingBaseUrl ? { baseUrl: config.rag.embeddingBaseUrl } : {}) },
    vectorTarget: { connectionId: vectorConnectionId(config), database: config.manualText.database, collection: config.manualText.collection },
    indexing: { batchSize: config.rag.embeddingBatchSize, concurrency: config.rag.indexingConcurrency, timeoutMs: config.rag.embeddingTimeoutMs, maxRetries: config.rag.embeddingMaxRetries },
  };
  if (snapshot.providerMode === 'live') {
    try { snapshot.tokenizer.sha256 = createHash('sha256').update(readFileSync(snapshot.tokenizer.path)).digest('hex'); snapshot.tokenizer.configSha256=createHash('sha256').update(readFileSync(snapshot.tokenizer.configPath)).digest('hex'); }
    catch { throw new DomainError(503, 'INGEST_TOKENIZER_UNAVAILABLE'); }
  }
  // Configuration is part of the immutable build identity, not a mutable default.
  snapshot.chunkProfile = `${snapshot.chunkProfile.slice(0, 42)}-${createHash('sha256').update(JSON.stringify({ format: snapshot.format, split: snapshot.split, tokenizer: snapshot.tokenizer, embedding: snapshot.embedding, target: snapshot.vectorTarget })).digest('hex').slice(0, 12)}`;
  return snapshot;
}

export async function manualTokenizer(config: AppConfig, snapshot: ManualTextSnapshot): Promise<TokenCounter> {
  if(snapshot.businessStore!==storeIdentity(config.databaseUrl))throw new DomainError(503,'INGEST_BUSINESS_STORE_CHANGED');
  if (config.rag.providerMode !== snapshot.providerMode) throw new DomainError(503, 'INGEST_PROVIDER_CHANGED');
  if ((snapshot.embedding.baseUrl ?? '') !== (config.rag.embeddingBaseUrl ?? '')) throw new DomainError(503, 'INGEST_EMBEDDING_TARGET_CHANGED');
  if (config.rag.providerMode === 'mock' && config.appEnv !== 'production') return { id: 'explicit-test-codepoint-counter', model: snapshot.embedding.model, maxInputTokens: snapshot.tokenizer.maxInputTokens, count: text => Array.from(text).length };
  return loadModelTokenizer({ model: snapshot.tokenizer.model, tokenizerPath: snapshot.tokenizer.path, tokenizerConfigPath: snapshot.tokenizer.configPath, maxInputTokens: snapshot.tokenizer.maxInputTokens, expectedSha256: snapshot.tokenizer.sha256, expectedConfigSha256:snapshot.tokenizer.configSha256 });
}
