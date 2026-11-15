import { describe, expect, it, vi } from 'vitest';
import { createDocumentParserConfig } from '../../src/config/document-parser-machine.js';
import { AliyunEcsPower, EcsPowerError, assertEconomicalStopEligible, type EcsRpc, type EcsInstance } from '../../src/integrations/ecs-power.js';
import { loadConfig } from '../../src/config/config.js';
import { env } from '../helpers.js';
import {DocumentParserMachine,ParserExecutionDeferred,ParserMachineRedis} from '../../src/lib/document-parser-machine/index.js';
import {createDocumentParserEciConfig} from '../../src/config/document-parser-eci.js';
import type {ParserEciTarget} from '../../src/lib/document-parser-machine/redis.js';
import type {ParserEciProvider} from '../../src/lib/document-parser-machine/eci-fallback.js';
import type {GpuAllocationCheckpoint} from '../../src/integrations/gpu-spot/types.js';
import {allocationHash,digest} from '../../src/integrations/gpu-spot/spec.js';

const target = { regionId: 'cn-beijing', instanceId: 'i-unittest123456', privateIp: '172.18.102.101', credentials: async () => ({ accessKeyId: 'unit-ak', accessKeySecret: 'unit-secret' }) };
const ecsOptions={mode:'ecs' as const,...target};
const response = (overrides = {}) => ({ Instances: { Instance: [{
  InstanceId: target.instanceId, RegionId: target.regionId, InstanceType: 'ecs.gn7i-c16g1.4xlarge',
  Status: 'Running', InstanceChargeType: 'PostPaid', InstanceNetworkType: 'vpc',
  VpcAttributes: { VpcId: 'vpc-unit', PrivateIpAddress: { IpAddress: [target.privateIp] } },
  OperationLocks: { LockReason: [] }, ...overrides,
}] } });

describe('read-only node observation; cloud and health are mocked',()=>{
 const make=(status:EcsInstance['status'],ready=true)=>{
  const instance:EcsInstance={...target,instanceType:'ecs.c8i.4xlarge',status,stoppedMode:'StopCharging',chargeType:'PostPaid',networkType:'vpc',vpcId:'vpc-unit',privateIps:[target.privateIp],localStorageAmount:0,localStorageCapacity:0,operationLocked:false};
  const cloud={describe:vi.fn(async()=>instance),start:vi.fn(async()=>undefined),stopEconomically:vi.fn(async()=>undefined)},health=vi.fn(async()=>ready);
  const state={status:vi.fn(async()=>undefined)} as unknown as ParserMachineRedis;
  return {machine:new DocumentParserMachine(state,cloud,createDocumentParserConfig(ecsOptions),health),cloud,health};
 };
 it.each([['Stopped','offline',true],['Pending','starting',false],['Starting','starting',false],['Stopping','stopping',false],['Running','online',false]] as const)('observes %s as %s without changing power',async(power,state,canStart)=>{
  const test=make(power);expect(await test.machine.observe()).toMatchObject({state,canStart,source:'ecs',serviceReady:power==='Running'});
  expect(test.cloud.start).not.toHaveBeenCalled();expect(test.cloud.stopEconomically).not.toHaveBeenCalled();
  expect(test.health).toHaveBeenCalledTimes(power==='Running'?1:0);
 });
 it('keeps a Running instance online even when its private API is unreachable',async()=>{
  expect(await make('Running',false).machine.observe()).toMatchObject({state:'online',instanceStatus:'Running',serviceReady:false,serviceStatus:'unreachable',canStart:false});
 });
 it('observes cloud power without probing the private API when API calls are disabled',async()=>{
  const test=make('Running',false);expect(await test.machine.observe(false)).toMatchObject({state:'online',instanceStatus:'Running',serviceReady:null,serviceStatus:'not_checked'});
  expect(test.cloud.describe).toHaveBeenCalledTimes(1);expect(test.health).not.toHaveBeenCalled();
 });
 it('does not offer another startup while an uncertain or busy control record exists',async()=>{
  const config=createDocumentParserConfig(ecsOptions),cloud={describe:vi.fn(async()=>({...target,instanceType:'ecs.c8i.4xlarge',status:'Stopped' as const,chargeType:'PostPaid',networkType:'vpc',vpcId:'vpc-unit',privateIps:[target.privateIp],localStorageAmount:0,localStorageCapacity:0,operationLocked:false})),start:vi.fn(async()=>undefined),stopEconomically:vi.fn(async()=>undefined)};
  for(const partial of [{phase:'unknown-start'},{phase:'ready',active:1},{phase:'ready',queued:1},{phase:'ready',uncertain:1}]){
   const state={status:async()=>Object.assign({phase:'ready',active:0,queued:0,uncertain:0},partial)} as unknown as ParserMachineRedis;
   expect(await new DocumentParserMachine(state,cloud,config).observe()).toMatchObject({state:'offline',canStart:false});
  }
  expect(cloud.start).not.toHaveBeenCalled();expect(cloud.stopEconomically).not.toHaveBeenCalled();
 });
 it('reports an unreadable instance as unknown instead of offline and hides arbitrary errors',async()=>{
  const test=make('Stopped');test.cloud.describe.mockRejectedValue(new Error('private diagnostic must not leave the server'));
  expect(await test.machine.observe()).toMatchObject({state:'unknown',source:'ecs',serviceReady:null,serviceStatus:'not_checked',canStart:false,reason:'PROCESSING_NODE_STATUS_UNAVAILABLE'});
  expect(test.cloud.start).not.toHaveBeenCalled();expect(test.cloud.stopEconomically).not.toHaveBeenCalled();
 });
});

