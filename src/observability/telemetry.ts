import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { context, trace, ROOT_CONTEXT, SpanKind, SpanStatusCode, isSpanContextValid,
  defaultTextMapGetter, defaultTextMapSetter, type Attributes, type SpanContext, type Span } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator, type ExportResult } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { TracerProvider, BatchSpanProcessor, ParentBasedSampler, AlwaysOnSampler,
  type SpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { AppConfig } from '../config/config.js';
import { telemetryIdentity, packageVersion, type TelemetryIdentity } from './identity.js';

export interface TraceCarrier { traceparent?: string; tracestate?: string; }
export type TelemetryAttributes = Record<string, string | number | boolean | undefined>;
const runtimes = new AsyncLocalStorage<ApplicationTelemetry>();
const propagator = new W3CTraceContextPropagator();
const manager = new AsyncLocalStorageContextManager().enable();
if (!context.setGlobalContextManager(manager)) manager.disable();
let defaultRuntime: ApplicationTelemetry | undefined;

const attributeKeys = new Set(['component', 'dependency', 'operation', 'outcome', 'traffic', 'error.type',
  'http.request.method', 'http.response.status_code', 'http.route', 'task.kind', 'task.queue', 'task.attempt',
  'task.state', 'task.result', 'task.continuation', 'task.resume_count', 'retry.attempt', 'retry.count',
  'rag.stage', 'rag.mode', 'rag.source_type', 'provider', 'model', 'stream.kind', 'stream.outcome', 'stream.events']);
function safeAttributes(input: Attributes | TelemetryAttributes): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(input)) {
    if (!attributeKeys.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') result[key] = value;
    else if (typeof value === 'string' && (key === 'http.route'
      ? /^(?:\/[A-Za-z0-9_/:.*-]{0,254}|unmatched)$/.test(value)
      : /^[A-Za-z0-9_.:-]{1,96}$/.test(value))) result[key] = value;
  }
  return result;
}
const safeName = (name: string) => /^[a-z][a-z0-9._-]{0,63}$/.test(name) ? name : 'operation';
const cleanContext = (value: SpanContext): SpanContext => ({ traceId: value.traceId, spanId: value.spanId, traceFlags: value.traceFlags });

/** Export only our explicit telemetry schema, including for injected SDK exporters.
 * Never export exception text, events, links, baggage or vendor tracestate. */
class SafeExporter implements SpanExporter {
  constructor(private readonly exporter: SpanExporter) {}
  export(spans: ReadableSpan[], callback: (result: ExportResult) => void) {
    this.exporter.export(spans.map(span => ({ name: safeName(span.name), kind: span.kind,
      spanContext: () => cleanContext(span.spanContext()),
      parentSpanContext: span.parentSpanContext ? cleanContext(span.parentSpanContext) : undefined,
      startTime: span.startTime, endTime: span.endTime, duration: span.duration, ended: span.ended,
      status: { code: span.status.code }, attributes: safeAttributes(span.attributes), links: [], events: [],
      resource: span.resource, instrumentationScope: { name: 'huahuo-server', version: packageVersion },
      droppedAttributesCount: span.droppedAttributesCount, droppedEventsCount: span.droppedEventsCount,
      droppedLinksCount: span.droppedLinksCount })), callback);
  }
  shutdown() { return this.exporter.shutdown(); }
  forceFlush() { return this.exporter.forceFlush?.() ?? Promise.resolve(); }
}

function inputCarrier(value: unknown): TraceCarrier {
  if (!value || typeof value !== 'object') return {};
  try {
    const candidate = value as Record<string, unknown>;
    return { ...(typeof candidate.traceparent === 'string' && candidate.traceparent.length <= 512 ? { traceparent: candidate.traceparent } : {}),
      ...(typeof candidate.tracestate === 'string' && candidate.tracestate.length <= 512 ? { tracestate: candidate.tracestate } : {}) };
  } catch { return {}; }
}
export function normalizeTraceContext(carrier: unknown): TraceCarrier {
  const result: TraceCarrier = {};
  propagator.inject(propagator.extract(ROOT_CONTEXT, inputCarrier(carrier), defaultTextMapGetter), result, defaultTextMapSetter);
  return result;
}
export function captureTraceContext(): TraceCarrier {
  const result: TraceCarrier = {};
  propagator.inject(context.active(), result, defaultTextMapSetter);
  return result;
}
export function withTraceContext<T>(carrier: unknown, operation: () => T): T {
  return context.with(propagator.extract(ROOT_CONTEXT, normalizeTraceContext(carrier), defaultTextMapGetter), operation);
}
export function currentTelemetryFields(): { trace_id?: string; span_id?: string } {
  const active = trace.getSpanContext(context.active());
  return active && isSpanContextValid(active) ? { trace_id: active.traceId, span_id: active.spanId } : {};
}
export function withTelemetryRuntime<T>(runtime: ApplicationTelemetry, operation: () => T): T { return runtimes.run(runtime, operation); }

