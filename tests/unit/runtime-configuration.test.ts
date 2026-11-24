import {describe,it,expect,vi} from 'vitest';
import type pg from 'pg';
import {config} from '../helpers.js';
import {defaults,validateValues,applyValues,rejectSecrets} from '../../src/modules/runtime-settings/registry.js';
import {extractionConfig} from '../support/extraction-config.js';
import {nodeConfig,nodeDocumentConfig,nodeFromRow,type ProcessingNode} from '../../src/modules/processing-nodes/model.js';
import {ProcessingNodes} from '../../src/modules/processing-nodes/service.js';
import {loadProcessingNodesConfig} from '../../src/config/processing-nodes.js';
import {snapshotForSource,kbEmbedding} from '../../src/modules/kb/profile.js';

const node:ProcessingNode={id:'11111111-1111-4111-8111-111111111111',name:'GPU node',capabilities:['document'],resourceClass:'gpu',mode:'ecs',regionId:'cn-beijing',instanceId:'i-unit12345678',privateIp:'172.18.102.103',baseUrl:'http://172.18.102.103:8000',healthPath:'/health',tokenEnv:null,concurrency:1,idleSeconds:60,startupSeconds:600,queueSeconds:3600,revision:1};
describe('typed runtime registry (no database/cloud)',()=>{
 it('keeps seeded nodes unavailable when local processing is disabled',async()=>{
  const bootstrap=loadProcessingNodesConfig({PROCESSING_NODES_ENABLED:'false',PROCESSING_NODES_CLOUD_CONTROL_ENABLED:'true'});
  expect(bootstrap).toMatchObject({enabled:false,cloudControlEnabled:false});
  const query=vi.fn();
  const nodes=new ProcessingNodes({query} as unknown as pg.Pool,{...config(),processingNodes:bootstrap});
  await expect(nodes.list()).resolves.toEqual([]);
  await expect(nodes.observe(node.id)).rejects.toMatchObject({code:'PROCESSING_NODE_NOT_FOUND'});
  await expect(nodes.bind('local-document','document')).rejects.toMatchObject({code:'PROCESSING_NODE_UNAVAILABLE'});
  await expect(nodes.runtime(node)).rejects.toMatchObject({code:'PROCESSING_NODE_UNAVAILABLE'});
  expect(query).not.toHaveBeenCalled();
 });
 it('reads the canonical node configuration without mutating its fields',()=>{
  const {id,revision,...config}=node;const before=structuredClone(config);
  expect(nodeFromRow({id,revision,config})).toMatchObject(node);expect(config).toEqual(before);
 });
 it('uses service defaults for deployed ECS and keeps overrides local to each node',()=>{
  const cpu={...node,resourceClass:'cpu' as const},defaults=nodeDocumentConfig(cpu);
  expect(defaults).toMatchObject({parameters:null,mode:'async',timeoutMs:3120000});
  const extraction=extractionConfig('async');
  const gpu={...node,documentApi:{mode:'async' as const,parameters:extraction.parameters,timeoutSeconds:3200,pollMs:100,maxResponseBytes:67108864}};
  expect(nodeDocumentConfig(gpu)).toMatchObject({parameters:extraction.parameters,mode:'async',pollMs:100,timeoutMs:3200000});
  expect(nodeDocumentConfig(cpu)).toEqual(defaults);
  expect(()=>nodeConfig({...gpu,documentApi:{...gpu.documentApi,parameters:{output_format:'markdown'}}},loadProcessingNodesConfig({}))).toThrow('PROCESSING_NODE_INVALID');
  expect(()=>nodeDocumentConfig({...gpu,documentApi:{...gpu.documentApi,parameters:{api_key:'must-not-persist'}}})).toThrow('CONFIGURATION_SECRET_FORBIDDEN');
  expect(()=>validateValues({'document.mode':'async'},config())).toThrow('CONFIGURATION_KEY_UNKNOWN');
 });
 it('rejects secret field variants, signed URLs, unknown keys, production fixtures and inconsistent bounds',()=>{
  for(const value of [{ocr:{ALIYUN_RAM_ACCESS_KEY_SECRET:'no'}},{ocr:{apiKey:'no'}},{url:'https://a:b@host.test/'},{url:'https://host.test/a?Signature=no'}])expect(()=>rejectSecrets(value)).toThrow('CONFIGURATION_SECRET_FORBIDDEN');
  for(const values of [{'tasks.retryBaseMs':5000,'tasks.retryMaxMs':1000},{'storage.maxUploadBytes':2147483649},{'unknown':true},{'tasks.maxAttempts':1.5}])expect(()=>validateValues(values,config())).toThrow('CONFIGURATION_');
  expect(()=>validateValues({'features.tagProvider':'deterministic'},{...config(),appEnv:'production'})).toThrow('CONFIGURATION_TEST_PROVIDER_FORBIDDEN');
  expect(()=>validateValues({'storage.maxUploadBytes':2000},{...config(),uploadHardMaxBytes:1000})).toThrow('CONFIGURATION_INVALID');
 });
 it('creates independent default JSON snapshots',()=>{const a=defaults(),b=defaults();a['tasks.maxAttempts']=9;expect(b['tasks.maxAttempts']).toBe(3);});
 it('uses one strict registry for stored values and Admin input',()=>{
  const base=config(),stored={'tasks.maxAttempts':5};
  const before=structuredClone(stored),values=validateValues(stored,base);
  expect(values['tasks.maxAttempts']).toBe(5);expect(values['tasks.retryBaseMs']).toBe(1000);
  expect(applyValues(base,values,17).taskPolicy.maxAttempts).toBe(5);expect(stored).toEqual(before);
  for(const key of ['tasks.futureOptional','$schemaVersion','tasks.downloadTimeoutMs','storage.maxSourceBytes']){
   expect(()=>validateValues({[key]:1},base)).toThrow('CONFIGURATION_KEY_UNKNOWN');
  }
  expect(validateValues({},base)).toEqual(defaults());
 });
 it('keeps the embedding timeout bound to its build snapshot after a configuration change',async()=>{
  const base=config();Object.assign(base.rag,{providerMode:'live',embeddingBaseUrl:'https://embedding.test/v1',embeddingApiKey:'synthetic-fixture-key'});
  const snapshot=snapshotForSource(applyValues(base,{'rag.embeddingTimeoutMs':2000},1),'content_asset','markdown');
  const later=applyValues(base,{'rag.embeddingTimeoutMs':9000},2);let signal:AbortSignal|undefined;
  vi.useFakeTimers();const fetchDouble=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,options)=>new Promise((_resolve,reject)=>{signal=options!.signal as AbortSignal;signal.addEventListener('abort',()=>reject(new DOMException('Fixture timeout','AbortError')),{once:true});}));
  try{
   const request=expect(kbEmbedding(later,snapshot).embed(['fixture'])).rejects.toMatchObject({code:'EMBEDDING_PROVIDER_TIMEOUT'});
   await vi.advanceTimersByTimeAsync(1999);expect(signal?.aborted).toBe(false);
   await vi.advanceTimersByTimeAsync(1);await request;expect(fetchDouble).toHaveBeenCalledTimes(1);
  }finally{fetchDouble.mockRestore();vi.useRealTimers();}
 });
 it('retains explicit A10 ECI fallback without credentials in DB data',()=>{
  const fallback={vpcId:'vpc-unit12345678',securityGroupId:'sg-unit12345678',vSwitchIds:['vsw-unit12345678'],instanceTypes:['ecs.gn7i-c8g1.2xlarge'],image:'huahuo-docker-hub-registry-vpc.cn-beijing.cr.aliyuncs.com/ai_service/xberg:gpu-test',acrInstanceId:'cri-unit12345678',extraStorageGiB:40,bucket:'unit-bucket',keyPrefix:'huahuo'};
  const loaded=nodeConfig({...node,eciFallback:fallback},loadProcessingNodesConfig({}));
  expect(loaded.mode).toBe('ecs');if(loaded.mode==='ecs')expect(loaded.eciFallback?.spec.spot.strategy).toBe('NoSpot');
  expect(JSON.stringify(loaded)).not.toContain('validation-only');
  expect(()=>nodeConfig({...node,resourceClass:'cpu',eciFallback:fallback},loadProcessingNodesConfig({}))).toThrow('PROCESSING_NODE_INVALID');
 });
 it('resolves a named token at the operation boundary and rejects malformed references',()=>{
  const bootstrap=loadProcessingNodesConfig({PROCESSING_NODE_TOKEN_DOCUMENT:'local-test-token'});
  expect(nodeConfig({...node,tokenEnv:'PROCESSING_NODE_TOKEN_DOCUMENT'},bootstrap).apiToken).toBe('local-test-token');
  expect(()=>nodeConfig({...node,tokenEnv:'ALIYUN_RAM_ACCESS_KEY_SECRET'},bootstrap)).toThrow('PROCESSING_NODE_INVALID');
  expect(()=>nodeConfig({...node,tokenEnv:'PROCESSING_NODE_TOKEN_MISSING'},bootstrap)).toThrow('PROCESSING_NODE_TOKEN_UNAVAILABLE');
  expect(nodeConfig({...node,tokenEnv:'PROCESSING_NODE_TOKEN_MISSING'},bootstrap,false).apiToken).toBeUndefined();
 });
});
