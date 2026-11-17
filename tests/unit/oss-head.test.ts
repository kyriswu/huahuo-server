import OSS from 'ali-oss';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AliyunOssStorageAdapter } from '../../src/integrations/object-storage/aliyun-oss.js';
import { MockOssStorageAdapter, testOssConfig } from '../support/oss-upload.js';

afterEach(() => vi.restoreAllMocks());
const valid = { 'content-length': '13', 'content-type': 'text/plain; charset=utf-8', etag: '"fixture-etag"' };
function response(headers: Record<string, string | undefined>, status = 200) {
  return vi.spyOn(OSS.prototype, 'request').mockResolvedValue({ status, headers, res: { headers } });
}
it('confirms HEAD metadata without downloading or inspecting original bytes', async () => {
  const request = response(valid);
  const get = vi.spyOn(OSS.prototype, 'get').mockRejectedValue(new Error('GET_FORBIDDEN'));
  const getStream = vi.spyOn(OSS.prototype, 'getStream').mockRejectedValue(new Error('GET_FORBIDDEN'));
  expect(await new AliyunOssStorageAdapter(testOssConfig).head('resource-id')).toEqual({ bytes: 13, contentType: 'text/plain', etag: '"fixture-etag"', version: 'etag:"fixture-etag"' });
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'HEAD', object: 'uploads/resource-id' }));
  expect(get).not.toHaveBeenCalled(); expect(getStream).not.toHaveBeenCalled();
});
it('distinguishes an OSS version ID from an ETag', async () => {
  response({ ...valid, 'x-oss-version-id': 'real-object-version' });
  expect((await new AliyunOssStorageAdapter(testOssConfig).head('resource-id')).version).toBe('oss-version:real-object-version');
});
it('deletes the exact signed OSS version instead of leaving it behind a delete marker', async () => {
  const request=vi.spyOn(OSS.prototype,'request').mockResolvedValue({status:204,res:{status:204}});
  const storage=new AliyunOssStorageAdapter(testOssConfig);
  await storage.remove('resource-id','oss-version:real-object-version');
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({method:'DELETE',object:'uploads/resource-id',subres:{versionId:'real-object-version'}}));
  await storage.remove('resource-id','etag:"fixture-etag"');
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({method:'DELETE',object:'uploads/resource-id',subres:{}}));
  await expect(storage.remove('resource-id','oss-version:')).rejects.toThrow('STORAGE_VERSION_INVALID');
  expect(request).toHaveBeenCalledTimes(2);
});
it.each([
  { ...valid, 'content-length': '' }, { ...valid, 'content-length': '-1' }, { ...valid, 'content-length': '13.1' },
  { ...valid, 'content-length': '9007199254740992' }, { ...valid, 'content-type': 'invalid' },
  { ...valid, 'content-type': 'text/plain\r\nx-test: value' }, { ...valid, etag: '' },
  { ...valid, 'x-oss-version-id': '' },
  { 'content-length': '13', etag: '"fixture-etag"' },
  { 'content-type': 'text/plain', etag: '"fixture-etag"' },
])('rejects incomplete or malformed metadata: %s', async headers => {
  response(headers);
  await expect(new AliyunOssStorageAdapter(testOssConfig).head('resource-id')).rejects.toThrow('STORAGE_METADATA_INVALID');
});
it('does not accept a HEAD response without fresh object metadata', async () => {
  response(valid, 304);
  await expect(new AliyunOssStorageAdapter(testOssConfig).head('resource-id')).rejects.toThrow('STORAGE_METADATA_INVALID');
});
it('exposes fixture HEAD overrides without confusing metadata with byte validation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oss-head-test-'));
  try {
    const storage = new MockOssStorageAdapter(directory);
    await storage.put('resource-id', Readable.from(['fixture']), 'text/plain', 100);
    storage.setHeadMetadata('resource-id', { bytes: 99, contentType: 'image/png' });
    expect(await storage.head('resource-id')).toMatchObject({ bytes: 99, contentType: 'image/png', etag: '"fixture-resource-id"' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
