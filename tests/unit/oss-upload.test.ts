import OSS from 'ali-oss';
import { afterEach, expect, it, vi } from 'vitest';
import { AliyunOssStorageAdapter } from '../../src/integrations/object-storage/aliyun-oss.js';
import { testOssConfig } from '../support/oss-upload.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('signs only part 1 with the real OSS SDK, binding method, path, upload ID, size and MIME', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T06:00:00Z'));
  const request = vi.spyOn(OSS.prototype, 'request').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  const storage = new AliyunOssStorageAdapter(testOssConfig);
  const signed = await storage.signUploadPart('resource-id', 'remote-upload-id', 'text/plain', 13, 3600);
  const url = new URL(signed.url);
  expect(url.origin).toBe('https://fixture-assets.oss-cn-beijing.aliyuncs.com');
  expect(url.pathname).toBe('/uploads/resource-id');
  expect(url.searchParams.get('x-oss-signature-version')).toBe('OSS4-HMAC-SHA256');
  expect(url.searchParams.get('x-oss-credential')).toBe('fixture-access-id/20261117/cn-beijing/oss/aliyun_v4_request');
  expect(url.searchParams.get('x-oss-date')).toBe('20261117T060000Z');
  expect(url.searchParams.get('x-oss-expires')).toBe('3600');
  expect(url.searchParams.get('x-oss-additional-headers')).toBe('content-length');
  expect(url.searchParams.get('uploadId')).toBe('remote-upload-id');
  expect(url.searchParams.get('partNumber')).toBe('1');
  expect(signed.headers).toEqual({ 'Content-Type': 'text/plain', 'Content-Length': '13' });
  const { region, endpoint, bucket, accessKeyId, accessKeySecret, secure } = testOssConfig;
  const sdk = new OSS({ region, endpoint, bucket, accessKeyId, accessKeySecret, secure });
  const queries={uploadId:'remote-upload-id',partNumber:1};
  const signature = async (method: string, headers: Record<string, string>, path = 'uploads/resource-id', query:Record<string,string|number> = queries) =>
    new URL(await sdk.signatureUrlV4(method, 3600, { headers,queries:query }, path, ['content-length'])).searchParams.get('x-oss-signature');
  const expected = url.searchParams.get('x-oss-signature');
  expect(expected).toMatch(/^[a-f0-9]{64}$/);
  expect(await signature('PUT', signed.headers)).toBe(expected);
  expect(await signature('GET', signed.headers)).not.toBe(expected);
  expect(await signature('POST', signed.headers)).not.toBe(expected);
  expect(await signature('PUT', { ...signed.headers, 'Content-Length': '14' })).not.toBe(expected);
  expect(await signature('PUT', { ...signed.headers, 'Content-Type': 'image/png' })).not.toBe(expected);
  expect(await signature('PUT', signed.headers, 'uploads/another-resource')).not.toBe(expected);
  expect(await signature('PUT', signed.headers, 'uploads/resource-id',{...queries,uploadId:'another-upload-id'})).not.toBe(expected);
  expect(await signature('PUT', signed.headers, 'uploads/resource-id',{...queries,partNumber:2})).not.toBe(expected);
  expect(await signature('PUT', signed.headers, 'uploads/resource-id',{})).not.toBe(expected);
  expect(request).not.toHaveBeenCalled();
});

const partEtag='"D41D8CD98F00B204E9800998ECF8427E"';
const part={PartNumber:'1',Size:'13',ETag:partEtag};
function listed(parts:unknown=part,isTruncated='false'){
  return {res:{status:200,headers:{}},data:{UploadId:'remote-upload-id',Bucket:'fixture-assets',Key:'uploads/resource-id',IsTruncated:isTruncated,Part:parts}};
}

