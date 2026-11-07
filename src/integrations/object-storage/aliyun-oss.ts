/* eslint-disable @typescript-eslint/no-explicit-any */
import OSS from 'ali-oss';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoragePort, StoredObject } from '../../modules/storage/port.js';

export interface AliyunOssConfig {
  region: string;
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  secure: boolean;
  timeoutMs: number;
  keyPrefix?: string;
  maxBytes: number;
}

function objectKey(prefix: string|undefined, key: string): string {
  const clean=key.replace(/^\/+/, '');
  return prefix ? `${prefix.replace(/\/+$/,'')}/${clean}` : clean;
}

/** Generic Aliyun OSS adapter. It deliberately exposes the same port as local/S3 storage. */
export class AliyunOssStorageAdapter implements StoragePort {
  private readonly client:any;
  constructor(readonly config:AliyunOssConfig){this.client=new OSS({region:config.region,endpoint:config.endpoint,bucket:config.bucket,accessKeyId:config.accessKeyId,accessKeySecret:config.accessKeySecret,secure:config.secure,timeout:config.timeoutMs});}
  private async stage(key:string,input:Readable,mime:string,maxBytes:number){const directory=await mkdtemp(join(tmpdir(),'huahuo-oss-'));const {LocalStorageAdapter}=await import('../../modules/storage/port.js');const local=new LocalStorageAdapter(directory);try{return {directory,local,meta:await local.put(key,input,mime,Math.min(maxBytes,this.config.maxBytes))};}catch(error){await rm(directory,{recursive:true,force:true});throw error;}}
  async put(key:string,input:Readable,mime:string,maxBytes:number):Promise<StoredObject>{const staged=await this.stage(key,input,mime,maxBytes);try{const result=await this.client.put(objectKey(this.config.keyPrefix,key),`${staged.directory}/${key}`);return {...staged.meta,version:String(result?.res?.headers?.etag??result?.etag??key)};}finally{await rm(staged.directory,{recursive:true,force:true});}}
  async stat(key:string,mime:string):Promise<StoredObject>{const stagedDir=await mkdtemp(join(tmpdir(),'huahuo-oss-stat-'));const {LocalStorageAdapter}=await import('../../modules/storage/port.js');const local=new LocalStorageAdapter(stagedDir);try{const result=await this.client.get(objectKey(this.config.keyPrefix,key));const body=result?.content;if(body===undefined||body===null)throw new Error('OSS_EMPTY_BODY');const stream=body instanceof Readable?body:Readable.from([Buffer.isBuffer(body)?body:Buffer.from(body)]);const meta=await local.put(key,stream,mime,this.config.maxBytes);return {...meta,version:String(result?.res?.headers?.etag??key)};}finally{await rm(stagedDir,{recursive:true,force:true});}}
  async read(key: string, range?: { start: number; end: number }): Promise<Readable> {
    const name = objectKey(this.config.keyPrefix, key);
    const options = range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : {};
    if (typeof this.client.getStream === 'function') {
      const result = await this.client.getStream(name, options);
      return result.stream as Readable;
    }
    const result = await this.client.get(name, options);
    return Readable.from([Buffer.isBuffer(result.content) ? result.content : Buffer.from(result.content)]);
  }
  async remove(key:string):Promise<void>{await this.client.delete(objectKey(this.config.keyPrefix,key));}
  async deleteMulti(keys:string[]):Promise<void>{if(keys.length===0)return;for(let i=0;i<keys.length;i+=1000)await this.client.deleteMulti(keys.slice(i,i+1000).map(key=>objectKey(this.config.keyPrefix,key)),{quiet:true});}
  async removeMany(keys:string[]):Promise<void>{await this.deleteMulti(keys);}
  signUrl(key:string, expiresSeconds=900):string{return this.client.signatureUrl(objectKey(this.config.keyPrefix,key),{expires:expiresSeconds});}
}
