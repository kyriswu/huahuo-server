import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalStorageAdapter } from '../../src/modules/storage/port.js';

const directories: string[] = [];
async function storage() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'storage-artifact-test-'));
  directories.push(directory);
  return new LocalStorageAdapter(directory);
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

it('hashes bytes during the write without rereading the staged artifact or interpreting its content', async () => {
  const adapter = await storage();
  const chunks = [Buffer.from('artifact'), Buffer.from([0, 0xff, 0xe4, 0xbd])];
  const digest = createHash('sha256'); for (const chunk of chunks) digest.update(chunk);
  const readFile = vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('WHOLE_FILE_READ_FORBIDDEN'));
  const open = fs.open.bind(fs), reread = vi.fn();
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    vi.spyOn(handle, 'read').mockImplementation(async () => { reread(); throw new Error('ARTIFACT_REREAD_FORBIDDEN'); });
    vi.spyOn(handle, 'createReadStream').mockImplementation(() => { throw new Error('ARTIFACT_REREAD_FORBIDDEN'); });
    return handle;
  });
  const result = await adapter.put('artifact', Readable.from(chunks), 'application/octet-stream', 100);
  expect(result).toEqual({ bytes: 12, sha256: digest.digest('hex'), contentType: 'application/octet-stream', version: 'artifact' });
  expect(readFile).not.toHaveBeenCalled();
  expect(reread).not.toHaveBeenCalled();
});

it('stats an artifact using bounded reads and returns the caller-declared content type', async () => {
  const adapter = await storage();
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0xff);
  await fs.writeFile(join(adapter.root, 'artifact'), bytes);
  const readFile = vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('WHOLE_FILE_READ_FORBIDDEN'));
  const open = fs.open.bind(fs), sizes: number[] = [];
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args), read = handle.read.bind(handle);
    vi.spyOn(handle, 'read').mockImplementation(async (...args: Parameters<typeof handle.read>) => {
      const [buffer] = args;
      if (ArrayBuffer.isView(buffer)) sizes.push(buffer.byteLength);
      return read(...args);
    });
    return handle;
  });
  const result = await adapter.stat('artifact', 'audio/mp4');
  expect(result).toEqual({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentType: 'audio/mp4', version: 'artifact' });
  expect(sizes.length).toBeGreaterThan(2); expect(Math.max(...sizes)).toBeLessThanOrEqual(1024 * 1024);
  expect(readFile).not.toHaveBeenCalled();
});

it('aborts oversized writes and removes their partial files', async () => {
  const adapter = await storage();
  const input = Readable.from([Buffer.from('1234'), Buffer.from('5678')]);
  await expect(adapter.put('large', input, 'application/json', 5)).rejects.toThrow('UPLOAD_TOO_LARGE');
  expect(input.destroyed).toBe(true); expect(await fs.readdir(adapter.root)).toEqual([]);
});

it('cleans failed streams and never overwrites an already published artifact', async () => {
  const adapter = await storage();
  const input = Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('STREAM_FAILED'); })());
  await expect(adapter.put('failed', input, 'application/json', 100)).rejects.toThrow('STREAM_FAILED');
  expect(await fs.readdir(adapter.root)).toEqual([]);
  await adapter.put('artifact', Readable.from([Buffer.from('original')]), 'application/json', 100);
  await expect(adapter.put('artifact', Readable.from([Buffer.from('replacement')]), 'application/json', 100)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await fs.readFile(join(adapter.root, 'artifact'), 'utf8')).toBe('original');
  expect(await fs.readdir(adapter.root)).toEqual(['artifact']);
});

it('does not follow artifact symlinks or hash directories', async () => {
  const adapter = await storage();
  await fs.writeFile(join(adapter.root, 'target'), 'data');
  await fs.symlink(join(adapter.root, 'target'), join(adapter.root, 'link'));
  await expect(adapter.stat('link', 'application/json')).rejects.toMatchObject({ code: 'ELOOP' });
  await fs.mkdir(join(adapter.root, 'folder'));
  await expect(adapter.stat('folder', 'application/json')).rejects.toThrow('STORAGE_NOT_FILE');
});
