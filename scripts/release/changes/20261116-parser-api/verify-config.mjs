import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// This release targets test. Local ENV assertions only: no network, SQL, writes,
// credential output, or attempt to prove IAM permissions through a cloud call.
export function verifyTestCloudControl(env) {
  if (env.APP_ENV !== 'test') throw new Error('TEST_APP_ENV_REQUIRED');
  if (env.SERVICE_ROLE === 'migrate') return;
  if (!['api-server', 'admin', 'worker', 'scheduler'].includes(env.SERVICE_ROLE)) throw new Error('TEST_RUNTIME_ROLE_REQUIRED');
  if (env.PROCESSING_NODES_ENABLED !== 'true') throw new Error('TEST_PRIVATE_API_REQUIRED');
  const control = env.PROCESSING_NODES_CLOUD_CONTROL_ENABLED?.trim();
  if (control && control !== 'true') throw new Error('TEST_CLOUD_CONTROL_REQUIRED');
  if (!env.ALIYUN_RAM_ACCESS_KEY_ID?.trim() || !env.ALIYUN_RAM_ACCESS_KEY_SECRET?.trim()) throw new Error('TEST_RAM_CREDENTIALS_REQUIRED');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { verifyTestCloudControl(process.env); }
  catch { process.stderr.write('TEST_CLOUD_CONTROL_CONFIGURATION_INVALID\n'); process.exitCode = 1; }
}