it('initiates an upload with server-owned MIME and session identity, without file bytes', async()=>{
  const request=vi.spyOn(OSS.prototype,'request').mockResolvedValue({res:{status:200,headers:{}},data:{UploadId:'remote-upload-id'}});
  const storage=new AliyunOssStorageAdapter(testOssConfig);
  expect(await storage.beginUpload('resource-id','text/plain','application-session-id')).toBe('remote-upload-id');
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    method:'POST',object:'uploads/resource-id',subres:'uploads',mime:'text/plain',
    headers:expect.objectContaining({'x-oss-meta-upload-session':'application-session-id','x-oss-forbid-overwrite':'true'}),
  }));
  const params=request.mock.calls[0]![0] as Record<string,unknown>;
  expect(params.stream).toBeUndefined();expect(params.content).toBeUndefined();
});

it('retains initialization errors as unknown results and rejects missing remote IDs',async()=>{
  const lost=Object.assign(new Error('response lost'),{code:'ResponseTimeoutError'});
  const request=vi.spyOn(OSS.prototype,'request').mockRejectedValueOnce(lost).mockResolvedValueOnce({res:{status:200,headers:{}},data:{}});
  const storage=new AliyunOssStorageAdapter(testOssConfig);
  await expect(storage.beginUpload('resource-id','text/plain','application-session-id')).rejects.toBe(lost);
  await expect(storage.beginUpload('resource-id','text/plain','application-session-id')).rejects.toMatchObject({code:'STORAGE_UPLOAD_RESPONSE_INVALID'});
  expect(request).toHaveBeenCalledTimes(2);
});

it.each([{parts:part},{parts:[part]},{parts:{...part,Size:'1'}}])('inspects exactly one uploaded part, including a sole part under 100 KB: %s',async({parts})=>{
  const request=vi.spyOn(OSS.prototype,'request').mockResolvedValue(listed(parts));
  const storage=new AliyunOssStorageAdapter(testOssConfig);
  expect(await storage.inspectUploadPart('resource-id','remote-upload-id')).toEqual({bytes:Array.isArray(parts)?13:Number(parts.Size),etag:partEtag});
  expect(request).toHaveBeenCalledWith(expect.objectContaining({method:'GET',object:'uploads/resource-id',subres:{uploadId:'remote-upload-id'},query:{'max-parts':2}}));
});

it.each([
  [[], 'false'], [[part, {...part,PartNumber:'2'}], 'false'], [part, 'true'],
  [part, ''], [{...part,PartNumber:'2'},'false'], [{...part,Size:'0'},'false'],
  [{...part,Size:'13.5'},'false'], [{...part,Size:String(5*1024*1024*1024+1)},'false'],
  [{...part,ETag:'"invalid"'},'false'], [{...part,ETag:'</ETag><PartNumber>2</PartNumber>'},'false'],
])('rejects missing, unexpected or malformed parts: %s / truncated=%s',async(parts,truncated)=>{
  vi.spyOn(OSS.prototype,'request').mockResolvedValue(listed(parts,truncated as string));
  await expect(new AliyunOssStorageAdapter(testOssConfig).inspectUploadPart('resource-id','remote-upload-id')).rejects.toMatchObject({code:'UPLOAD_PARTS_INVALID'});
});

it('completes only the inspected part and never grants the client completion permission',async()=>{
  const request=vi.spyOn(OSS.prototype,'request').mockResolvedValueOnce(listed()).mockResolvedValueOnce({res:{status:200,headers:{etag:partEtag}}});
  const storage=new AliyunOssStorageAdapter(testOssConfig);
  const inspected=await storage.inspectUploadPart('resource-id','remote-upload-id');
  await storage.completeUpload('resource-id','remote-upload-id',inspected.etag);
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({
    method:'POST',object:'uploads/resource-id',subres:{uploadId:'remote-upload-id'},
    headers:expect.objectContaining({'x-oss-forbid-overwrite':'true'}),
    content:`<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>\n<Part>\n<PartNumber>1</PartNumber>\n<ETag>${partEtag}</ETag>\n</Part>\n</CompleteMultipartUpload>`,
  }));
  expect(request).toHaveBeenCalledTimes(2);
  await expect(storage.completeUpload('resource-id','remote-upload-id','</ETag>')).rejects.toMatchObject({code:'UPLOAD_PARTS_INVALID'});
  expect(request).toHaveBeenCalledTimes(2);
});

