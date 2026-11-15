import { Gauge } from '@prometheus-io/client';
import type { FastifyInstance } from 'fastify';

export type LifecyclePhase = 'serving' | 'draining' | 'closing' | 'closed';

/** Draining withdraws readiness without closing HTTP connections. Routing is external. */
export class ApplicationLifecycle {
  phase: LifecyclePhase = 'serving';
  activeRequests = 0;
  private readonly hooks: Array<() => void | Promise<void>> = [];
  private draining?: Promise<void>;
  onDrain(hook: () => void | Promise<void>) {
    if (this.phase !== 'serving') throw new Error('DRAIN_ALREADY_STARTED');
    this.hooks.push(hook);
  }
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    if (this.phase === 'serving') this.phase = 'draining';
    // Run every stop-admission hook immediately, before waiting for any of them.
    this.draining = Promise.all(this.hooks.map(hook => {
      try { return Promise.resolve(hook()); } catch (error) { return Promise.reject(error); }
    })).then(() => undefined);
    return this.draining;
  }
  async close() { this.phase = 'closing'; await this.drain(); }
}

declare module 'fastify' { interface FastifyInstance { lifecycle: ApplicationLifecycle; } }

export function registerLifecycle(app: FastifyInstance, backgroundActive: () => number = () => 0) {
  const lifecycle = new ApplicationLifecycle();
  app.decorate('lifecycle', lifecycle);
  new Gauge({ name: 'application_draining', help: 'One when this instance is withdrawing or closing.',
    registers: [app.metrics.registry], collect() { this.set(lifecycle.phase === 'serving' ? 0 : 1); } });
  new Gauge({ name: 'http_requests_in_flight', help: 'Open business HTTP responses, including streams; excludes health and metrics probes.',
    registers: [app.metrics.registry], collect() { this.set(lifecycle.activeRequests); } });
  new Gauge({ name: 'background_operations_in_flight', help: 'Local active processors or scheduler scans; excludes durably deferred remote work.',
    registers: [app.metrics.registry], collect() { this.set(backgroundActive()); } });
  app.addHook('onRequest', async (request, reply) => {
    if (['/health/live', '/health/ready', '/metrics'].includes(request.routeOptions.url ?? '')) return;
    lifecycle.activeRequests++;
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      lifecycle.activeRequests--;
      reply.raw.off('finish', finish);
      reply.raw.off('close', finish);
      // Reap sockets that became idle after server.close() began. Run after the
      // HTTP server has processed 'finish'; never terminate an active response.
      if (lifecycle.phase === 'closing') setImmediate(() => app.server.closeIdleConnections());
    };
    reply.raw.once('finish', finish);
    reply.raw.once('close', finish);
  });
  app.addHook('onSend', async (_request, reply) => {
    if (lifecycle.phase === 'closing') reply.header('Connection', 'close');
  });
  app.addHook('onClose', async () => { lifecycle.phase = 'closed'; });
  return lifecycle;
}
