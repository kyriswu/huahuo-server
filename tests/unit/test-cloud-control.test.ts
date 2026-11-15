import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {loadProcessingNodesConfig} from '../../src/config/processing-nodes.js';
import {loadConfig} from '../../src/config/config.js';
import {env as fixtureEnv} from '../helpers.js';
// @ts-expect-error Reviewed release checks use portable JavaScript.
import {verifyTestCloudControl} from '../../scripts/release/changes/20261116-test-cloud-control/verify-config.mjs';

const credentials={ALIYUN_RAM_ACCESS_KEY_ID:'synthetic-test-ak',ALIYUN_RAM_ACCESS_KEY_SECRET:'synthetic-test-secret'};
describe('cloud-control environment permissions, no live cloud calls',()=>{
 it.each(['api-server','admin','worker','scheduler'] as const)('%s defaults test cloud permission on without enabling private parser calls',role=>{
  const cfg=loadConfig(role,{...fixtureEnv,APP_ENV:'test',PROCESSING_NODES_ENABLED:'false'});
  expect(cfg.processingNodes).toMatchObject({enabled:false,cloudControlEnabled:true});
 });
 it.each(['test','production'])('%s enables cloud control without enabling private parser calls',appEnv=>{
  expect(loadProcessingNodesConfig({APP_ENV:appEnv})).toMatchObject({enabled:false,cloudControlEnabled:true});
  expect(loadProcessingNodesConfig({APP_ENV:appEnv,PROCESSING_NODES_CLOUD_CONTROL_ENABLED:''}).cloudControlEnabled).toBe(true);
  expect(loadProcessingNodesConfig({APP_ENV:appEnv,...credentials,PROCESSING_NODES_CLOUD_CONTROL_ENABLED:'false'}).cloudControlEnabled).toBe(false);
 });
 it('retains the local development default and rejects malformed switches',()=>{
  expect(loadProcessingNodesConfig({APP_ENV:'development'}).cloudControlEnabled).toBe(false);
  expect(loadProcessingNodesConfig({APP_ENV:'development',...credentials}).cloudControlEnabled).toBe(true);
  expect(loadProcessingNodesConfig({}).cloudControlEnabled).toBe(false);
  expect(()=>loadProcessingNodesConfig({APP_ENV:'test',PROCESSING_NODES_CLOUD_CONTROL_ENABLED:'invalid'})).toThrow('INVALID_CONFIG:PROCESSING_NODES_CLOUD_CONTROL_ENABLED');
 });
 it.each(['test','production'])('%s still rejects a cloud operation without complete credentials',async appEnv=>{
  const cfg=loadProcessingNodesConfig({APP_ENV:appEnv});
  expect(cfg.cloudControlEnabled).toBe(true);
  await expect(cfg.credentials()).rejects.toThrow('PROCESSING_NODE_CREDENTIALS_UNAVAILABLE');
 });
 it.each(['api-server','admin','worker','scheduler'])('checks actual %s test deployment permission and RAM presence',role=>{
  const env={APP_ENV:'test',SERVICE_ROLE:role,...credentials};
  for(const control of [undefined,'','true'])expect(()=>verifyTestCloudControl({...env,PROCESSING_NODES_CLOUD_CONTROL_ENABLED:control})).not.toThrow();
  expect(()=>verifyTestCloudControl({...env,APP_ENV:'development'})).toThrow('TEST_APP_ENV_REQUIRED');
  expect(()=>verifyTestCloudControl({...env,PROCESSING_NODES_CLOUD_CONTROL_ENABLED:'false'})).toThrow('TEST_CLOUD_CONTROL_REQUIRED');
  for(const key of ['ALIYUN_RAM_ACCESS_KEY_ID','ALIYUN_RAM_ACCESS_KEY_SECRET'])expect(()=>verifyTestCloudControl({...env,[key]:''})).toThrow('TEST_RAM_CREDENTIALS_REQUIRED');
 });
 it('does not inject cloud credentials into the one-shot migration role',()=>{
  expect(()=>verifyTestCloudControl({APP_ENV:'test',SERVICE_ROLE:'migrate'})).not.toThrow();
 });
 it('runs the reviewed check as a subprocess without printing a failed credential',()=>{
  const script='scripts/release/changes/20261116-test-cloud-control/verify-config.mjs';
  const env={PATH:process.env.PATH,APP_ENV:'test',SERVICE_ROLE:'admin',...credentials,PROCESSING_NODES_CLOUD_CONTROL_ENABLED:'true'};
  expect(execFileSync(process.execPath,[script],{env,encoding:'utf8'})).toBe('');
  try{execFileSync(process.execPath,[script],{env:{...env,ALIYUN_RAM_ACCESS_KEY_SECRET:''},stdio:['ignore','pipe','pipe']});throw Error('EXPECTED_CHECK_FAILURE');}
  catch(error){
   const failed=error as {status?:number;stderr?:Buffer;stdout?:Buffer};expect(failed.status).toBe(1);
   expect(String(failed.stderr)).toBe('TEST_CLOUD_CONTROL_CONFIGURATION_INVALID\n');
   expect(String(failed.stdout)+String(failed.stderr)).not.toContain(credentials.ALIYUN_RAM_ACCESS_KEY_ID);
  }
 });
});
