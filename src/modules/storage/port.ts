import { constants, promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileTypeFromFile } from 'file-type';
import { parseFile } from 'music-metadata';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { AppConfig } from '../../config/config.js';
export interface StoredObject { bytes:number; sha256:string; contentType:string; durationSeconds:number; version:string; }
export interface StoragePort {
 put(key:string,input:Readable,contentType:string,maxBytes:number):Promise<StoredObject>;
 stat(key:string,contentType:string):Promise<StoredObject>;
 read(key:string,range?:{start:number;end:number},version?:string):Promise<Readable>;
 remove(key:string,version?:string):Promise<void>;
}
function safe(key:string){if(!/^[a-f0-9-]{36}$/.test(key))throw new Error('STORAGE_KEY_INVALID');return key;}
async function inspect(path:string,mime:string):Promise<StoredObject>{
 const handle=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const st=await handle.stat();if(!st.isFile())throw new Error('STORAGE_NOT_FILE');const hash=createHash('sha256');let bytes=0;
 const buffer=Buffer.allocUnsafe(1024*1024);let position=0;while(true){const read=await handle.read(buffer,0,buffer.length,position);if(!read.bytesRead)break;hash.update(buffer.subarray(0,read.bytesRead));bytes+=read.bytesRead;position+=read.bytesRead;}
 const detected=await fileTypeFromFile(path);const aliases:Record<string,string>={'audio/x-wav':'audio/wav','audio/wave':'audio/wav','audio/mp3':'audio/mpeg','audio/x-m4a':'audio/mp4','video/mp4':'audio/mp4','audio/aac':'audio/aac'};
 let actual=detected?.mime??'';actual=aliases[actual]??actual;const expected=aliases[mime]??mime;
 if(expected==='text/plain'&&!detected){const text=await fs.readFile(path);if(text.length>1024*1024||text.includes(0))throw new Error('UPLOAD_MIME_MISMATCH');new TextDecoder('utf-8',{fatal:true}).decode(text);actual='text/plain';}
 if(expected==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'&&actual==='application/zip'){const probe=(await fs.readFile(path)).subarray(0,2*1024*1024).toString('latin1');if(probe.includes('[Content_Types].xml')&&probe.includes('word/'))actual=expected;}
 if(actual!==expected)throw new Error('UPLOAD_MIME_MISMATCH');
 let durationSeconds=0;
 if(expected.startsWith('audio/')){const metadata=await parseFile(path,{duration:true});durationSeconds=metadata.format.duration??0;if(!Number.isFinite(durationSeconds)||durationSeconds<=0||durationSeconds>4*3600)throw new Error('UPLOAD_DURATION_INVALID');}
 return {bytes,sha256:hash.digest('hex'),contentType:expected,durationSeconds,version:'immutable'};
 }finally{await handle.close();}
}
/** Flat, generated keys only; root is application-owned and never exposed as an input. */
export class LocalStorageAdapter implements StoragePort {
 readonly root:string;
 constructor(root:string){this.root=resolve(root);}
 private async path(key:string){safe(key);await fs.mkdir(this.root,{recursive:true,mode:0o700});if((await fs.lstat(this.root)).isSymbolicLink()||await fs.realpath(this.root)!==this.root)throw new Error('STORAGE_ROOT_SYMLINK');return `${this.root}/${key}`;}
 async put(key:string,input:Readable,contentType:string,maxBytes:number){
 const target=await this.path(key),temp=`${target}.${randomUUID()}.part`;let bytes=0;const file=await fs.open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 try{await pipeline(input,new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;done(bytes>maxBytes?new Error('UPLOAD_TOO_LARGE'):null,chunk);}}),file.createWriteStream({autoClose:true}),{signal:AbortSignal.timeout(120000)});
 await file.close().catch(()=>undefined);const sync=await fs.open(temp,constants.O_RDONLY);await sync.sync().catch(()=>undefined);await sync.close();const meta=await inspect(temp,contentType);
 // No overwrite is allowed. Hard-link publishes the completed inode atomically, then removes the temporary name.
 await fs.link(temp,target);await fs.unlink(temp);return {...meta,version:key};
 }catch(e){await file.close().catch(()=>undefined);await fs.unlink(temp).catch(()=>undefined);throw e;}
 }
 async stat(key:string,mime:string){return {...await inspect(await this.path(key),mime),version:key};}
 async read(key:string,range?:{start:number;end:number}){const file=await fs.open(await this.path(key),constants.O_RDONLY|constants.O_NOFOLLOW);if(!(await file.stat()).isFile()){await file.close();throw new Error('STORAGE_NOT_FILE');}return file.createReadStream(range?{start:range.start,end:range.end}:{});}
 async cleanup(key:string){await this.path(key);for(const name of await fs.readdir(this.root)){if(name.startsWith(`${key}.`)&&name.endsWith('.part'))await fs.unlink(`${this.root}/${name}`).catch(()=>undefined);}}
 async remove(key:string){await fs.unlink(await this.path(key)).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
/** S3 path-style API, SigV4 via pinned AWS SDK. Uses bounded disk staging, never whole-object RAM buffering. */
export class S3StorageAdapter implements StoragePort {
 readonly client:S3Client;
 constructor(readonly config:NonNullable<AppConfig['storageS3']>){this.client=new S3Client({endpoint:config.endpoint,region:config.region,forcePathStyle:true,credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey},maxAttempts:2});}
 private key(key:string){return `huahuo/${safe(key)}`;}
 async put(key:string,input:Readable,mime:string,maxBytes:number){const directory=await fs.mkdtemp(`${tmpdir()}/huahuo-s3-`);const local=new LocalStorageAdapter(directory);
 try{const meta=await local.put(key,input,mime,maxBytes);const result=await this.client.send(new PutObjectCommand({Bucket:this.config.bucket,Key:this.key(key),Body:await local.read(key),ContentLength:meta.bytes,ContentType:meta.contentType,IfNoneMatch:'*',Metadata:{sha256:meta.sha256}}),{abortSignal:AbortSignal.timeout(120000)});return {...meta,version:result.VersionId??result.ETag??key};}finally{await fs.rm(directory,{recursive:true,force:true});}}
 async stat(key:string,mime:string){const directory=await fs.mkdtemp(`${tmpdir()}/huahuo-s3-`);try{const object=await this.client.send(new GetObjectCommand({Bucket:this.config.bucket,Key:this.key(key)}),{abortSignal:AbortSignal.timeout(120000)});const local=new LocalStorageAdapter(directory);const meta=await local.put(key,object.Body as Readable,mime,this.config.maxBytes);return {...meta,version:object.VersionId??object.ETag??key};}finally{await fs.rm(directory,{recursive:true,force:true});}}
 async read(key:string,range?:{start:number;end:number},version?:string){const result=await this.client.send(new GetObjectCommand({Bucket:this.config.bucket,Key:this.key(key),...(version&&!version.startsWith('"')&&version!==key?{VersionId:version}:{}),...(range?{Range:`bytes=${range.start}-${range.end}`}:{})}),{abortSignal:AbortSignal.timeout(120000)});return result.Body as Readable;}
 async remove(key:string,version?:string){await this.client.send(new DeleteObjectCommand({Bucket:this.config.bucket,Key:this.key(key),...(version&&!version.startsWith('"')&&version!==key?{VersionId:version}:{})}),{abortSignal:AbortSignal.timeout(3000)});}
}
export function storageFor(config:AppConfig):StoragePort {return config.storageDriver==='local'?new LocalStorageAdapter(config.storageLocalRoot):new S3StorageAdapter(config.storageS3!);}
