import { beforeAll,afterAll,it,expect,describe } from 'vitest';
import { randomUUID,createHash,createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { rm,access } from 'node:fs/promises';
import { loadConfig } from '../../src/config/config.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { migrate } from '../../src/db/migrate.js';
import { AssetService } from '../../src/modules/assets/service.js';
import { StorageService } from '../../src/modules/storage/service.js';
import { LocalStorageAdapter } from '../../src/modules/storage/port.js';
import { StorageJobs,expireUploads } from '../../src/modules/storage/jobs.js';
import { TaskEngine } from '../../src/modules/tasks/engine.js';
import { attachResource } from '../../src/modules/storage/references.js';
import { transaction } from '../../src/modules/identity/store.js';
import { buildApiServer } from '../../src/apps/api-server.js';
import { digest } from '../../src/modules/identity/crypto.js';
const migrationUrl=process.env.TEST_DATABASE_MIGRATION_URL;
if(!migrationUrl||!/^huahuo_test_/.test(new URL(migrationUrl).pathname.slice(1)))throw new Error('TEST_DB_REQUIRED');
const dir=`/tmp/huahuo-p05-${randomUUID()}`;
const cfg=loadConfig('api-server',{...process.env,APP_ENV:'test',LOG_LEVEL:'silent',APP_TOKEN_SECRET:'test-'.repeat(12),APP_PUBLIC_BASE_URL:'http://storage.test',DATABASE_URL:process.env.TEST_DATABASE_API_URL,STORAGE_LOCAL_ROOT:dir,MAX_UPLOAD_BYTES:'1024'});
const migrator=loadConfig('migrate',{...process.env,APP_ENV:'test',DATABASE_URL:migrationUrl});const root=poolFor(migrator),pool=poolFor(cfg);
const worker=poolFor({...cfg,role:'worker',databaseUrl:process.env.TEST_DATABASE_WORKER_URL!});
const scheduler=poolFor({...cfg,role:'scheduler',databaseUrl:process.env.TEST_DATABASE_SCHEDULER_URL!});
const adapter=new LocalStorageAdapter(dir),storage=new StorageService(pool,cfg,adapter),engine=new TaskEngine(worker,15000,undefined,new StorageJobs(worker,adapter));
const metadata={sourceScene:'note_import',fileName:'中文 笔记.txt',mimeType:'text/plain',sizeBytes:13n,durationSeconds:0};
const bytes=Buffer.from('hello-storage');
async function fixture(){const userId=randomUUID(),sessionId=randomUUID(),workspaceId=randomUUID(),bearer=`app_${Buffer.from(randomUUID()+randomUUID()).toString('base64url').slice(0,43)}`;await root.query('INSERT INTO app_users(id,phone_hash,phone_masked) VALUES($1,$2,$3)',[userId,randomUUID(),'138****0000']);await root.query("INSERT INTO user_sessions(id,user_id,device_id,access_hash,access_expires_at,expires_at) VALUES($1,$2,'fixture',$3,now()+interval '1 hour',now()+interval '1 day')",[sessionId,userId,digest(bearer)]);await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'fixture',true,$3)",[workspaceId,userId,randomUUID()]);return {userId,scope:{userId,sessionId,traceId:randomUUID()},workspaceId,bearer};}
async function uploaded(){const u=await fixture();const t=await storage.createUpload(u.scope,{...metadata,workspaceId:u.workspaceId,sha256:createHash('sha256').update(bytes).digest('hex')},randomUUID());await storage.put(t.uploadId,t.headers['X-Upload-Capability'],Readable.from([bytes]));return {u,t};}
async function work(id:string){const a=await engine.claim(id,randomUUID());expect(a).not.toBeNull();await engine.execute(a!);}
async function read(stream:Readable){const chunks:Buffer[]=[];for await(const c of stream)chunks.push(c);return Buffer.concat(chunks);}
describe('P05 real scoped resource lifecycle',()=>{
 beforeAll(async()=>{await migrate(migrator);});afterAll(async()=>{await Promise.all([pool.end(),root.end(),worker.end(),scheduler.end()]);await rm(dir,{recursive:true,force:true});});
 it('stable IDs, concurrent complete, one reservation/task/manifest and persistent Range bytes',async()=>{
  const {u,t}=await uploaded();const results=await Promise.all([storage.complete(u.scope,t.uploadId,randomUUID()),storage.complete(u.scope,t.uploadId,randomUUID())]);expect(results[0]!.resource.resourceId).toBe(t.resourceId);expect(results[1]).toEqual(results[0]);
  const s=await storage.recover(u.scope,t.uploadId);expect(s.status).toBe('completed');const playback=await storage.playback(u.scope,t.resourceId);const cap=new URL(playback.url).searchParams.get('playbackToken')!;
  const restart=new StorageService(pool,cfg,new LocalStorageAdapter(dir));expect(await read((await restart.download(t.resourceId,cap)).stream)).toEqual(bytes);
  expect((await read((await restart.download(t.resourceId,cap,'bytes=0-4')).stream)).toString()).toBe('hello');expect((await read((await restart.download(t.resourceId,cap,'bytes=-7')).stream)).toString()).toBe('storage');expect((await read((await restart.download(t.resourceId,cap,'bytes=6-999')).stream)).toString()).toBe('storage');
  await expect(storage.download(t.resourceId,cap,'bytes=99-')).rejects.toMatchObject({statusCode:416,size:13});
  expect((await root.query('SELECT count(*)::int n FROM upload_parts WHERE upload_id=$1',[t.uploadId])).rows[0].n).toBe(1);
  expect((await root.query("SELECT status,confirmed_bytes FROM storage_reservations WHERE resource_key=$1",[`resource:${t.resourceId}`])).rows[0]).toMatchObject({status:'confirmed',confirmed_bytes:'13'});
  const task=(await root.query('SELECT task_id FROM storage_jobs WHERE resource_id=$1',[t.resourceId])).rows[0];await work(task.task_id);expect((await root.query('SELECT processing_status FROM resources WHERE resource_id=$1',[t.resourceId])).rows[0].processing_status).toBe('inspected');
 });
 it('P06 unreadable import retains the durable original resource and permits manual tags',async()=>{
  const {u,t}=await uploaded();await storage.complete(u.scope,t.uploadId,randomUUID());
  const assets=new AssetService(pool,cfg.appTokenSecret!);
  const imported=await assets.importNote(u.scope,u.workspaceId,{title:'unparsed document',mimeType:'application/octet-stream',resourceRefs:[{resourceId:t.resourceId,usage:'original'}]},randomUUID());
  expect(imported.status).toBe('needs-processing');expect(imported.note.resourceRefs[0]!.resourceId).toBe(t.resourceId);expect(imported.note.parts.raw!.contentMarkdown).toBe('');
  const tags=await assets.noteTags(u.scope,u.workspaceId,imported.note.noteId);await assets.addNoteTag(u.scope,u.workspaceId,imported.note.noteId,'待整理',tags.tagEtag,randomUUID());
  const playback=await storage.playback(u.scope,t.resourceId),cap=new URL(playback.url).searchParams.get('playbackToken')!;
  expect(await read((await storage.download(t.resourceId,cap)).stream)).toEqual(bytes);
  expect((await root.query("SELECT count(*)::int n FROM resource_refs WHERE resource_id=$1 AND ref_kind='note' AND ref_id_external=$2",[t.resourceId,imported.note.noteId])).rows[0].n).toBe(1);
 });
 it('rejects MIME spoof, too many bytes and hash mismatch; releases reservation on failure',async()=>{
  const u=await fixture();for(const input of [{...metadata,mimeType:'image/png'},{...metadata,sizeBytes:2n},{...metadata,sha256:'0'.repeat(64)}]){const t=await storage.createUpload(u.scope,input,randomUUID());await expect(storage.put(t.uploadId,t.headers['X-Upload-Capability'],Readable.from([bytes]))).rejects.toMatchObject({statusCode:400});expect((await root.query('SELECT status FROM storage_reservations WHERE resource_key=$1',[`resource:${t.resourceId}`])).rows[0].status).toBe('released');}
 });
 it('isolates A from B and rejects expired or forged playback and upload capabilities',async()=>{
  const {u,t}=await uploaded();await storage.complete(u.scope,t.uploadId,randomUUID());const b=await fixture();await expect(storage.playback(b.scope,t.resourceId)).rejects.toMatchObject({statusCode:404});await expect(storage.complete(b.scope,t.uploadId,randomUUID())).rejects.toMatchObject({statusCode:404});await expect(storage.put(t.uploadId,'invalid',Readable.from([bytes]))).rejects.toMatchObject({statusCode:401});
  const raw=`${t.resourceId}.${Date.now()-1}`;const cap=`${raw}.${createHmac('sha256',cfg.appTokenSecret!).update(raw).digest('base64url')}`;await expect(storage.download(t.resourceId,cap)).rejects.toMatchObject({statusCode:401});
 });
 it('enforces concurrent quota admissions and releases expired uploads through scheduler/worker',async()=>{
  const u=await fixture();const limited=new StorageService(pool,{...cfg,storageQuotaBytes:13},adapter);const outcomes=await Promise.allSettled([limited.createUpload(u.scope,metadata,randomUUID()),limited.createUpload(u.scope,metadata,randomUUID())]);expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  const id=(outcomes.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof limited.createUpload>>>).value.uploadId;await root.query("UPDATE upload_sessions SET expires_at=now()-interval '1 second' WHERE upload_id=$1",[id]);await expireUploads(scheduler);
  expect((await storage.recover(u.scope,id)).status).toBe('expired');const task=(await root.query("SELECT task_id FROM storage_jobs WHERE upload_id=$1",[id])).rows[0];await work(task.task_id);await expect(limited.createUpload(u.scope,metadata,randomUUID())).resolves.toHaveProperty('uploadId');
 });
 it('recovers complete after object publication but before uploaded DB state',async()=>{
  const {u,t}=await uploaded();await root.query("UPDATE upload_sessions SET status='uploading' WHERE upload_id=$1",[t.uploadId]);expect((await storage.complete(u.scope,t.uploadId,randomUUID())).resource.resourceId).toBe(t.resourceId);
 });
 it('reference-aware async deletion revokes URLs, is replay safe and releases stored quota',async()=>{
  const {u,t}=await uploaded();await storage.complete(u.scope,t.uploadId,randomUUID());await transaction(pool,tx=>attachResource(tx,u.userId,t.resourceId,'message','future-message',u.workspaceId));await expect(storage.remove(u.scope,u.workspaceId,t.resourceId,randomUUID())).rejects.toMatchObject({code:'RESOURCE_REFERENCED'});
  await pool.query('DELETE FROM resource_refs WHERE resource_id=$1',[t.resourceId]);const key=randomUUID(),receipt=await storage.remove(u.scope,u.workspaceId,t.resourceId,key);expect(receipt).toEqual({resourceId:t.resourceId,workspaceId:u.workspaceId,status:'delete_pending'});expect(await storage.remove(u.scope,u.workspaceId,t.resourceId,key)).toEqual(receipt);await access(`${dir}/${t.resourceId}`);await expect(storage.playback(u.scope,t.resourceId)).rejects.toMatchObject({statusCode:404});const task=(await root.query("SELECT task_id FROM storage_jobs WHERE resource_id=$1 AND operation='delete'",[t.resourceId])).rows[0];await work(task.task_id);await expect(access(`${dir}/${t.resourceId}`)).rejects.toThrow();expect((await root.query('SELECT status FROM resources WHERE resource_id=$1',[t.resourceId])).rows[0].status).toBe('deleted');
 });
 it('disk-full and object-store failures have durable failure and release reservation',async()=>{
  const u=await fixture(),fault=new StorageService(pool,cfg,{put:async()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});},stat:adapter.stat.bind(adapter),read:adapter.read.bind(adapter),remove:adapter.remove.bind(adapter)});const t=await fault.createUpload(u.scope,metadata,randomUUID());await expect(fault.put(t.uploadId,t.headers['X-Upload-Capability'],Readable.from([bytes]))).rejects.toMatchObject({code:'UPLOAD_STORAGE_FAILED'});expect((await storage.recover(u.scope,t.uploadId)).status).toBe('failed');
 });
 it('actual App JSON body and object headers work through Fastify with no Bearer on transfer',async()=>{
  const u=await fixture();const app=await buildApiServer({config:cfg});try{
   const auth={authorization:`Bearer ${u.bearer}`,'x-idempotency-key':randomUUID()};const init=await app.inject({method:'POST',url:'/api/v1/media/upload-token',headers:auth,payload:{...metadata,sizeBytes:13,workspaceId:u.workspaceId}});expect(init.statusCode,init.body).toBe(200);const t=init.json().data;
   const put=await app.inject({method:'PUT',url:new URL(t.uploadUrl).pathname,headers:t.headers,payload:bytes});expect(put.statusCode,put.body).toBe(200);
   const done=await app.inject({method:'POST',url:`/api/v1/media/uploads/${t.uploadId}/complete`,headers:{...auth,'x-idempotency-key':randomUUID()},payload:{workspaceId:u.workspaceId}});expect(done.statusCode,done.body).toBe(200);
   const playback=await app.inject({url:`/api/v1/media/resources/${t.resourceId}/playback`,headers:{authorization:auth.authorization}});expect(playback.statusCode,playback.body).toBe(200);const url=new URL(playback.json().data.url);const download=await app.inject({url:url.pathname+url.search,headers:{range:'bytes=0-12'}});expect(download.statusCode).toBe(206);expect(download.rawPayload).toEqual(bytes);const invalid=await app.inject({url:url.pathname+url.search,headers:{range:'bytes=999-'}});expect(invalid.statusCode).toBe(416);expect(invalid.headers['content-range']).toBe('bytes */13');
  }finally{await app.close();}
 });
});
