import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/config.js';

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']);
const taskKinds = new Set(['demo.digest', 'maintenance.check', 'storage.delete', 'asset.tag-extract',
  'kb.note-index', 'kb.note-cleanup', 'rag.document-ingest', 'rag.toc-refresh', 'rag.document-cleanup',
  'text.ingest', 'processing.node-start']);
const excluded = new Set(['/metrics', '/health/live', '/health/ready']);
export type TaskResult = 'success' | 'failure';
export interface TaskMetrics { recordTaskAttempt(kind: string, result: TaskResult): void; }

/** One registry per running role, shared by its HTTP hooks and every BullMQ consumer. */
export class ApplicationMetrics implements TaskMetrics {
  readonly registry = new Registry();
  private readonly requests: Counter<'method' | 'route' | 'status'>;
  private readonly duration: Histogram<'method' | 'route'>;
  private readonly tasks: Counter<'kind' | 'result'>;
  private readonly recoveryFailures: Counter;
  constructor(config: Pick<AppConfig, 'appEnv' | 'role' | 'metrics'>) {
    this.registry.setDefaultLabels({ env: config.appEnv === 'production' ? 'prod' : config.appEnv, service: config.metrics.service, role: config.role });
    this.requests = new Counter({ name: 'http_requests_total', help: 'Completed HTTP responses by final status.',
      labelNames: ['method', 'route', 'status'], registers: [this.registry] });
    this.duration = new Histogram({ name: 'http_request_duration_seconds', help: 'HTTP response completion time in seconds.',
      labelNames: ['method', 'route'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900, 3600], registers: [this.registry] });
    this.tasks = new Counter({ name: 'task_processing_attempts_total',
      help: 'Committed task processing attempt results; deferred and unknown external outcomes excluded.',
      labelNames: ['kind', 'result'], registers: [this.registry] });
    this.recoveryFailures = new Counter({ name: 'task_recovery_failures_total',
      help: 'Task recovery invariant failures; the affected task remains unchanged for investigation.', registers: [this.registry] });
    new Gauge({ name: 'application_info', help: 'Running application role and environment.', registers: [this.registry] }).set(1);
  }
  recordHttp(method: string, route: string, status: number, seconds: number) {
    const labels = { method: methods.has(method) ? method : 'OTHER', route };
    this.requests.inc({ ...labels, status: String(status) });
    this.duration.observe(labels, seconds);
  }
  recordTaskAttempt(kind: string, result: TaskResult) {
    this.tasks.inc({ kind: taskKinds.has(kind) ? kind : 'other', result });
  }
  recordTaskRecoveryFailures(count: number) { this.recoveryFailures.inc(count); }
}

declare module 'fastify' { interface FastifyInstance { metrics: ApplicationMetrics; } }

export function registerMetrics(app: FastifyInstance, config: AppConfig, metrics = new ApplicationMetrics(config)) {
  app.decorate('metrics', metrics);
  if (!config.metrics.enabled) return;
  const starts = new WeakMap<FastifyRequest, bigint>();
  app.addHook('onRequest', async request => {
    const path = request.routeOptions.url ?? request.url.split('?')[0]!;
    if (!excluded.has(path)) starts.set(request, process.hrtime.bigint());
  });
  app.addHook('onResponse', async (request, reply) => {
    const start = starts.get(request);
    starts.delete(request);
    // Fastify also runs onResponse on socket errors; only finished responses count.
    if (start === undefined || !reply.raw.writableFinished) return;
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
