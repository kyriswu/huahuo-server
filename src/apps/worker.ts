import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { AppConfig } from '../config/config.js';
import { RagIngestionJobs } from '../modules/rag/jobs.js';
import { storageFor } from '../modules/storage/port.js';
import { TaskWorkers } from '../modules/tasks/queue.js';
import type { TaskMetrics } from '../plugins/metrics.js';

export function createTaskWorkers(pool: pg.Pool, config: AppConfig, metrics?: TaskMetrics, logger?: FastifyBaseLogger) {
  const rag = new RagIngestionJobs(pool, config, storageFor(config));
  return new TaskWorkers(pool, config, rag, metrics, logger);
}
