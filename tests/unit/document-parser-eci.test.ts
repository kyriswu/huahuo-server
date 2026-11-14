import { describe, expect, it } from 'vitest';
import { loadDocumentParserMachineConfig } from '../../src/config/document-parser-machine.js';
import { singleA10InstanceTypes } from '../../src/config/document-parser-eci.js';
import { isEcsCapacityRejection, EcsPowerError } from '../../src/integrations/ecs-power.js';
import { buildEciCreateRequest } from '../../src/integrations/gpu-spot/aliyun-eci.js';

const env = {
  DOCUMENT_PARSER_MODE: 'ecs', DOCUMENT_PARSER_ECS_REGION_ID: 'cn-beijing',
  DOCUMENT_PARSER_ECS_INSTANCE_ID: 'i-unittest123456', DOCUMENT_PARSER_ECS_PRIVATE_IP: '172.18.102.101',
  ALIYUN_RAM_ACCESS_KEY_ID: 'test-ak', ALIYUN_RAM_ACCESS_KEY_SECRET: 'test-secret',
  DOCUMENT_PARSER_ECI_FALLBACK_ENABLED: 'true', DOCUMENT_PARSER_ECI_VPC_ID: 'vpc-test',
  DOCUMENT_PARSER_ECI_SECURITY_GROUP_ID: 'sg-test', DOCUMENT_PARSER_ECI_VSWITCH_IDS: 'vsw-a,vsw-b,vsw-c,vsw-d',
  DOCUMENT_PARSER_ECI_IMAGE: 'example-registry-vpc.cn-beijing.cr.aliyuncs.com/ai_service/xberg:cuda-a10-native-first-oss-kbxml-v1',
  DOCUMENT_PARSER_ECI_ACR_INSTANCE_ID: 'cri-test', STORAGE_ALIYUN_OSS_BUCKET: 'test-bucket', STORAGE_ALIYUN_OSS_KEY_PREFIX: 'huahuo',
};

describe('A10 pay-as-you-go ECS → ECI configuration (no cloud)', () => {
  it('is opt-in and does not change the existing ECS configuration when disabled', () => {
    const config = loadDocumentParserMachineConfig({ ...env, DOCUMENT_PARSER_ECI_FALLBACK_ENABLED: 'false', DOCUMENT_PARSER_ECI_IMAGE: '' });
    expect(config).not.toHaveProperty('eciFallback');
  });
  it('keeps all four A10 priorities, four switches, internal image/OSS and the existing model entrypoint', () => {
    const config = loadDocumentParserMachineConfig(env);
    if (!config.enabled || config.mode !== 'ecs' || !config.eciFallback) throw new Error('TEST_CONFIG_REQUIRED');
    const spec = config.eciFallback.spec, request = buildEciCreateRequest(spec, 'test-token', 'a'.repeat(64));
    expect(spec.instanceTypes).toEqual(singleA10InstanceTypes);
    expect(request).toMatchObject({
      spotStrategy: 'NoSpot', instanceType: singleA10InstanceTypes.join(','), vSwitchId: 'vsw-a,vsw-b,vsw-c,vsw-d',
      autoCreateEip: false, autoMatchImageCache: true, ephemeralStorage: 40,
      acrRegistryInfo: [{ instanceId: 'cri-test', regionId: 'cn-beijing' }],
      volume: [{ name: 'shm', type: 'EmptyDirVolume', emptyDirVolume: { medium: 'Memory', sizeLimit: '1Gi' } }],
      container: [{ gpu: 1, port: [{ port: 8000, protocol: 'TCP' }], volumeMount: [{ mountPath: '/dev/shm' }] }],
    });
    expect(request.spotPriceLimit).toBeUndefined(); expect(request.spotDuration).toBeUndefined();
    expect(request.activeDeadlineSeconds).toBeUndefined();
    expect(request.container![0]!.command).toBeUndefined(); expect(request.container![0]!.arg).toBeUndefined();
    expect(spec.environment).toMatchObject({ STORAGE_ALIYUN_OSS_ENDPOINT: 'https://oss-cn-beijing-internal.aliyuncs.com', STORAGE_ALIYUN_OSS_KEY_PREFIX: 'huahuo/resources',
      XBERG_OSS_UPLOAD_CONCURRENCY: '8', XBERG_OSS_MAX_QUEUED_UPLOADS: '32', XBERG_ORT_EP: 'cuda', XBERG_CALLBACK_MAX_ATTEMPTS: '3' });
    expect(JSON.stringify(config.eciFallback)).not.toContain('test-secret');
    expect(JSON.stringify(config.eciFallback)).not.toContain('test-ak');
    request.validate();
  });
  it.each([
    { DOCUMENT_PARSER_ECI_FALLBACK_ENABLED: 'yes' }, { DOCUMENT_PARSER_MODE: 'always-on' },
    { DOCUMENT_PARSER_ECI_VPC_ID: '' }, { DOCUMENT_PARSER_ECI_VSWITCH_IDS: 'vsw-a,vsw-a' },
    { DOCUMENT_PARSER_ECI_INSTANCE_TYPES: 'ecs.gn6i-c4g1.xlarge' }, { DOCUMENT_PARSER_ECI_INSTANCE_TYPES: 'ecs.gn7i-c8g1.2xlarge,ecs.gn7i-c8g1.2xlarge' },
    { DOCUMENT_PARSER_ECI_IMAGE: 'example-registry.cn-beijing.cr.aliyuncs.com/ai_service/xberg:latest' },
    { DOCUMENT_PARSER_ECI_IMAGE: 'example-registry-vpc.cn-shanghai.cr.aliyuncs.com/ai_service/xberg:latest' },
    { DOCUMENT_PARSER_ECI_ACR_INSTANCE_ID: '' }, { DOCUMENT_PARSER_ECI_EXTRA_STORAGE_GIB: '0' },
    { STORAGE_ALIYUN_OSS_BUCKET: '' }, { STORAGE_ALIYUN_OSS_KEY_PREFIX: '../private' },
  ])('rejects a partial or incompatible fallback before any allocation: %j', override => {
    expect(() => loadDocumentParserMachineConfig({ ...env, ...override })).toThrow('INVALID_CONFIG:');
  });
  it('accepts only the explicit stock rejection of StartInstance', () => {
    expect(isEcsCapacityRejection(new EcsPowerError('ECS_API_FAILED', 'rejected', 'OperationDenied.NoStock'))).toBe(true);
    for (const code of ['QuotaExceed.ElasticQuota', 'InsufficientBalance', 'Forbidden', 'InternalError', 'InstanceNotReady']) {
      expect(isEcsCapacityRejection(new EcsPowerError('ECS_API_FAILED', 'rejected', code))).toBe(false);
    }
    expect(isEcsCapacityRejection(new EcsPowerError('ECS_API_FAILED', 'unknown', 'OperationDenied.NoStock'))).toBe(false);
    expect(isEcsCapacityRejection({ providerCode: 'OperationDenied.NoStock' })).toBe(false);
  });
});
