import { prepareGpuSpotSpec } from '../integrations/gpu-spot/spec.js';
import type { PreparedGpuSpotSpec } from '../integrations/gpu-spot/types.js';

export const singleA10InstanceTypes = [
  'ecs.gn7i-c8g1.2xlarge', 'ecs.gn7i-c16g1.4xlarge',
  'ecs.gn7i-c32g1.8xlarge', 'ecs.gn7i-c48g1.12xlarge',
] as const;
export interface DocumentParserEciConfig { spec: PreparedGpuSpotSpec; retryMs: number }
export interface EciFallbackSettings {
  vpcId:string; securityGroupId:string; vSwitchIds:string[]; instanceTypes:string[];
  image:string; acrInstanceId:string; extraStorageGiB:number; bucket:string; keyPrefix:string;
}

/** Opt-in node configuration; document requests cannot select cloud resources. */
export function createDocumentParserEciConfig(input:EciFallbackSettings, regionId:string):DocumentParserEciConfig {
  const fail = (key:string):never => {throw new Error(`INVALID_CONFIG:PROCESSING_NODE_ECI_${key}`);};
  const {instanceTypes,bucket,image,extraStorageGiB}=input;
  if (!instanceTypes.length || !instanceTypes.every(type=>singleA10InstanceTypes.includes(type as typeof singleA10InstanceTypes[number]))) fail('INSTANCE_TYPES');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) fail('BUCKET');
  const prefix=(input.keyPrefix.trim()||'huahuo').replace(/^\/+|\/+$/g,'');
  if (!/^[a-zA-Z0-9_/-]{1,200}$/.test(prefix)||prefix.split('/').some(s=>!s||s==='.'||s==='..')) fail('KEY_PREFIX');
  if (!new RegExp(`^[a-z0-9-]+-registry-vpc\\.${regionId.replaceAll('.', '\\.')}\\.cr\\.aliyuncs\\.com/`).test(image)) fail('IMAGE');
  try {
    return { retryMs: 15000, spec: prepareGpuSpotSpec({
      regionId, vpcId: input.vpcId, securityGroupId: input.securityGroupId,
      vSwitchIds: input.vSwitchIds, instanceTypes, image,
      gpuCount: 1, spot: { strategy: 'NoSpot' }, port: 8000, sharedMemoryGiB: 1,
      extraStorageGiB, autoMatchImageCache: true, acrInstanceId: input.acrInstanceId,
      environment: {
        STORAGE_ALIYUN_OSS_REGION: regionId, STORAGE_ALIYUN_OSS_ENDPOINT: `https://oss-${regionId}-internal.aliyuncs.com`,
        STORAGE_ALIYUN_OSS_BUCKET: bucket, STORAGE_ALIYUN_OSS_KEY_PREFIX: `${prefix}/resources`,
        STORAGE_ALIYUN_OSS_TIMEOUT_MS: '120000', STORAGE_ALIYUN_OSS_SECURE: 'true',
        XBERG_OCR_PROFILE: 'fast', XBERG_ORT_EP: 'cuda', CUDA_VISIBLE_DEVICES: '0',
        HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', RUST_LOG: 'info', XBERG_MAX_CONCURRENT_REQUESTS: '16',
        XBERG_RESPONSE_PROTOCOL: 'kb-markdown-v1', XBERG_OSS_UPLOAD_ENABLED: '1',
        XBERG_OSS_UPLOAD_CONCURRENCY: '8', XBERG_OSS_MAX_QUEUED_UPLOADS: '32', XBERG_OSS_MAX_IMAGE_BYTES: '33554432',
        XBERG_OSS_LEDGER_PATH: '/var/lib/xberg/oss-resources.sqlite3',
        XBERG_MAX_REQUEST_BODY_BYTES: '104857600', XBERG_MAX_MULTIPART_FIELD_BYTES: '104857600',
        XBERG_API_ALLOW_LOCAL_URI_INPUTS: '0', XBERG_CORS_ORIGINS: '', XBERG_JOB_TIMEOUT_SECS: '600',
        XBERG_CALLBACK_CONCURRENCY: '8', XBERG_CALLBACK_MAX_PENDING: '100', XBERG_CALLBACK_TIMEOUT_SECS: '15',
        XBERG_CALLBACK_MAX_ATTEMPTS: '3', XBERG_CALLBACK_ALLOWED_HOSTS: '',
      },
    }) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('INVALID_CONFIG:')) throw error;
    return fail('FALLBACK');
  }
}
