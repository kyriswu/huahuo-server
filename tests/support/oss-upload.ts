import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import type { ObjectMetadata, SignedObjectOptions } from '../../src/modules/storage/port.js';
import type { AppConfig } from '../../src/config/config.js';
import { AliyunOssStorageAdapter, type AliyunOssConfig } from '../../src/integrations/object-storage/aliyun-oss.js';
import { LocalStorageAdapter } from '../../src/modules/storage/port.js';

export const testOssConfig: AliyunOssConfig = {
  endpoint: 'https://oss-cn-beijing.aliyuncs.com', region: 'cn-beijing', bucket: 'fixture-assets',
  accessKeyId: 'fixture-access-id', accessKeySecret: 'fixture-access-secret', secure: true,
  timeoutMs: 1000, keyPrefix: 'uploads', maxBytes: 1024 * 1024,
};

export function mockOssUploadConfig(config: AppConfig): AppConfig {
  return { ...config, storageDriver: 'aliyun-oss', storageAliyunOss: { ...testOssConfig } };
}

interface FixtureUpload {
  key: string;
  contentType: string;
  sessionId: string;
  part?: { bytes: Buffer; etag: string; reportedBytes?: number };
}

/**
 * OSS is a test double: final objects live on test disk, multipart data in memory.
 * uploadPart() represents the client connection to OSS; only completeUpload()
 * publishes a resource. SDK signing is real and local, with no cloud requests.
 */
export class MockOssStorageAdapter extends LocalStorageAdapter {
  private readonly metadata = new Map<string, ObjectMetadata>();
  private readonly headOverrides = new Map<string, Partial<ObjectMetadata>>();
  private readonly signer = new AliyunOssStorageAdapter(testOssConfig);
  private readonly signPart = this.signer.signUploadPart.bind(this.signer);
  private readonly uploads = new Map<string, FixtureUpload>();
  private readonly signedParts = new Map<string, { key: string; uploadId: string; bytes: number; headers: Record<string,string>; expires: number }>();
  override async put(key:string,input:Readable,contentType:string,maxBytes:number){
    const result=await super.put(key,input,contentType,maxBytes);
    this.metadata.set(key,{bytes:result.bytes,contentType:result.contentType,version:`etag:"fixture-${key}"`,etag:`"fixture-${key}"`});
    return result;
  }
  /** Fixture response metadata; this performs no content sniffing or hashing. */
  async head(key:string):Promise<ObjectMetadata>{
    const metadata=this.metadata.get(key);
    if(!metadata)throw Object.assign(new Error('NoSuchKey'),{code:'NoSuchKey'});
    const object=await stat(join(this.root,key));
    return {...metadata,bytes:object.size,...this.headOverrides.get(key)};
  }
  setHeadMetadata(key:string,overrides:Partial<ObjectMetadata>):void{this.headOverrides.set(key,overrides);}
  signUrl(key:string,expiresSeconds?:number,options?:SignedObjectOptions){return this.signer.signUrl(key,expiresSeconds,options);}

  async beginUpload(key: string, contentType: string, sessionId: string): Promise<string> {
    const id = randomUUID();
    this.uploads.set(id, { key, contentType, sessionId });
    return id;
  }

  async signUploadPart(key: string, uploadId: string, contentType: string, bytes: number, expiresSeconds: number) {
    this.upload(key, uploadId);
    const signed = await this.signPart(key, uploadId, contentType, bytes, expiresSeconds);
    this.signedParts.set(signed.url, { key, uploadId, bytes, headers: signed.headers, expires: Date.now() + expiresSeconds * 1000 });
    return signed;
  }

  async uploadPart(url: string|null, bytes: Buffer, headers?: Record<string,string>): Promise<void> {
    const signed = url?this.signedParts.get(url):undefined;
    if (!signed || signed.expires <= Date.now()) throw Object.assign(new Error('AccessDenied'), { code: 'AccessDenied' });
    const upload = this.upload(signed.key, signed.uploadId);
    if (bytes.length !== signed.bytes || (headers && Object.entries(signed.headers).some(([key,value]) => headers[key] !== value))) {
      throw Object.assign(new Error('SignatureDoesNotMatch'), { code: 'SignatureDoesNotMatch' });
    }
    upload.part = { bytes: Buffer.from(bytes), etag: `"${createHash('md5').update(bytes).digest('hex')}"` };
  }

  async inspectUploadPart(key: string, uploadId: string): Promise<{ bytes: number; etag: string }> {
    const part = this.upload(key, uploadId).part;
    if (!part) throw Object.assign(new Error('UPLOAD_PARTS_INVALID'), { code: 'UPLOAD_PARTS_INVALID' });
    return { bytes: part.reportedBytes ?? part.bytes.length, etag: part.etag };
  }

  /** Simulates inconsistent provider metadata without weakening client signature checks. */
  setPartSize(uploadId: string, bytes: number): void {
    const upload = this.uploads.get(uploadId);
    if (!upload?.part) throw new Error('FIXTURE_PART_REQUIRED');
    upload.part.reportedBytes = bytes;
  }

  async completeUpload(key: string, uploadId: string, etag: string): Promise<void> {
    const upload = this.upload(key, uploadId);
    if (!upload.part || upload.part.etag !== etag) throw Object.assign(new Error('InvalidPart'), { code: 'InvalidPart' });
    const result = await this.put(key, Readable.from([upload.part.bytes]), upload.contentType, upload.part.bytes.length);
    this.metadata.set(key, {
      bytes: result.bytes, contentType: upload.contentType, version: `oss-version:${randomUUID()}`,
      etag: upload.part.etag, uploadSessionId: upload.sessionId,
    });
    this.uploads.delete(uploadId);
  }

  async abortUpload(key: string, uploadId: string): Promise<'aborted'|'missing'> {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) return 'missing';
    this.uploads.delete(uploadId);
    return 'aborted';
  }

  override async remove(key: string, version?: string): Promise<void> {
    const metadata = this.metadata.get(key);
    if (metadata && version && version !== metadata.version) throw Object.assign(new Error('NoSuchVersion'), { code: 'NoSuchVersion' });
    await super.remove(key);
    this.metadata.delete(key);
    this.headOverrides.delete(key);
  }

  private upload(key: string, uploadId: string): FixtureUpload {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) throw Object.assign(new Error('STORAGE_UPLOAD_NOT_FOUND'), { code: 'STORAGE_UPLOAD_NOT_FOUND' });
    return upload;
  }
}
