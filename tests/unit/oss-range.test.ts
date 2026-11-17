import OSS from 'ali-oss';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { expect, it, vi } from 'vitest';
import { AliyunOssStorageAdapter } from '../../src/integrations/object-storage/aliyun-oss.js';

it('passes the section range to the OSS SDK as an HTTP Range header', async () => {
  const get = vi.spyOn(OSS.prototype, 'get').mockRejectedValue(new Error('BUFFERED_GET_FORBIDDEN'));
  const request = vi.spyOn(OSS.prototype, 'request').mockResolvedValue({
    res: Readable.from([Buffer.from('原文')]), status: 206, headers: {},
  });
  try {
    const storage = new AliyunOssStorageAdapter({
      region: 'oss-cn-hangzhou', endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', bucket: 'section-test',
      accessKeyId: 'test-id', accessKeySecret: 'test-secret', secure: true, timeoutMs: 1000, keyPrefix: 'docs', maxBytes: 1024,
    });
    const stream = await storage.read('canonical.md', { start: 9, end: 14 });
    expect((await buffer(stream)).toString('utf8')).toBe('原文');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET', object: 'docs/canonical.md', headers: expect.objectContaining({ Range: 'bytes=9-14' }),
    }));
    expect(get).not.toHaveBeenCalled();
  } finally {
    request.mockRestore();
    get.mockRestore();
  }
});
