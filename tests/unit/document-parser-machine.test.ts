import { describe, expect, it, vi } from 'vitest';
import { createDocumentParserConfig } from '../../src/config/document-parser-machine.js';
import { AliyunEcsPower, EcsPowerError, assertEconomicalStopEligible, type EcsRpc, type EcsInstance } from '../../src/integrations/ecs-power.js';
import { loadConfig } from '../../src/config/config.js';
import { env } from '../helpers.js';

const target = { regionId: 'cn-beijing', instanceId: 'i-unittest123456', privateIp: '172.18.102.101', credentials: async () => ({ accessKeyId: 'unit-ak', accessKeySecret: 'unit-secret' }) };
const ecsOptions={mode:'ecs' as const,...target};
const response = (overrides = {}) => ({ Instances: { Instance: [{
  InstanceId: target.instanceId, RegionId: target.regionId, InstanceType: 'ecs.gn7i-c16g1.4xlarge',
  Status: 'Running', InstanceChargeType: 'PostPaid', InstanceNetworkType: 'vpc',
  VpcAttributes: { VpcId: 'vpc-unit', PrivateIpAddress: { IpAddress: [target.privateIp] } },
  OperationLocks: { LockReason: [] }, ...overrides,
}] } });

describe('document parser configuration (no live cloud calls)', () => {
  it('defaults node execution disabled at the deployment boundary',()=>{
    expect(loadConfig('worker',env).processingNodes.enabled).toBe(false);
  });
  it('configures one ECS with default one-minute idle and one global slot', () => {
    const config = createDocumentParserConfig(ecsOptions);
    expect(config.enabled && config.mode).toBe('ecs');
    if (!config.enabled) throw new Error('CONFIG_REQUIRED');
    expect(config).toMatchObject({ baseUrl: 'http://172.18.102.101:8000', healthPath: '/health', idleMs: 60000, concurrency: 1 });
  });
  it('supports permanent API paths with no ECS credentials', () => {
    const config = createDocumentParserConfig({ mode: 'always-on', baseUrl: 'https://parser.example.com/v2/documents' });
    expect(config).toMatchObject({ mode: 'always-on', baseUrl: 'https://parser.example.com/v2/documents', healthPath: '', concurrency: 1 });
    expect('credentials' in config).toBe(false);
  });
  it.each([
    { mode: 'unknown' },
    { baseUrl: 'http://172.18.102.102:8000' },
    { baseUrl: 'https://user:secret@172.18.102.101' },
    { privateIp: '169.254.169.254' },
    { regionId: 'cn-beijing.evil.invalid' },
    { concurrency: 0 },
    { idleMs: 0 },
    { healthPath: '//other-host/health' },
    { healthPath: '' },
    { apiToken: 'abc\r\nsecret' },
  ])('rejects malformed or mismatched managed target settings %j', override => {
    expect(() => createDocumentParserConfig({ ...ecsOptions, ...override } as Parameters<typeof createDocumentParserConfig>[0])).toThrow('INVALID_CONFIG:');
  });
  it('rejects credentials in API URLs and public plaintext APIs', () => {
    for (const url of ['https://user:secret@parser.example.com', 'http://parser.example.com/v1']) {
      expect(() => createDocumentParserConfig({ mode: 'always-on', baseUrl: url })).toThrow('INVALID_CONFIG:PROCESSING_NODE_BASE_URL');
    }
  });
  it('uses DB nodes behind a deployment master switch, not legacy target environment', () => {
    const settings={...env,DOCUMENT_PARSER_MODE:'ecs',DOCUMENT_PARSER_BASE_URL:'https://unused.invalid'};
    expect(loadConfig('worker', settings).processingNodes.enabled).toBe(false);
    expect(loadConfig('scheduler', {...settings,PROCESSING_NODES_ENABLED:'true'}).processingNodes.enabled).toBe(true);
    expect(loadConfig('api-server', settings).processingNodes.enabled).toBe(false);
  });
});

describe('ECS economical-stop RPC adapter (mock RPC, not live cloud)', () => {
  it('reconciles the exact instance, region and private IP', async () => {
    const rpc = vi.fn<EcsRpc>().mockResolvedValue(response({ Status: 'Stopped', StoppedMode: 'StopCharging' }));
    const instance = await new AliyunEcsPower(target, rpc).describe();
    expect(instance).toMatchObject({ instanceId: target.instanceId, status: 'Stopped', stoppedMode: 'StopCharging', vpcId: 'vpc-unit' });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('DescribeInstances', { RegionId: target.regionId, InstanceIds: JSON.stringify([target.instanceId]) });
  });
  it.each([
    { InstanceId: 'i-someoneelse' }, { RegionId: 'cn-hangzhou' },
    { VpcAttributes: { VpcId: 'vpc-unit', PrivateIpAddress: { IpAddress: ['172.18.102.102'] } } },
  ])('fails closed on a target mismatch %j', async override => {
    await expect(new AliyunEcsPower(target, async () => response(override)).describe()).rejects.toMatchObject({ code: 'ECS_TARGET_MISMATCH' });
  });
  it('does not infer instance deletion or a free stop from an empty cloud result', async () => {
    await expect(new AliyunEcsPower(target, async () => ({ Instances: { Instance: [] } })).describe()).rejects.toMatchObject({ code: 'ECS_TARGET_NOT_VISIBLE' });
  });
  it('uses graceful StopCharging and never initializes local disks or invents an idempotency parameter', async () => {
    const rpc = vi.fn<EcsRpc>().mockResolvedValue({ RequestId: 'unit-request' });
    const cloud = new AliyunEcsPower(target, rpc);
    await cloud.start(); await cloud.stopEconomically();
    expect(rpc.mock.calls).toEqual([
      ['StartInstance', { RegionId: target.regionId, InstanceId: target.instanceId, InitLocalDisk: false }],
      ['StopInstance', { RegionId: target.regionId, InstanceId: target.instanceId, StoppedMode: 'StopCharging', ForceStop: false }],
    ]);
  });
  it.each([
    { chargeType: 'PrePaid' }, { networkType: 'classic' }, { localStorageAmount: 1 },
    { localStorageCapacity: 100 }, { instanceType: 'ecs.re6p-redis.2xlarge' }, { operationLocked: true },
  ])('rejects known incompatible economical-stop metadata %j', async override => {
    const instance = await new AliyunEcsPower(target, async () => response()).describe();
    expect(() => assertEconomicalStopEligible({ ...instance, ...override } as EcsInstance)).toThrow('ECS_ECONOMICAL_STOP_UNSUPPORTED');
  });
  it('classifies ambiguous failures without retries or leaking messages/URLs', async () => {
    const rpc = vi.fn<EcsRpc>().mockRejectedValue({ statusCode: 503, code: 'InternalError', requestId: 'unit-id', message: 'secret-token signed-url' });
    let caught: unknown;
    try { await new AliyunEcsPower(target, rpc).stopEconomically(); } catch (error) { caught = error; }
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(caught).toBeInstanceOf(EcsPowerError);
    expect(caught).toMatchObject({ code: 'ECS_API_FAILED', outcome: 'unknown', providerCode: 'InternalError', requestId: 'unit-id' });
    expect(String(caught)).not.toContain('secret-token');
  });
  it('distinguishes definitive cloud rejection from unknown transport outcomes', async () => {
    await expect(new AliyunEcsPower(target, async () => { throw { statusCode: 400, code: 'OperationDenied.NoStock' }; }).start()).rejects.toMatchObject({ outcome: 'rejected', providerCode: 'OperationDenied.NoStock' });
  });
});
