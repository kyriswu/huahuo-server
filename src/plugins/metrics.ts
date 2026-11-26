import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/config.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { telemetryIdentity } from '../observability/identity.js';

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']);
const taskKinds = new Set(['demo.digest', 'maintenance.check', 'storage.delete', 'content-asset.tag-extract',
  'kb.content-asset-index', 'kb.content-asset-cleanup', 'rag.document-ingest', 'rag.toc-refresh', 'rag.document-cleanup',
  'text.ingest', 'processing.node-start', 'content-asset.transcribe']);
const excluded = new Set(['/metrics', '/health/live', '/health/ready']);
const durationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900, 3600];
export type TaskResult = 'success' | 'failure';
export type ClientOutcome = 'success' | 'http_error' | 'business_error' | 'network_error' | 'timeout' | 'cancelled' | 'response_error';
export interface ClientObservation { dependency: string; operation: string; method: string; status?: number; outcome: ClientOutcome; seconds: number; }
export interface TaskMetrics {
  recordTaskAttempt(kind: string, result: TaskResult): void;
  recordTaskTerminal?(kind: string, state: 'succeeded' | 'failed' | 'cancelled', elapsedSeconds: number): void;
  observeTaskBacklog?(queue: string, values: { pendingCount: number; oldestWaitingSeconds: number }): void;
  recordOutbound?(observation: ClientObservation): void;
}
const metricContext = new AsyncLocalStorage<TaskMetrics | undefined>();
export const currentApplicationMetrics = () => metricContext.getStore();
export function withApplicationMetrics<T>(metrics: TaskMetrics | undefined, operation: () => T): T { return metrics ? metricContext.run(metrics, operation) : operation(); }
const known = (value: string, values: readonly string[]) => values.includes(value) ? value : 'other';
export const httpTraffic = (route: string) => route.startsWith('/internal/') ? 'internal' : route.startsWith('/admin') ? 'admin' : route.startsWith('/api/') ? 'public' : 'other';
export const httpOutcome = (status: number) => status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : status >= 300 ? 'redirect' : 'success';
export const clientDependency = (value?: string) => known(value ?? '', ['document_parser', 'embedding', 'rerank', 'processing_node', 'other']);
export const clientOperation = (value?: string) => known(value ?? '', ['extract', 'submit', 'job_status', 'job_result', 'cancel', 'ack', 'embed', 'rerank', 'health', 'other']);

