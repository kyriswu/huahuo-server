// Local assertions only. No network, database access or configuration values in output.
import { pathToFileURL } from 'node:url';
export function verifyOssConfiguration(env) {
  if (!['api-server','admin','worker','scheduler','migrate'].includes(env.SERVICE_ROLE)) throw new Error('OSS_CONFIGURATION_ROLE_INVALID');
  if (!['api-server','worker'].includes(env.SERVICE_ROLE)) return;
  if (env.STORAGE_DRIVER !== 'aliyun-oss') throw new Error('OSS_STORAGE_DRIVER_REQUIRED');
  for (const key of ['STORAGE_ALIYUN_OSS_ENDPOINT','STORAGE_ALIYUN_OSS_BUCKET','ALIYUN_RAM_ACCESS_KEY_ID','ALIYUN_RAM_ACCESS_KEY_SECRET']) {
    if (!env[key]?.trim()) throw new Error('OSS_CONFIGURATION_REQUIRED');
  }
  for (const endpoint of [env.STORAGE_ALIYUN_OSS_ENDPOINT, env.STORAGE_ALIYUN_OSS_PUBLIC_ENDPOINT || env.STORAGE_ALIYUN_OSS_ENDPOINT]) {
    let url;
    try { url = new URL(endpoint); } catch { throw new Error('OSS_ENDPOINT_INVALID'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('OSS_ENDPOINT_INVALID');
  }
  const publicUrl = new URL(env.STORAGE_ALIYUN_OSS_PUBLIC_ENDPOINT || env.STORAGE_ALIYUN_OSS_ENDPOINT);
  if (publicUrl.hostname.includes('-internal.')) throw new Error('OSS_PUBLIC_ENDPOINT_REQUIRED');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { verifyOssConfiguration(process.env); }
  catch (error) { console.error(error instanceof Error && /^OSS_[A-Z_]+$/.test(error.message) ? error.message : 'OSS_CONFIGURATION_INVALID'); process.exitCode = 1; }
}