describe('ECI recovery with cloud control disabled; in-memory state and cloud provider',()=>{
 const make=(phase:GpuAllocationCheckpoint['phase']|undefined,powerControlEnabled=false)=>{
  const fallback=createDocumentParserEciConfig({vpcId:'vpc-unit',securityGroupId:'sg-unit',vSwitchIds:['vsw-unit'],
   instanceTypes:['ecs.gn7i-c16g1.4xlarge'],image:'example-registry-vpc.cn-beijing.cr.aliyuncs.com/test/parser:unit',
   acrInstanceId:'cri-unit',extraStorageGiB:40,bucket:'test-bucket',keyPrefix:'unit'},target.regionId);
  const allocationId='unit-existing-allocation',ref={regionId:target.regionId,vpcId:'vpc-unit',containerGroupId:'eci-unitexisting',allocationHash:allocationHash(allocationId)};
  let eciTarget:ParserEciTarget|undefined={allocationId,...(phase?{checkpoint:{allocationId,requestHash:digest(JSON.stringify(fallback.spec)),generation:0,phase,
   ...(phase==='submitted'?{containerGroupId:ref.containerGroupId}:{})}}:{})};
  const state={register:vi.fn(async()=>undefined),claim:vi.fn(async()=>true),lock:vi.fn(async()=>'starting'),unlock:vi.fn(async()=>undefined),
   status:vi.fn(async()=>({eciTarget,redisTimeMs:Date.now()})),phase:vi.fn(async()=>true),renew:vi.fn(async()=>undefined),finish:vi.fn(async()=>undefined),
   setEciTarget:vi.fn(async(_token:string,value:ParserEciTarget|undefined)=>{eciTarget=value;})};
  const provider={create:vi.fn<ParserEciProvider['create']>().mockResolvedValue({containerGroupId:ref.containerGroupId}),
   describe:vi.fn<ParserEciProvider['describe']>().mockResolvedValue({...ref,status:'Running',spotStrategy:'NoSpot',instanceType:fallback.spec.instanceTypes[0],
    privateIp:'172.18.102.102',containersReady:true,reclaiming:false,eventReasons:[]}),release:vi.fn<ParserEciProvider['release']>().mockResolvedValue(undefined),
   findByAllocation:vi.fn<ParserEciProvider['findByAllocation']>().mockResolvedValue(null)};
  const cloud={describe:vi.fn<AliyunEcsPower['describe']>().mockRejectedValue(new Error('ECI recovery must not inspect primary ECS')),
   start:vi.fn(async()=>undefined),stopEconomically:vi.fn(async()=>undefined)},health=vi.fn(async()=>true);
  const config={...createDocumentParserConfig({...ecsOptions,eciFallback:fallback}),powerControlEnabled};
  const machine=new DocumentParserMachine(state as unknown as ParserMachineRedis,cloud,config,health,provider);
  const request={requestId:'unit-eci-request',fingerprint:'a'.repeat(64),step:true};
  return {machine,request,provider,cloud,health,state,ref};
 };
 it.each([undefined,'retryable','capacity_unavailable'] as const)('does not create from the %s allocation checkpoint',async phase=>{
  const test=make(phase),execute=vi.fn(async()=>undefined);
  await expect(test.machine.withDocumentParser(test.request,execute)).rejects.toBeInstanceOf(ParserExecutionDeferred);
  expect(test.provider.create).not.toHaveBeenCalled();expect(test.provider.release).not.toHaveBeenCalled();
  expect(test.state.setEciTarget).not.toHaveBeenCalled();expect(test.health).not.toHaveBeenCalled();expect(execute).not.toHaveBeenCalled();
  expect(test.cloud.start).not.toHaveBeenCalled();expect(test.cloud.stopEconomically).not.toHaveBeenCalled();
 });
 it('continues using an already submitted Running instance without creating or releasing it',async()=>{
  const test=make('submitted'),execute=vi.fn(async(context:{baseUrl:string})=>context.baseUrl);
  await expect(test.machine.withDocumentParser(test.request,execute)).resolves.toBe('http://172.18.102.102:8000');
  expect(test.provider.describe).toHaveBeenCalledExactlyOnceWith(test.ref);expect(test.health).toHaveBeenCalledTimes(1);expect(execute).toHaveBeenCalledTimes(1);
  expect(test.provider.create).not.toHaveBeenCalled();expect(test.provider.release).not.toHaveBeenCalled();expect(test.cloud.describe).not.toHaveBeenCalled();
 });
 it('reconciles an unknown submission to its existing instance and then resumes it',async()=>{
  const test=make('unknown'),execute=vi.fn(async(context:{baseUrl:string})=>context.baseUrl);
  test.provider.findByAllocation.mockResolvedValue(test.ref);
  await expect(test.machine.withDocumentParser(test.request,execute)).rejects.toBeInstanceOf(ParserExecutionDeferred);
  expect(test.provider.findByAllocation).toHaveBeenCalledTimes(1);expect(test.state.setEciTarget).toHaveBeenCalledTimes(1);
  await expect(test.machine.withDocumentParser(test.request,execute)).resolves.toBe('http://172.18.102.102:8000');
  expect(test.provider.describe).toHaveBeenCalledExactlyOnceWith(test.ref);expect(execute).toHaveBeenCalledTimes(1);
  expect(test.provider.create).not.toHaveBeenCalled();expect(test.provider.release).not.toHaveBeenCalled();
 });
 it('still permits a retryable creation when cloud control is explicitly enabled',async()=>{
  const test=make('retryable',true),execute=vi.fn(async()=>undefined);
  await expect(test.machine.withDocumentParser(test.request,execute)).rejects.toBeInstanceOf(ParserExecutionDeferred);
  expect(test.provider.create).toHaveBeenCalledTimes(1);expect(execute).not.toHaveBeenCalled();
 });
});

describe('document parser configuration (no live cloud calls)', () => {
  it('defaults node execution disabled at the deployment boundary',()=>{
    expect(loadConfig('worker',env).processingNodes.enabled).toBe(false);
  });
  it('separates credential-backed cloud control from private parser execution and permits an explicit deny',()=>{
    const settings={...env,PROCESSING_NODES_ENABLED:'false',ALIYUN_RAM_ACCESS_KEY_ID:'synthetic-ak',ALIYUN_RAM_ACCESS_KEY_SECRET:'synthetic-secret'};
    expect(loadConfig('worker',settings).processingNodes).toMatchObject({enabled:false,cloudControlEnabled:true});
    expect(loadConfig('worker',{...settings,PROCESSING_NODES_CLOUD_CONTROL_ENABLED:'false'}).processingNodes).toMatchObject({enabled:false,cloudControlEnabled:false});
    expect(()=>loadConfig('worker',{...settings,PROCESSING_NODES_CLOUD_CONTROL_ENABLED:'invalid'})).toThrow('INVALID_CONFIG:PROCESSING_NODES_CLOUD_CONTROL_ENABLED');
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
