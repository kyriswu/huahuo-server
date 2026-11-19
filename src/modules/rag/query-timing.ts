import { performance } from 'node:perf_hooks';
import type { EmbeddingAttempt } from './adapters/embedding.js';
import type { RerankFallback } from './search.js';
import type { ApplicationMetrics } from '../../plugins/metrics.js';
import { tracedOperation } from '../../observability/telemetry.js';

export type QueryStage = 'auth' | 'pg_scope' | 'index_ready' | 'embedding' | 'index_search' | 'pg_hydrate' | 'rerank' | 'pg_recheck';
type QueryMetrics=Pick<ApplicationMetrics,'recordRagStage'|'recordRagOperation'|'recordRagFallback'>;

/** One per request; no query, content, user identifiers or credentials. */
export class ContentAssetQueryTiming {
  private readonly started = performance.now();
  private readonly durations: Partial<Record<QueryStage, number>> = {};
  readonly embeddingAttempts: EmbeddingAttempt[] = [];
  fallback?: RerankFallback;
  async measure<T>(stage: QueryStage, operation: () => Promise<T>): Promise<T> {
    const at = performance.now();
    try { return await tracedOperation('rag.stage',{'rag.stage':stage},operation); }
    finally { this.durations[stage] = (this.durations[stage] ?? 0) + performance.now() - at; }
  }
  snapshot() {
    return { totalMs: performance.now() - this.started, stages: { ...this.durations }, embeddingAttempts: this.embeddingAttempts.map(attempt => ({ ...attempt })), embeddingAttemptCount:this.embeddingAttempts.length,rerankFallback: this.fallback ?? null,rerankFallbackCount:this.fallback?1:0 };
  }
  serverTiming(): string {
    return [...Object.entries(this.durations).map(([stage, duration]) => `${stage};dur=${duration.toFixed(2)}`),
      `embedding_attempts;desc="${this.embeddingAttempts.length}"`,`rerank_fallback;desc="${this.fallback ? 1 : 0}"`].join(', ');
  }
  record(metrics:QueryMetrics,sourceType:string,statusCode:number):void{
    const snapshot=this.snapshot();
    try{
      metrics.recordRagOperation(`${sourceType}_query`,statusCode<400?'success':'failure',snapshot.totalMs/1000);
      for(const [stage,duration]of Object.entries(snapshot.stages))metrics.recordRagStage(stage,duration/1000);
      for(const attempt of this.embeddingAttempts)metrics.recordRagOperation('embedding_attempt',attempt.succeeded?'success':'failure',attempt.durationMs/1000);
      if(this.fallback)metrics.recordRagFallback(this.fallback);
    }catch{/* Observability must never change the completed query's response. */}
  }
}