/** One registry per running role, shared by its HTTP hooks and every BullMQ consumer. */
export class ApplicationMetrics implements TaskMetrics {
  readonly registry = new Registry();
  private readonly requests: Counter<'method' | 'route' | 'status' | 'outcome' | 'traffic'>;
  private readonly duration: Histogram<'method' | 'route' | 'status' | 'outcome' | 'traffic'>;
  private readonly aborted: Counter<'method' | 'route' | 'traffic' | 'reason'>;
  private readonly abortedDuration: Histogram<'method' | 'route' | 'traffic' | 'reason'>;
  private readonly tasks: Counter<'kind' | 'result'>;
  private readonly recoveryFailures: Counter;
  private readonly backlogObserved: Gauge<'queue'>;
  private readonly outbound: Counter<'dependency' | 'operation' | 'method' | 'status' | 'outcome'>;
  private readonly outboundDuration: Histogram<'dependency' | 'operation' | 'method' | 'status' | 'outcome'>;
  private readonly terminalTasks: Counter<'kind' | 'state'>;
  private readonly terminalDuration: Histogram<'kind' | 'state'>;
  private readonly pendingTasks: Gauge<'queue'>;
  private readonly oldestTask: Gauge<'queue'>;
  private readonly ragStage: Histogram<'stage'>;
  private readonly ragOperations: Counter<'operation' | 'outcome'>;
  private readonly ragDuration: Histogram<'operation' | 'outcome'>;
  private readonly ragFallback: Counter<'reason'>;
  private readonly streams: Counter<'kind' | 'outcome'>;
  private readonly streamDuration: Histogram<'kind' | 'outcome'>;
  private readonly streamFirstEvent: Histogram<'kind'>;
  private readonly streamEvents: Counter<'kind'>;
  constructor(config: Pick<AppConfig, 'appEnv' | 'role' | 'metrics' | 'instanceId' | 'telemetry'>) {
    const identity = telemetryIdentity(config);
    this.registry.setDefaultLabels({ env: identity.env, service: identity.service, role: identity.role });
    this.requests = new Counter({ name: 'http_requests_total', help: 'Completed HTTP responses by final status.',
      labelNames: ['method', 'route', 'status', 'outcome', 'traffic'], registers: [this.registry] });
    this.duration = new Histogram({ name: 'http_request_duration_seconds', help: 'HTTP response completion time in seconds.',
      labelNames: ['method', 'route', 'status', 'outcome', 'traffic'], buckets: durationBuckets, registers: [this.registry] });
    this.aborted = new Counter({ name: 'http_aborted_requests_total', help: 'Incomplete HTTP responses, excluded from completed responses.', labelNames: ['method', 'route', 'traffic', 'reason'], registers: [this.registry] });
    this.abortedDuration = new Histogram({ name: 'http_aborted_request_duration_seconds', help: 'Time until an incomplete HTTP response closes.', labelNames: ['method', 'route', 'traffic', 'reason'], buckets: durationBuckets, registers: [this.registry] });
    this.tasks = new Counter({ name: 'task_processing_attempts_total',
      help: 'Committed task processing attempt results; deferred and unknown external outcomes excluded.',
      labelNames: ['kind', 'result'], registers: [this.registry] });
    this.recoveryFailures = new Counter({ name: 'task_recovery_failures_total',
      help: 'Task recovery invariant failures; the affected task remains unchanged for investigation.', registers: [this.registry] });
    this.outbound = new Counter({ name: 'http_client_requests_total', help: 'Outbound transport calls, including calls cancelled before send and response consumption.', labelNames: ['dependency', 'operation', 'method', 'status', 'outcome'], registers: [this.registry] });
    this.outboundDuration = new Histogram({ name: 'http_client_request_duration_seconds', help: 'Outbound attempt duration through response body consumption.', labelNames: ['dependency', 'operation', 'method', 'status', 'outcome'], buckets: durationBuckets, registers: [this.registry] });
    this.terminalTasks = new Counter({ name: 'task_terminal_total', help: 'Committed terminal task transitions, distinct from processing attempts.', labelNames: ['kind', 'state'], registers: [this.registry] });
    this.terminalDuration = new Histogram({ name: 'task_terminal_duration_seconds', help: 'Task creation to committed terminal transition.', labelNames: ['kind', 'state'], buckets: [0.1, 1, 5, 15, 60, 300, 900, 3600, 14400, 86400], registers: [this.registry] });
    this.pendingTasks = new Gauge({ name: 'task_pending', help: 'Durable pending tasks observed per queue.', labelNames: ['queue'], registers: [this.registry] });
    this.oldestTask = new Gauge({ name: 'task_oldest_waiting_seconds', help: 'Oldest durable waiting task age, zero when empty.', labelNames: ['queue'], registers: [this.registry] });
    this.backlogObserved = new Gauge({ name: 'task_backlog_observed_timestamp_seconds', help: 'Wall-clock timestamp of the last successful durable queue snapshot.', labelNames: ['queue'], registers: [this.registry] });
    this.ragStage = new Histogram({ name: 'rag_stage_duration_seconds', help: 'RAG operation stage duration.', labelNames: ['stage'], buckets: durationBuckets, registers: [this.registry] });
    this.ragOperations = new Counter({ name: 'rag_operations_total', help: 'RAG business operations and embedding attempts.', labelNames: ['operation', 'outcome'], registers: [this.registry] });
    this.ragDuration = new Histogram({ name: 'rag_operation_duration_seconds', help: 'RAG business operation and embedding attempt duration.', labelNames: ['operation', 'outcome'], buckets: durationBuckets, registers: [this.registry] });
    this.ragFallback = new Counter({ name: 'rag_fallbacks_total', help: 'Rerank fallback decisions.', labelNames: ['reason'], registers: [this.registry] });
    this.streams = new Counter({ name: 'stream_sessions_total', help: 'Ended state-stream sessions by semantic terminal outcome.', labelNames: ['kind', 'outcome'], registers: [this.registry] });
    this.streamDuration = new Histogram({ name: 'stream_duration_seconds', help: 'State-stream connection lifetime.', labelNames: ['kind', 'outcome'], buckets: [...durationBuckets, 14400, 86400], registers: [this.registry] });
    this.streamFirstEvent = new Histogram({ name: 'stream_first_event_seconds', help: 'Time until the first state update is accepted by transport.', labelNames: ['kind'], buckets: durationBuckets, registers: [this.registry] });
    this.streamEvents = new Counter({ name: 'stream_events_total', help: 'State updates accepted by stream transport; excludes heartbeats.', labelNames: ['kind'], registers: [this.registry] });
    new Gauge({ name: 'application_info', help: 'Application identity; instance is service_instance_id, not the scrape target instance.', labelNames: ['version', 'service_instance_id'], registers: [this.registry] })
      .set({ version: identity.version, service_instance_id: identity.service_instance_id }, 1);
  }
  recordHttp(method: string, route: string, status: number, seconds: number) {
    const labels = { method: methods.has(method) ? method : 'OTHER', route, status: String(status), outcome: httpOutcome(status), traffic: httpTraffic(route) };
    this.requests.inc(labels);
    this.duration.observe(labels, seconds);
  }
  recordTaskAttempt(kind: string, result: TaskResult) {
    this.tasks.inc({ kind: taskKinds.has(kind) ? kind : 'other', result });
  }
  recordTaskRecoveryFailures(count: number) { this.recoveryFailures.inc(count); }
  recordHttpAbort(method: string, route: string, reason: string, seconds: number) {
    const labels = { method: methods.has(method) ? method : 'OTHER', route, traffic: httpTraffic(route), reason: known(reason, ['client_abort', 'connection_error', 'response_incomplete']) };
    this.aborted.inc(labels); this.abortedDuration.observe(labels, seconds);
  }
  recordOutbound(observation: ClientObservation) {
    const labels = { dependency: clientDependency(observation.dependency), operation: clientOperation(observation.operation),
      method: methods.has(observation.method) ? observation.method : 'OTHER', status: observation.status === undefined ? 'none' : String(observation.status), outcome: observation.outcome };
    this.outbound.inc(labels); this.outboundDuration.observe(labels, Math.max(0, observation.seconds));
  }
  recordTaskTerminal(kind: string, state: 'succeeded' | 'failed' | 'cancelled', elapsedSeconds: number) {
    const labels = { kind: taskKinds.has(kind) ? kind : 'other', state };
    this.terminalTasks.inc(labels); this.terminalDuration.observe(labels, Math.max(0, elapsedSeconds));
  }
  observeTaskBacklog(queue: string, values: { pendingCount: number; oldestWaitingSeconds: number }) {
    const labels = { queue: known(queue, ['content', 'ai', 'commercial', 'maintenance']) };
    this.pendingTasks.set(labels, Math.max(0, values.pendingCount)); this.oldestTask.set(labels, Math.max(0, values.oldestWaitingSeconds));
    this.backlogObserved.set(labels, Date.now() / 1000);
  }
  recordRagStage(stage: string, elapsedSeconds: number) { this.ragStage.observe({ stage: known(stage, ['auth', 'pg_scope', 'index_ready', 'embedding', 'index_search', 'pg_hydrate', 'rerank', 'pg_recheck']) }, Math.max(0, elapsedSeconds)); }
  recordRagOperation(operation: string, outcome: string, elapsedSeconds: number) {
    const labels = { operation: known(operation, ['content_asset_query', 'file_query', 'text_query', 'embedding_attempt']), outcome: known(outcome, ['success', 'failure']) };
    this.ragOperations.inc(labels); this.ragDuration.observe(labels, Math.max(0, elapsedSeconds));
  }
  recordRagFallback(reason: string) { this.ragFallback.inc({ reason: known(reason, ['timeout', 'error', 'invalid_response']) }); }
  recordStream(kind: string, outcome: string, durationSeconds: number, firstEventSeconds?: number, eventCount = 0) {
    const labels = { kind: known(kind, ['node_status', 'document_trial', 'state']), outcome: known(outcome, ['completed', 'client_abort', 'error', 'timeout', 'shutdown', 'backpressure', 'cancelled']) };
    this.streams.inc(labels); this.streamDuration.observe(labels, Math.max(0, durationSeconds));
    if (firstEventSeconds !== undefined) this.streamFirstEvent.observe({ kind: labels.kind }, Math.max(0, firstEventSeconds));
    this.streamEvents.inc({ kind: labels.kind }, Math.max(0, eventCount));
  }
}

