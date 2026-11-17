import OSS from 'ali-oss';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { access, mkdtemp } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { AliyunOssStorageAdapter } from '../../src/integrations/object-storage/aliyun-oss.js';
import { testOssConfig } from '../support/oss-upload.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp) };
});

afterEach(async () => {
  for (const call of vi.mocked(mkdtemp).mock.results) {
    if (call.type === 'return') await expect(access(await call.value)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  vi.mocked(mkdtemp).mockClear();
  vi.restoreAllMocks();
});

function response(stream: Readable) {
  const request = vi.spyOn(OSS.prototype, 'request').mockResolvedValue({ res: stream, status: 200, headers: { etag: 'fixture-etag' } });
  const get = vi.spyOn(OSS.prototype, 'get').mockRejectedValue(new Error('BUFFERED_GET_FORBIDDEN'));
  const getStream = vi.spyOn(OSS.prototype, 'getStream');
  return { request, get, getStream };
}

it('hashes server-produced artifact bytes without SDK buffering, then removes staging files', async () => {
  const sdk = response(Readable.from([Buffer.from('hello-'), Buffer.from('storage')]));
  const storage = new AliyunOssStorageAdapter(testOssConfig);
  const object = await storage.stat('resource-id', 'text/plain');
  expect(object).toEqual({ bytes: 13, sha256: createHash('sha256').update('hello-storage').digest('hex'), contentType: 'text/plain', version: 'fixture-etag' });
  expect(sdk.getStream).toHaveBeenCalledWith('uploads/resource-id');
  expect(sdk.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', customResponse: true }));
  expect(sdk.get).not.toHaveBeenCalled();
});

it('aborts an oversized stream and cleans temporary files', async () => {
  const stream = Readable.from([Buffer.from('hello-'), Buffer.from('storage')]);
  const sdk = response(stream);
  const storage = new AliyunOssStorageAdapter({ ...testOssConfig, maxBytes: 8 });
  await expect(storage.stat('resource-id', 'text/plain')).rejects.toThrow('UPLOAD_TOO_LARGE');
  expect(stream.destroyed).toBe(true);
  expect(sdk.get).not.toHaveBeenCalled();
});

it('cleans staging files when the upstream stream fails midway', async () => {
  const stream = Readable.from((async function* () {
    yield Buffer.from('hello-');
    throw new Error('STREAM_INTERRUPTED');
  })());
  const sdk = response(stream);
  await expect(new AliyunOssStorageAdapter(testOssConfig).stat('resource-id', 'text/plain')).rejects.toThrow('STREAM_INTERRUPTED');
  expect(stream.destroyed).toBe(true);
  expect(sdk.get).not.toHaveBeenCalled();
});
