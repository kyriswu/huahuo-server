import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { AppConfig } from '../config/config.js';
import { createFunAsrCompute } from '../integrations/funasr-compute/index.js';
import { FunAsrClient } from '../integrations/funasr/client.js';
import { BillingService } from '../modules/billing/service.js';
import { ContentAssetService } from '../modules/content-assets/service.js';
import { FunAsrJobs } from '../modules/funasr/jobs.js';
import { FunAsrStore } from '../modules/funasr/store.js';
import { RagIngestionJobs } from '../modules/rag/jobs.js';
import { storageFor } from '../modules/storage/port.js';
import { TaskWorkers } from '../modules/tasks/queue.js';
import type { TaskMetrics } from '../plugins/metrics.js';

export function createTaskWorkers(pool: pg.Pool, config: AppConfig, metrics?: TaskMetrics, logger?: FastifyBaseLogger) {
  const storage = storageFor(config);
  const rag = new RagIngestionJobs(pool, config, storage);
  const settings = config.funAsr?.role === 'worker' ? config.funAsr : undefined;
  const compute = settings && createFunAsrCompute(settings.compute);
  const asr = settings && compute ? new FunAsrJobs(pool, settings, compute,
    new FunAsrClient({ apiToken: settings.apiToken, uploadTimeoutMs: settings.uploadTimeoutMs }),
    storage, config.storageDriver, config.storageAliyunOss?.bucket ?? config.storageS3?.bucket,
    new FunAsrStore(pool, new ContentAssetService(pool, config.appTokenSecret ?? '', config)), new BillingService(pool, config)) : undefined;
  return new TaskWorkers(pool, config, rag, metrics, logger, asr);
}