declare module 'fastify' { interface FastifyInstance { metrics: ApplicationMetrics; } }

export function registerMetrics(app: FastifyInstance, config: AppConfig, metrics = new ApplicationMetrics(config)) {
  app.decorate('metrics', metrics);
  if (!config.metrics.enabled) return;
  const starts = new WeakMap<FastifyRequest, bigint>();
  const reasons = new WeakMap<FastifyRequest, string>();
  const recordAbort = (request: FastifyRequest) => {
    const start = starts.get(request); starts.delete(request);
    if (start !== undefined) metrics.recordHttpAbort(request.method, request.routeOptions.url ?? 'unmatched', reasons.get(request) ?? 'response_incomplete', Number(process.hrtime.bigint() - start) / 1e9);
    reasons.delete(request);
  };
  app.addHook('onRequest', async request => {
    const path = request.routeOptions.url ?? request.url.split('?')[0]!;
    if (!excluded.has(path)) starts.set(request, process.hrtime.bigint());
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!starts.has(request)) return;
    request.raw.once('aborted', () => { reasons.set(request, 'client_abort'); });
    reply.raw.once('error', () => { reasons.set(request, 'connection_error'); });
    reply.raw.once('close', () => {
      if (reply.raw.writableFinished) return;
      recordAbort(request);
    });
  });
  app.addHook('onResponse', async (request, reply) => {
    const start = starts.get(request);
    // Fastify also runs onResponse on socket errors; only finished responses count.
    if (start === undefined) return;
    if (!reply.raw.writableFinished) { recordAbort(request); return; }
    starts.delete(request); reasons.delete(request);
    metrics.recordHttp(request.method, request.routeOptions.url ?? 'unmatched', reply.raw.statusCode,
      Number(process.hrtime.bigint() - start) / 1e9);
  });
}

/** Dedicated scrape listener exposes no business or Admin routes. */
export async function listenMetrics(metrics: ApplicationMetrics, host: string, port: number): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url?.split('?')[0] !== '/metrics') {
      response.writeHead(404).end(); return;
    }
    void metrics.registry.metrics().then(body => {
      response.writeHead(200, { 'Content-Type': metrics.registry.contentType, 'Cache-Control': 'no-store' }).end(body);
    }).catch(() => { response.writeHead(500, { 'Content-Type': 'text/plain' }).end('Metrics unavailable\n'); });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port }, () => { server.off('error', reject); resolve(); });
  });
  return server;
}

export async function closeMetrics(server: Server) {
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
