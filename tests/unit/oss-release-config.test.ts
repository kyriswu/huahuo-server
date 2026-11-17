import { describe, expect, it } from 'vitest';
// @ts-expect-error reviewed configuration assertions use portable JavaScript
import { verifyOssConfiguration } from '../../scripts/release/changes/20261117-task-reservation-recovery/verify-config.mjs';
const base={SERVICE_ROLE:'api-server',STORAGE_DRIVER:'aliyun-oss',STORAGE_ALIYUN_OSS_ENDPOINT:'https://oss-cn-beijing.aliyuncs.com',
  STORAGE_ALIYUN_OSS_BUCKET:'fixture-assets',ALIYUN_RAM_ACCESS_KEY_ID:'fixture',ALIYUN_RAM_ACCESS_KEY_SECRET:'fixture'};
describe('OSS candidate configuration, no network',()=>{
  it('checks only roles that access storage',()=>{
    for(const SERVICE_ROLE of ['api-server','worker'])expect(()=>verifyOssConfiguration({...base,SERVICE_ROLE})).not.toThrow();
    for(const SERVICE_ROLE of ['admin','scheduler','migrate'])expect(()=>verifyOssConfiguration({SERVICE_ROLE})).not.toThrow();
  });
  it('requires public signing for an internal service endpoint',()=>{
    const internal={...base,STORAGE_ALIYUN_OSS_ENDPOINT:'https://oss-cn-beijing-internal.aliyuncs.com'};
    expect(()=>verifyOssConfiguration(internal)).toThrow('OSS_PUBLIC_ENDPOINT_REQUIRED');
    expect(()=>verifyOssConfiguration({...internal,STORAGE_ALIYUN_OSS_PUBLIC_ENDPOINT:base.STORAGE_ALIYUN_OSS_ENDPOINT})).not.toThrow();
  });
  it.each([{STORAGE_DRIVER:'local'},{STORAGE_ALIYUN_OSS_BUCKET:''},{ALIYUN_RAM_ACCESS_KEY_SECRET:''},
    {STORAGE_ALIYUN_OSS_PUBLIC_ENDPOINT:'https://user:secret@fixture.test'},
    {STORAGE_ALIYUN_OSS_PUBLIC_ENDPOINT:'https://fixture.test?token=secret'}])('rejects a mismatched candidate without echoing values',patch=>{
    expect(()=>verifyOssConfiguration({...base,...patch})).toThrow(/^OSS_[A-Z_]+$/);
  });
});
