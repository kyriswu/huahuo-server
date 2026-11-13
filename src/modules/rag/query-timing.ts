import { performance } from 'node:perf_hooks';
import type { EmbeddingAttempt } from './adapters/embedding.js';
import type { RerankFallback } from './search.js';

type Stage = 'auth' | 'pg_scope' | 'milvus_ready' | 'embedding' | 'milvus_search' | 'pg_hydrate' | 'rerank' | 'pg_recheck';

/** One per request; no query, content, user identifiers or credentials. */
export class NoteQueryTiming {
  private readonly started = performance.now();
  private readonly durations: Partial<Record<Stage, number>> = {};
  readonly embeddingAttempts: EmbeddingAttempt[] = [];
  fallback?: RerankFallback;
  fallbackTotal = 0;
  async measure<T>(stage: Stage, operation: () => Promise<T>): Promise<T> {
    const at = performance.now();
    try { return await operation(); }
    finally { this.durations[stage] = (this.durations[stage] ?? 0) + performance.now() - at; }
  }
  snapshot() {
    return { totalMs: performance.now() - this.started, stages: { ...this.durations }, embeddingAttempts: this.embeddingAttempts.map(attempt => ({ ...attempt })), rerankFallback: this.fallback ?? null, rerankFallbackTotal: this.fallbackTotal };
  }
  serverTiming(): string {
    return Object.entries(this.durations).map(([stage, duration]) => `${stage};dur=${duration.toFixed(2)}`).join(', ')
      + `, embedding_attempts;dur=${this.embeddingAttempts.length}, rerank_fallback;dur=${this.fallback ? 1 : 0}`;
  }
}