it.each(['inspectUploadPart','completeUpload'] as const)('maps only NoSuchUpload to a recoverable missing-upload error in %s',async method=>{
  const missing=Object.assign(new Error('gone'),{code:'NoSuchUpload'});
  const timeout=Object.assign(new Error('unknown completion result'),{code:'ResponseTimeoutError'});
  const forbidden=Object.assign(new Error('forbidden'),{code:'AccessDenied'});
  vi.spyOn(OSS.prototype,'request').mockRejectedValueOnce(missing).mockRejectedValueOnce(timeout).mockRejectedValueOnce(forbidden);
  const storage=new AliyunOssStorageAdapter(testOssConfig);
  const operation=()=>method==='completeUpload'?storage.completeUpload('resource-id','remote-upload-id',partEtag):storage.inspectUploadPart('resource-id','remote-upload-id');
  await expect(operation()).rejects.toMatchObject({code:'STORAGE_UPLOAD_NOT_FOUND',cause:missing});
  await expect(operation()).rejects.toBe(timeout);
  await expect(operation()).rejects.toBe(forbidden);
});

it('aborts by exact key and upload ID and treats only NoSuchUpload as missing',async()=>{
  const missing=Object.assign(new Error('gone'),{code:'NoSuchUpload'});
  const unknown404=Object.assign(new Error('unknown'),{status:404});
  const request=vi.spyOn(OSS.prototype,'request').mockResolvedValueOnce({res:{status:204,headers:{}}}).mockRejectedValueOnce(missing).mockRejectedValueOnce(unknown404);
  const storage=new AliyunOssStorageAdapter(testOssConfig);
  await expect(storage.abortUpload('resource-id','remote-upload-id')).resolves.toBe('aborted');
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({method:'DELETE',object:'uploads/resource-id',subres:{uploadId:'remote-upload-id'}}));
  await expect(storage.abortUpload('resource-id','remote-upload-id')).resolves.toBe('missing');
  await expect(storage.abortUpload('resource-id','remote-upload-id')).rejects.toBe(unknown404);
});

it('reads the server-set upload session from HEAD for unknown-completion recovery',async()=>{
  const headers={'content-length':'13','content-type':'text/plain',etag:partEtag,'x-oss-version-id':'version-id','x-oss-meta-upload-session':'application-session-id'};
  const invalidHeaders={...headers,'x-oss-meta-upload-session':'bad\r\nvalue'};
  const request=vi.spyOn(OSS.prototype,'request').mockResolvedValueOnce({status:200,headers,res:{headers}}).mockResolvedValueOnce({status:200,headers:invalidHeaders,res:{headers:invalidHeaders}});
  const storage=new AliyunOssStorageAdapter(testOssConfig);
  expect(await storage.head('resource-id')).toEqual({bytes:13,contentType:'text/plain',etag:partEtag,version:'oss-version:version-id',uploadSessionId:'application-session-id'});
  await expect(storage.head('resource-id')).rejects.toThrow('STORAGE_METADATA_INVALID');
  expect(request).toHaveBeenCalledTimes(2);
});

it.each([1000,120000])('bounds control requests to at most 10 seconds while preserving lower configured timeouts: %s',async timeoutMs=>{
  const request=vi.spyOn(OSS.prototype,'request');
  const storage=new AliyunOssStorageAdapter({...testOssConfig,timeoutMs});
  request.mockResolvedValueOnce({res:{status:200,headers:{}},data:{UploadId:'remote-upload-id'}});
  await storage.beginUpload('resource-id','text/plain','application-session-id');
  request.mockResolvedValueOnce(listed());
  await storage.inspectUploadPart('resource-id','remote-upload-id');
  request.mockResolvedValueOnce({res:{status:200,headers:{etag:partEtag}}});
  await storage.completeUpload('resource-id','remote-upload-id',partEtag);
  request.mockResolvedValueOnce({res:{status:204,headers:{}}});
  await storage.abortUpload('resource-id','remote-upload-id');
  const headers={'content-length':'13','content-type':'text/plain',etag:partEtag};
  request.mockResolvedValueOnce({status:200,headers,res:{headers}});
  await storage.head('resource-id');
  expect(request).toHaveBeenCalledTimes(5);
  for(const [params] of request.mock.calls)expect((params as Record<string,unknown>).timeout).toBe(Math.min(timeoutMs,10000));
});

