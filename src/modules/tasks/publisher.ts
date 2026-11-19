import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { AppConfig } from '../../config/config.js';
import { queues, type QueueName } from './model.js';
import type { Delivery, TaskPublisher } from './scheduler.js';

// Scheduler publishes deliveries without loading Worker execution dependencies.
export class QueuePublisher implements TaskPublisher {
  readonly connection: Redis;
  readonly queues: Map<QueueName, Queue>;

  constructor(config: AppConfig) {
    this.connection = new Redis(config.redisQueueUrl, {
      maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 1500, commandTimeout: 2000,
    });
    this.connection.on('error', () => undefined);
    this.queues = new Map(queues.map(name => {
      const queue = new Queue(name, { connection: this.connection, prefix: config.queuePrefix });
      queue.on('error', () => undefined);
      return [name, queue];
    }));
  }

  async publish(delivery: Delivery) {
    const queue = this.queues.get(delivery.queue)!;
    const existing = await queue.getJob(delivery.id);
    if (existing) {
      const state = await existing.getState();
      // A fetched job can finish during drain without claiming the PG task.
      // BullMQ completion/failure therefore cannot suppress durable PG repair.
      if (state === 'completed' || state === 'failed') await existing.retry(state);
      else if (state === 'unknown') throw new Error('QUEUE_JOB_UNAVAILABLE');
      return;
    }
    await queue.add('execute', { taskId: delivery.task_id }, {
      jobId: delivery.id, attempts: 1,
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400, count: 1000 },
    });
  }

  async close() {
    await Promise.all([...this.queues.values()].map(queue => queue.close()));
    this.connection.disconnect();
  }
}
