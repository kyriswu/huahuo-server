export type { AliyunOssConfig } from './aliyun-oss.js';
export { AliyunOssStorageAdapter } from './aliyun-oss.js';
import type { StoragePort } from '../../modules/storage/port.js';

/** Common deletion entrypoint for cleanup jobs and future tools. */
export async function deleteMany(storage:StoragePort,keys:string[]):Promise<void>{if(!keys.length)return;if(storage.removeMany){await storage.removeMany(keys);return;}for(const key of keys)await storage.remove(key);}