it('rejects malformed upload arguments locally without issuing network requests or signatures',async()=>{
  const request=vi.spyOn(OSS.prototype,'request').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  const storage=new AliyunOssStorageAdapter(testOssConfig);
  for(const [bytes,ttl] of [[0,300],[13.5,300],[testOssConfig.maxBytes+1,300],[13,0],[13,7*24*3600+1]]){
    await expect(storage.signUploadPart('resource-id','remote-upload-id','text/plain',bytes!,ttl!)).rejects.toMatchObject({code:'STORAGE_UPLOAD_ARGUMENT_INVALID'});
  }
  await expect(storage.beginUpload('resource-id','text/plain\r\nx-bad:1','application-session-id')).rejects.toMatchObject({code:'STORAGE_UPLOAD_ARGUMENT_INVALID'});
  await expect(storage.beginUpload('resource-id','text/plain','session with whitespace')).rejects.toMatchObject({code:'STORAGE_UPLOAD_ARGUMENT_INVALID'});
  await expect(storage.signUploadPart('resource-id','','text/plain',13,300)).rejects.toMatchObject({code:'STORAGE_UPLOAD_ARGUMENT_INVALID'});
  expect(request).not.toHaveBeenCalled();
});

it('signs public GET URLs without a MIME override, preserving encoding, disposition and actual version IDs', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-17T06:00:00Z'));
  const request = vi.spyOn(OSS.prototype, 'request').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  const storage = new AliyunOssStorageAdapter({ ...testOssConfig, endpoint: 'https://oss-cn-beijing-internal.aliyuncs.com', publicEndpoint: testOssConfig.endpoint });
  const options = { contentDisposition: 'inline; filename="extraction.json"', contentEncoding: 'gzip', version: 'oss-version:real-object-version' };
  const signed = new URL(await storage.signUrl('extraction.json.gz', 300, options));
  expect(signed.origin).toBe('https://fixture-assets.oss-cn-beijing.aliyuncs.com');
  expect(signed.searchParams.has('response-content-type')).toBe(false);
  expect(signed.searchParams.get('response-content-disposition')).toBe(options.contentDisposition);
  expect(signed.searchParams.get('response-content-encoding')).toBe('gzip');
  expect(signed.searchParams.get('versionId')).toBe('real-object-version');
  const sdk = new OSS(testOssConfig);
  const queries = Object.fromEntries(['response-content-disposition', 'response-content-encoding', 'versionId'].map(key => [key, signed.searchParams.get(key)!]));
  const signature = async (changed = queries) => new URL(await sdk.signatureUrlV4('GET', 300, { queries: changed }, 'uploads/extraction.json.gz')).searchParams.get('x-oss-signature');
  expect(await signature()).toBe(signed.searchParams.get('x-oss-signature'));
  expect(await signature({ ...queries, 'response-content-encoding': 'identity' })).not.toBe(signed.searchParams.get('x-oss-signature'));
  const etag = new URL(await storage.signUrl('resource-id', 300, { version: 'etag:"fixture-etag"' }));
  expect(etag.searchParams.has('versionId')).toBe(false);
  await expect(storage.signUploadPart('resource-id', 'remote-upload-id', 'text/plain', 13, 300)).resolves.toMatchObject({ url: expect.stringContaining('fixture-assets.oss-cn-beijing.aliyuncs.com') });
  expect(() => storage.signUrl('resource-id', 300, { contentDisposition: 'inline\r\nx-bad: true' })).toThrow('STORAGE_RESPONSE_HEADER_INVALID');
  expect(request).not.toHaveBeenCalled();
});
