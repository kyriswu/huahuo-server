import { it,expect } from 'vitest';
import { retryDelay,taskDto, type TaskRow } from '../../src/modules/tasks/model.js';
import { loadConfig } from '../../src/config/config.js';
import { config } from '../helpers.js';
it('bounded jittered backoff and Work AI terminal mapping',()=>{
 expect(retryDelay(1,()=>0)).toBe(1500);expect(retryDelay(50,()=>1)).toBeLessThanOrEqual(75000);
 const t={id:'fixture',kind:'demo.digest',state:'cancelled',created_at:new Date(),updated_at:new Date(),error_code:null,retryable:false} as TaskRow;
 expect(taskDto(t)).toMatchObject({status:'failed',state:'cancelled',error:{code:'TASK_CANCELLED',retryable:false}});
});
it('queue configuration rejects unsafe/test-only production settings',()=>{
 const c=config('worker');
 const env={DATABASE_URL:c.databaseUrl,REDIS_CACHE_URL:c.redisCacheUrl,REDIS_QUEUE_URL:c.redisQueueUrl};
 expect(()=>loadConfig('worker',{...env,WORKER_QUEUES:'content,content'})).toThrow('WORKER_QUEUES');
 expect(()=>loadConfig('worker',{...env,REDIS_KEY_PREFIX:'bad:prefix'})).toThrow('REDIS_KEY_PREFIX');
 expect(()=>loadConfig('worker',{...env,TEST_TASK_DELAY_MS:'1000'})).toThrow('TEST_TASK_DELAY_MS');
 expect(()=>loadConfig('worker',{...env,APP_ENV:'production',DATABASE_SSL_MODE:'verify-full',ENABLE_DEMO_TASKS:'true'})).toThrow('ENABLE_DEMO_TASKS');
});
