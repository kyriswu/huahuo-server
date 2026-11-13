import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { AliyunEciGpuProvider, EciProviderError, loadGpuSpotConfig } from '../integrations/gpu-spot/index.js';

try {
  // Read only the named RAM credential fields into the GPU configuration.
  const rootEnv = parseEnv(readFileSync(new URL('../../.env', import.meta.url), 'utf8'));
  const config = loadGpuSpotConfig({
    ...process.env, GPU_SPOT_PROVIDER: 'aliyun-eci',
    ALIYUN_RAM_ACCESS_KEY_ID: rootEnv.ALIYUN_RAM_ACCESS_KEY_ID,
    ALIYUN_RAM_ACCESS_KEY_SECRET: rootEnv.ALIYUN_RAM_ACCESS_KEY_SECRET,
    ALIYUN_RAM_SECURITY_TOKEN: rootEnv.ALIYUN_RAM_SECURITY_TOKEN,
  });
  if (config.provider !== 'aliyun-eci') throw new Error('GPU_SPOT_NOT_CONFIGURED');
  const network = await new AliyunEciGpuProvider(config.connection).preflight(config.spec);
  const candidates = config.spec.instanceTypes.map((instanceType, index) => ({ priority: index + 1, instanceType }));
  console.log(JSON.stringify({ mode: 'read-only', creates: 0, deletes: 0, candidates, scheduleStrategy: 'VSwitchRandom', network }, null, 2));
} catch (error) {
  if (error instanceof EciProviderError) {
    console.error(JSON.stringify({ code: 'GPU_NETWORK_PREFLIGHT_FAILED', providerCode: error.providerCode, requestId: error.requestId }));
  } else {
    const message = error instanceof Error && error.message.startsWith('INVALID_GPU_SPOT_CONFIG:') ? error.message : 'GPU_NETWORK_PREFLIGHT_FAILED';
    console.error(JSON.stringify({ code: message }));
  }
  process.exitCode = 1;
}
