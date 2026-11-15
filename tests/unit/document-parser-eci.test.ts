import { describe, expect, it } from 'vitest';
import { createDocumentParserConfig } from '../../src/config/document-parser-machine.js';
import {createDocumentParserEciConfig, singleA10InstanceTypes } from '../../src/config/document-parser-eci.js';
import { isEcsCapacityRejection, EcsPowerError } from '../../src/integrations/ecs-power.js';
import { buildEciCreateRequest } from '../../src/integrations/gpu-spot/aliyun-eci.js';

const fallback={vpcId:'vpc-test',securityGroupId:'sg-test',vSwitchIds:['vsw-a','vsw-b','vsw-c','vsw-d'],instanceTypes:[...singleA10InstanceTypes],image:'example-registry-vpc.cn-beijing.cr.aliyuncs.com/ai_service/xberg:cuda-a10-native-first-oss-kbxml-v1',acrInstanceId:'cri-test',extraStorageGiB:40,bucket:'test-bucket',keyPrefix:'huahuo'};
const options={mode:'ecs' as const,regionId:'cn-beijing',instanceId:'i-unittest123456',privateIp:'172.18.102.101',credentials:async()=>({accessKeyId:'test-ak',accessKeySecret:'test-secret'})};

describe('A10 pay-as-you-go ECS → ECI configuration (no cloud)', () => {
  it('is opt-in and does not change the existing ECS configuration when disabled', () => {
    const config = createDocumentParserConfig(options);
    expect(config).not.toHaveProperty('eciFallback');
  });
  it('keeps all four A10 priorities, four switches, internal image/OSS and the existing model entrypoint', () => {
    const config = createDocumentParserConfig({...options,eciFallback:createDocumentParserEciConfig(fallback,'cn-beijing')});
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
    {vpcId:''},{vSwitchIds:['vsw-a','vsw-a']},{instanceTypes:['ecs.gn6i-c4g1.xlarge']},
    {instanceTypes:['ecs.gn7i-c8g1.2xlarge','ecs.gn7i-c8g1.2xlarge']},
    {image:'example-registry.cn-beijing.cr.aliyuncs.com/ai_service/xberg:latest'},
    {image:'example-registry-vpc.cn-shanghai.cr.aliyuncs.com/ai_service/xberg:latest'},
    {acrInstanceId:''},{extraStorageGiB:0},{bucket:''},{keyPrefix:'../private'},
  ])('rejects incompatible fallback before allocation: %j',override=>{
    expect(()=>createDocumentParserEciConfig({...fallback,...override},'cn-beijing')).toThrow('INVALID_CONFIG:');
  });
  it('rejects ECI fallback on a permanent API node',()=>{
    expect(()=>createDocumentParserConfig({mode:'always-on',baseUrl:'https://example.test',eciFallback:createDocumentParserEciConfig(fallback,'cn-beijing')})).toThrow('INVALID_CONFIG:');
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
