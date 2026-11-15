import {describe,it,expect,vi} from 'vitest';
import {config} from '../helpers.js';
import {defaults,validateValues,applyValues,rejectSecrets} from '../../src/modules/runtime-settings/registry.js';
import {extractionConfig} from '../support/extraction-config.js';
import {nodeConfig,type ProcessingNode} from '../../src/modules/processing-nodes/model.js';
import {loadProcessingNodesConfig} from '../../src/config/processing-nodes.js';
import {kbSnapshot,kbEmbedding} from '../../src/modules/kb/profile.js';

const node:ProcessingNode={id:'11111111-1111-4111-8111-111111111111',name:'GPU node',capabilities:['document'],resourceClass:'gpu',mode:'ecs',regionId:'cn-beijing',instanceId:'i-unit12345678',privateIp:'172.18.102.103',baseUrl:'http://172.18.102.103:8000',healthPath:'/health',tokenEnv:null,concurrency:1,idleSeconds:60,startupSeconds:600,queueSeconds:3600,enabled:false,revision:1};
describe('typed runtime registry (no database/cloud)',()=>{
 it('validates the complete document override and freezes its hash/mode',()=>{
  const extraction=extractionConfig('async');if(!extraction.enabled)throw Error('fixture');
  const c=applyValues(config(),{'document.mode':'async','document.parameters':extraction.parameters,'document.pollMs':100},8);
  expect(c.documentExtraction).toMatchObject({enabled:true,configHash:extraction.configHash,pollMs:100});expect(c.runtimeRevision).toBe(8);
  expect(()=>validateValues({'document.mode':'async'},config())).toThrow('CONFIGURATION_DOCUMENT_REQUIRED');
  expect(()=>validateValues({'document.parameters':{output_format:'markdown'}},config())).toThrow('CONFIGURATION_DOCUMENT_INVALID');
 });
 it('rejects secret field variants, signed URLs, unknown keys, production fixtures and inconsistent bounds',()=>{
  for(const value of [{ocr:{ALIYUN_RAM_ACCESS_KEY_SECRET:'no'}},{ocr:{apiKey:'no'}},{url:'https://a:b@host.test/'},{url:'https://host.test/a?Signature=no'}])expect(()=>rejectSecrets(value)).toThrow('CONFIGURATION_SECRET_FORBIDDEN');
  for(const values of [{'tasks.retryBaseMs':5000,'tasks.retryMaxMs':1000},{'storage.maxUploadBytes':2147483649},{'unknown':true},{'tasks.maxAttempts':1.5}])expect(()=>validateValues(values,config())).toThrow('CONFIGURATION_');
  expect(()=>validateValues({'features.tagProvider':'deterministic'},{...config(),appEnv:'production'})).toThrow('CONFIGURATION_TEST_PROVIDER_FORBIDDEN');
  expect(()=>validateValues({'storage.maxUploadBytes':2000},{...config(),uploadHardMaxBytes:1000})).toThrow('CONFIGURATION_INVALID');
 });
 it('creates independent default JSON snapshots',()=>{const a=defaults(),b=defaults();a['tasks.maxAttempts']=9;expect(b['tasks.maxAttempts']).toBe(3);});
 it('keeps the embedding timeout bound to its build snapshot after a configuration change',async()=>{
  const base=config();Object.assign(base.rag,{providerMode:'live',embeddingBaseUrl:'https://embedding.test/v1',embeddingApiKey:'synthetic-fixture-key'});
  const snapshot=kbSnapshot(applyValues(base,{'rag.embeddingTimeoutMs':2000},1),'note-hybrid','markdown');
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
 });
});
