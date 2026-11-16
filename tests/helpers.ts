import { loadConfig, type Env, type Role } from '../src/config/config.js';
import type { Dependencies } from '../src/plugins/dependencies.js';
export const env: Env = {
 DATABASE_URL:'postgresql://huahuo_api:test@localhost:5432/huahuo_test_unit',
 REDIS_CACHE_URL:'redis://localhost:6379/0',REDIS_QUEUE_URL:'redis://localhost:6379/1',
 APP_ENV:'test',APP_TOKEN_SECRET:'a'.repeat(32),ADMIN_SESSION_SECRET:'b'.repeat(32),
 APP_PUBLIC_BASE_URL:'http://localhost:3000',ADMIN_PUBLIC_BASE_URL:'http://localhost:3001',LOG_LEVEL:'silent',
};
export const config = (role: Role = 'api-server') => loadConfig(role,env);
export function dependencies(ready=true): Dependencies {
 return {check:async()=>({postgres:ready,schema:ready,redisCache:ready,redisQueue:ready}),close:async()=>undefined};
}