export interface TelemetryOperation {
  run<T>(operation: () => T): T;
  end(attributes?: TelemetryAttributes, failed?: boolean): void;
}

export class ApplicationTelemetry {
  readonly provider: TracerProvider;
  private readonly tracer;
  private closed?: Promise<void>;
  private logger?: { info(fields: Record<string, unknown>, message: string): unknown };
  constructor(readonly identity: TelemetryIdentity, options: { endpoint?: string; exporter?: SpanExporter } = {}) {
    const exporter = options.exporter ?? (options.endpoint ? new OTLPTraceExporter({ url: options.endpoint,
      headers: {}, timeoutMillis: 2000, concurrencyLimit: 1 }) : undefined);
    this.provider = new TracerProvider({ resource: resourceFromAttributes({ 'service.name': identity.service,
      'service.version': identity.version, 'service.instance.id': identity.service_instance_id,
      'deployment.environment.name': identity.env, 'huahuo.role': identity.role }),
      sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
      spanLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 256, eventCountLimit: 0, linkCountLimit: 0 },
      spanProcessors: exporter ? [new BatchSpanProcessor({ exporter: new SafeExporter(exporter), maxQueueSize: 512,
        maxExportBatchSize: 64, scheduledDelayMillis: 1000, exportTimeoutMillis: 2000 })] : [] });
    this.tracer = this.provider.getTracer('huahuo-server', packageVersion);
  }
  start(name: string, attributes: TelemetryAttributes = {}, kind = SpanKind.INTERNAL): TelemetryOperation {
    const parent = context.active();
    const span = this.tracer.startSpan(safeName(name), { kind, attributes: safeAttributes(attributes) }, parent);
    const active = trace.setSpan(parent, span);
    let ended = false;
    return {
      run: <T>(operation: () => T) => withTelemetryRuntime(this, () => context.with(active, operation)),
      end: (fields = {}, failed = false) => {
        if (ended) return; ended = true;
        span.setAttributes(safeAttributes(fields));
        if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      },
    };
  }
  setLogger(logger: { info(fields: Record<string, unknown>, message: string): unknown }) { this.logger = logger; }
  logClient(fields: { dependency: string; operation: string; method: string; status?: number; outcome: string; durationMs: number; traceId?: string }) {
    const { status, ...observation } = fields;
    try { this.logger?.info({ event: 'http.client.completed', ...observation, statusCode: status, ...currentTelemetryFields() }, 'Outbound request completed'); }
    catch { /* Logging cannot alter a provider result. */ }
  }
  shutdown(): Promise<void> {
    return this.closed ??= (async () => {
      await bounded(() => this.provider.forceFlush({ timeoutMillis: 1500 }), 1500);
      await bounded(() => this.provider.shutdown(), 1500);
      if (defaultRuntime === this) defaultRuntime = undefined;
    })();
  }
}
async function bounded(operation: () => Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([Promise.resolve().then(operation), new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
  catch { /* Telemetry must never turn a successful application shutdown into failure. */ }
  finally { if (timer) clearTimeout(timer); }
}
export function createApplicationTelemetry(config: AppConfig, options: { exporter?: SpanExporter } = {}) {
  const runtime = new ApplicationTelemetry(telemetryIdentity(config), { endpoint: config.telemetry.tracesEndpoint, ...options });
  defaultRuntime = runtime;
  return runtime;
}
function runtime() {
  return runtimes.getStore() ?? (defaultRuntime ??= new ApplicationTelemetry({ env: 'development', service: 'huahuo-server',
    role: 'standalone', version: packageVersion, service_instance_id: randomUUID() }));
}
export function startOperation(name: string, attributes: TelemetryAttributes = {}, kind = SpanKind.INTERNAL) {
  return runtime().start(name, attributes, kind);
}
export async function tracedOperation<T>(name: string, attributes: TelemetryAttributes, operation: () => Promise<T> | T): Promise<T> {
  const span = startOperation(name, attributes);
  return span.run(async () => {
    try { const result = await operation(); span.end({ outcome: 'success' }); return result; }
    catch (error) { span.end({ outcome: 'failure', 'error.type': 'operation_error' }, true); throw error; }
  });
}
export function setCurrentSpanAttributes(attributes: TelemetryAttributes): void { trace.getSpan(context.active())?.setAttributes(safeAttributes(attributes)); }
export function currentSpan(): Span | undefined { return trace.getSpan(context.active()); }
export function logClientObservation(fields: Parameters<ApplicationTelemetry['logClient']>[0]) { runtime().logClient(fields); }
