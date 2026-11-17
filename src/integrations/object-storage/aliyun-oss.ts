/* eslint-disable @typescript-eslint/no-explicit-any */
import OSS from 'ali-oss';
import type { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoragePort, StoredObject, ObjectMetadata, SignedObjectOptions, UploadedPart, SignedUpload } from '../../modules/storage/port.js';

export interface AliyunOssConfig {
  region: string;
  endpoint: string;
  publicEndpoint?: string;
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

function invalidHeader(value:string,space=false):boolean {
  for(const char of value){const code=char.charCodeAt(0);if(code<=(space?32:31)||code===127)return true;}
  return false;
}
function ossVersion(value:string|undefined):string|undefined {
  if(!value?.startsWith('oss-version:'))return;
  const version=value.slice('oss-version:'.length);
  if(!version||version.length>1024||invalidHeader(version,true))throw new Error('STORAGE_VERSION_INVALID');
  return version;
}
const singlePartMaxBytes=5*1024*1024*1024;
function uploadError(code:string,cause?:unknown):Error & {code:string} {
  return Object.assign(new Error(code,{cause}),{code});
}
function missingUpload(error:unknown):boolean {
  return typeof error==='object'&&error!==null&&'code' in error&&error.code==='NoSuchUpload';
}
function uploadId(value:unknown,code='STORAGE_UPLOAD_ARGUMENT_INVALID'):string {
  if(typeof value!=='string'||!value||value.length>1024||invalidHeader(value,true))throw uploadError(code);
  return value;
}
function uploadSession(value:unknown,code='STORAGE_UPLOAD_ARGUMENT_INVALID'):string {
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/u.test(value))throw uploadError(code);
  return value;
}
function partEtag(value:unknown):string {
  if(typeof value!=='string'||!/^(?:"[a-fA-F0-9]{32}"|[a-fA-F0-9]{32})$/u.test(value))throw uploadError('UPLOAD_PARTS_INVALID');
  return value;
}
function uploadContentType(value:string):void {
  if(invalidHeader(value)||!/^[-\w!#$&^.+]+\/[-\w!#$&^.+]+$/u.test(value))throw uploadError('STORAGE_UPLOAD_ARGUMENT_INVALID');
}

/** Generic Aliyun OSS adapter. It deliberately exposes the same port as local/S3 storage. */
export class AliyunOssStorageAdapter implements StoragePort {
  private readonly client:any;
  private readonly signer:any;
  private readonly controlTimeoutMs:number;
  constructor(readonly config:AliyunOssConfig){
    const options={region:config.region,bucket:config.bucket,accessKeyId:config.accessKeyId,accessKeySecret:config.accessKeySecret,secure:config.secure,timeout:config.timeoutMs};
    this.client=new OSS({...options,endpoint:config.endpoint});
    this.signer=new OSS({...options,endpoint:config.publicEndpoint??config.endpoint});
    this.controlTimeoutMs=Math.min(config.timeoutMs,10000);
  }
  private async stage(key:string,input:Readable,mime:string,maxBytes:number){const directory=await mkdtemp(join(tmpdir(),'huahuo-oss-'));const {LocalStorageAdapter}=await import('../../modules/storage/port.js');const local=new LocalStorageAdapter(directory);try{return {directory,local,meta:await local.put(key,input,mime,Math.min(maxBytes,this.config.maxBytes))};}catch(error){await rm(directory,{recursive:true,force:true});throw error;}}
  async put(key:string,input:Readable,mime:string,maxBytes:number):Promise<StoredObject>{const staged=await this.stage(key,input,mime,maxBytes);try{const result=await this.client.put(objectKey(this.config.keyPrefix,key),`${staged.directory}/${key}`);return {...staged.meta,version:String(result?.res?.headers?.etag??result?.etag??key)};}finally{await rm(staged.directory,{recursive:true,force:true});}}
  async stat(key:string,mime:string):Promise<StoredObject>{const stagedDir=await mkdtemp(join(tmpdir(),'huahuo-oss-stat-'));const {LocalStorageAdapter}=await import('../../modules/storage/port.js');const local=new LocalStorageAdapter(stagedDir);try{const result=await this.client.getStream(objectKey(this.config.keyPrefix,key));const meta=await local.put(key,result.stream,mime,this.config.maxBytes);return {...meta,version:String(result?.res?.headers?.etag??key)};}finally{await rm(stagedDir,{recursive:true,force:true});}}
  /** Confirm OSS response metadata only. This does not inspect bytes, hash or media format. */
  async head(key:string):Promise<ObjectMetadata>{
    const result=await this.client.head(objectKey(this.config.keyPrefix,key),{timeout:this.controlTimeoutMs});
    const headers=result?.res?.headers;
    if(result?.status!==200||!headers)throw new Error('STORAGE_METADATA_INVALID');
    const length=headers['content-length'], type=headers['content-type'], etag=headers.etag, version=headers['x-oss-version-id'], session=headers['x-oss-meta-upload-session'];
    if(typeof length!=='string'||!/^\d+$/u.test(length)||!Number.isSafeInteger(Number(length))||Number(length)<0)throw new Error('STORAGE_METADATA_INVALID');
    if(typeof type!=='string'||invalidHeader(type)||!/^[-\w!#$&^.+]+\/[-\w!#$&^.+]+(?:\s*;[^\r\n]*)?$/u.test(type))throw new Error('STORAGE_METADATA_INVALID');
    if(typeof etag!=='string'||!etag.trim()||etag.length>1024||invalidHeader(etag,true))throw new Error('STORAGE_METADATA_INVALID');
    if(version!==undefined&&(typeof version!=='string'||!version||version.length>1024||invalidHeader(version,true)))throw new Error('STORAGE_METADATA_INVALID');
    return {bytes:Number(length),contentType:type.split(';',1)[0]!.trim().toLowerCase(),etag,version:version&&version!=='null'?`oss-version:${version}`:`etag:${etag}`,...(session===undefined?{}:{uploadSessionId:uploadSession(session,'STORAGE_METADATA_INVALID')})};
  }
  async read(key: string, range?: { start: number; end: number }): Promise<Readable> {
    const name = objectKey(this.config.keyPrefix, key);
    const options = range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : {};
    const result = await this.client.getStream(name, options);
    return result.stream as Readable;
  }
  async remove(key:string,version?:string):Promise<void>{const versionId=ossVersion(version);await this.client.delete(objectKey(this.config.keyPrefix,key),{...(versionId?{versionId}:{}),timeout:this.controlTimeoutMs});}
  async deleteMulti(keys:string[]):Promise<void>{if(keys.length===0)return;for(let i=0;i<keys.length;i+=1000)await this.client.deleteMulti(keys.slice(i,i+1000).map(key=>objectKey(this.config.keyPrefix,key)),{quiet:true});}
  async removeMany(keys:string[]):Promise<void>{await this.deleteMulti(keys);}
  /** Only the Server can initiate or publish an upload. The client receives a part-1 PUT capability. */
  async beginUpload(key:string,contentType:string,uploadSessionId:string):Promise<string>{
    uploadContentType(contentType);
    const result=await this.client.initMultipartUpload(objectKey(this.config.keyPrefix,key),{
      mime:contentType,meta:{'upload-session':uploadSession(uploadSessionId)},headers:{'x-oss-forbid-overwrite':'true'},timeout:this.controlTimeoutMs,
    });
    return uploadId(result?.uploadId,'STORAGE_UPLOAD_RESPONSE_INVALID');
  }
  async signUploadPart(key:string,remoteUploadId:string,contentType:string,bytes:number,expiresSeconds:number):Promise<SignedUpload>{
    uploadContentType(contentType);
    if(!Number.isSafeInteger(bytes)||bytes<1||bytes>Math.min(singlePartMaxBytes,this.config.maxBytes)||!Number.isSafeInteger(expiresSeconds)||expiresSeconds<1||expiresSeconds>7*24*3600)throw uploadError('STORAGE_UPLOAD_ARGUMENT_INVALID');
    const headers={'Content-Type':contentType,'Content-Length':String(bytes)};
    const queries={uploadId:uploadId(remoteUploadId),partNumber:1};
    const url=await this.signer.signatureUrlV4('PUT',expiresSeconds,{headers,queries},objectKey(this.config.keyPrefix,key),['content-length']);
    return {url,headers};
  }
  async inspectUploadPart(key:string,remoteUploadId:string):Promise<UploadedPart>{
    let result;
    try{result=await this.client.listParts(objectKey(this.config.keyPrefix,key),uploadId(remoteUploadId),{'max-parts':2},{timeout:this.controlTimeoutMs});}
    catch(error){if(missingUpload(error))throw uploadError('STORAGE_UPLOAD_NOT_FOUND',error);throw error;}
    const parts=Array.isArray(result?.parts)?result.parts:result?.parts?[result.parts]:[];
    if(result?.isTruncated!=='false'||parts.length!==1)throw uploadError('UPLOAD_PARTS_INVALID');
    const part=parts[0],size=String(part?.Size);
    if(String(part?.PartNumber)!=='1'||!/^\d+$/u.test(size)||!Number.isSafeInteger(Number(size))||Number(size)<1||Number(size)>singlePartMaxBytes)throw uploadError('UPLOAD_PARTS_INVALID');
    // A sole part is also the last part: OSS permits it to be smaller than 100 KB.
    return {bytes:Number(size),etag:partEtag(part?.ETag)};
  }
  async completeUpload(key:string,remoteUploadId:string,etag:string):Promise<void>{
    try{await this.client.completeMultipartUpload(objectKey(this.config.keyPrefix,key),uploadId(remoteUploadId),[{number:1,etag:partEtag(etag)}],{headers:{'x-oss-forbid-overwrite':'true'},timeout:this.controlTimeoutMs});}
    catch(error){if(missingUpload(error))throw uploadError('STORAGE_UPLOAD_NOT_FOUND',error);throw error;}
  }
  async abortUpload(key:string,remoteUploadId:string):Promise<'aborted'|'missing'>{
    try{await this.client.abortMultipartUpload(objectKey(this.config.keyPrefix,key),uploadId(remoteUploadId),{timeout:this.controlTimeoutMs});return 'aborted';}
    catch(error){if(missingUpload(error))return 'missing';throw error;}
  }
  signUrl(key:string, expiresSeconds=900, options:SignedObjectOptions={}):Promise<string>{
    const queries:Record<string,string>={};
    for(const [name,value] of [['response-content-type',options.contentType],['response-content-disposition',options.contentDisposition],['response-content-encoding',options.contentEncoding]] as const){
      if(value!==undefined){if(!value||invalidHeader(value))throw new Error('STORAGE_RESPONSE_HEADER_INVALID');queries[name]=value;}
    }
    const versionId=ossVersion(options.version);if(versionId)queries.versionId=versionId;
    return this.signer.signatureUrlV4('GET',expiresSeconds,{queries},objectKey(this.config.keyPrefix,key));
  }
}
