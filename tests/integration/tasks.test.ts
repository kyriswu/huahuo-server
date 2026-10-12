import { beforeAll,afterAll,it,expect } from 'vitest';
import { randomUUID,randomBytes } from 'node:crypto';
import { loadConfig } from '../../src/config/config.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { migrate } from '../../src/db/migrate.js';
import { TaskService } from '../../src/modules/tasks/service.js';
import { TaskEngine } from '../../src/modules/tasks/engine.js';
import { TaskScheduler } from '../../src/modules/tasks/scheduler.js';
import { QueuePublisher,TaskWorkers } from '../../src/modules/tasks/queue.js';
import { hash } from '../../src/modules/tasks/model.js';
import { buildApiServer } from '../../src/apps/api-server.js';
import { buildAdminServer } from '../../src/apps/admin.js';
import { AdminService } from '../../src/modules/admin/service.js';
import type { Scope } from '../../src/modules/identity/store.js';
const migrationUrl=process.env.TEST_DATABASE_MIGRATION_URL!;
if(!migrationUrl||!/^huahuo_test_/.test(new URL(migrationUrl).pathname.slice(1)))throw new Error('TEST_DB_REQUIRED');
const env={...process.env,APP_ENV:'test',LOG_LEVEL:'silent',APP_TOKEN_SECRET:'test-'.repeat(12),ADMIN_SESSION_SECRET:'admin-'.repeat(12),APP_PUBLIC_BASE_URL:'http://localhost:3000',ADMIN_PUBLIC_BASE_URL:'http://localhost:3001',SMS_PROVIDER:'disabled',REDIS_KEY_PREFIX:'p03-'+randomUUID(),ENABLE_DEMO_TASKS:'true'};
const cfg=(role:'api-server'|'worker'|'scheduler'|'admin')=>loadConfig(role,{...env,DATABASE_URL:process.env[`TEST_DATABASE_${role==='api-server'?'API':role.toUpperCase()}_URL`]});
const root=poolFor(loadConfig('migrate',{DATABASE_URL:migrationUrl})),apiPool=poolFor(cfg('api-server')),workerPool=poolFor(cfg('worker')),schedulerPool=poolFor(cfg('scheduler'));
const service=new TaskService(apiPool),engine=new TaskEngine(workerPool,2000);
const publisher=new QueuePublisher(cfg('scheduler'));const scheduler=new TaskScheduler(schedulerPool,publisher,randomUUID(),1);
let a:Scope,b:Scope,wa:string,wb:string;
async function user(){const userId=randomUUID(),sessionId=randomUUID(),wid=randomUUID();
 await root.query('INSERT INTO app_users(id,phone_hash,phone_masked) VALUES($1,$2,$3)',[userId,randomUUID(),'138****0000']);
 await root.query("INSERT INTO user_sessions(id,user_id,device_id,access_hash,access_expires_at,expires_at) VALUES($1,$2,'fixture',$3,now()+interval '1 hour',now()+interval '1 day')",[sessionId,userId,randomUUID()]);
 await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'fixture',true,$3)",[wid,userId,randomUUID()]);return {scope:{userId,sessionId,traceId:randomUUID()},wid};
}
const create=async(text='private input')=>(await service.create(a,{workspaceId:wa,text},randomUUID())).task.taskId;
async function expire(id:string){await root.query("UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1",[id]);}
async function until(fn:()=>Promise<boolean>){for(let n=0;n<100;n++){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw new Error('TASK_TIMEOUT');}
beforeAll(async()=>{await migrate(loadConfig('migrate',{DATABASE_URL:migrationUrl}));const u=await user(),v=await user();a=u.scope;wa=u.wid;b=v.scope;wb=v.wid;},20000);
afterAll(async()=>{await publisher.close();await Promise.all([apiPool.end(),workerPool.end(),schedulerPool.end(),root.end()]);});
it('atomic acceptance, concurrent idempotency replay/conflict and scope boundaries',async()=>{
 const key=randomUUID(),input={workspaceId:wa,text:'hello'};
 const [x,y]=await Promise.all([service.create(a,input,key),service.create(a,input,key)]);expect(x.task.taskId).toBe(y.task.taskId);
 await expect(service.create(a,{...input,text:'different'},key)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 const other=await service.create(b,{workspaceId:wb,text:'hello'},key);expect(other.task.taskId).not.toBe(x.task.taskId);
 await expect(service.create(a,{workspaceId:wb,text:'hack'},key)).rejects.toMatchObject({statusCode:404});
 for(const read of [()=>service.detail(b,x.task.taskId),()=>service.events(b,x.task.taskId,0,100),()=>service.result(b,x.task.taskId),()=>service.mutate(b,x.task.taskId,'cancel',randomUUID(),{})])await expect(read()).rejects.toMatchObject({statusCode:404});
 const row=await root.query('SELECT count(*)::int n FROM task_outbox WHERE task_id=$1',[x.task.taskId]);expect(row.rows[0].n).toBe(1);
});
it('duplicate delivery and concurrent workers create exactly one PG result; event replay ordered',async()=>{
 const id=await create('hello');const attempts=await Promise.all([engine.claim(id,randomUUID()),engine.claim(id,randomUUID())]);expect(attempts.filter(Boolean)).toHaveLength(1);
 const attempt=attempts.find(Boolean)!;expect(await engine.execute(attempt)).toBe(true);expect(await engine.execute(attempt)).toBe(false);expect(await engine.claim(id,randomUUID())).toBeNull();
 expect(await service.result(a,id)).toMatchObject({digest:hash('hello'),byteCount:5});
 const page=await service.events(a,id,0,2);expect(page.items.map(e=>e.sequence)).toEqual([1,2]);expect(page.hasMore).toBe(true);
 const rest=await service.events(a,id,page.nextSequence,100);expect(rest.items.map(e=>e.sequence)).toEqual([3]);
});
it('expired worker lease is recovered; stale attempt cannot overwrite new result',async()=>{
 const id=await create(),old=(await engine.claim(id,randomUUID()))!;await expire(id);await scheduler.recover();const next=(await engine.claim(id,randomUUID()))!;
 expect(next.attempt).toBe(2);expect(await engine.finish(old,hash('stale'),5)).toBe(false);expect(await engine.execute(next)).toBe(true);
 expect((await service.detail(a,id)).task.attempt).toBe(2);
});
it('cancellation fences an active attempt and ends locally after lease; queued cancellation prevents execution',async()=>{
 const id=await create(),attempt=(await engine.claim(id,randomUUID()))!;
 expect((await service.mutate(a,id,'cancel',randomUUID(),{})).task.state).toBe('cancel_requested');expect(await engine.execute(attempt)).toBe(false);
 await expire(id);await scheduler.recover();expect((await service.detail(a,id)).task.state).toBe('cancelled');
 const queued=await create();await service.mutate(a,queued,'cancel',randomUUID(),{});expect(await engine.claim(queued,randomUUID())).toBeNull();
});
it('bounded automatic retries, permanent failures and authorized manual dead-letter retry',async()=>{
 const id=await create();await root.query('UPDATE tasks SET max_attempts=1 WHERE id=$1',[id]);const attempt=(await engine.claim(id,randomUUID()))!;
 await engine.fail(attempt,'TEMPORARY_FAILURE',true);expect((await service.detail(a,id)).task.state).toBe('failed');
 await service.mutate(a,id,'retry',randomUUID(),{stage:'runtime'});expect((await service.detail(a,id)).task.state).toBe('queued');
 const permanent=await create();await engine.fail((await engine.claim(permanent,randomUUID()))!,'INPUT_UNAVAILABLE',false);
 await expect(service.mutate(a,permanent,'retry',randomUUID(),{})).rejects.toMatchObject({code:'TASK_RETRY_NOT_ALLOWED'});
 const retry=await create();await engine.fail((await engine.claim(retry,randomUUID()))!,'TEMPORARY_FAILURE',true);expect((await service.detail(a,retry)).task.state).toBe('retry_scheduled');expect(await engine.claim(retry,randomUUID())).toBeNull();
});
it('external unknown/submitted tasks reconcile without resubmission; cancel cannot claim remote success',async()=>{
 const id=await create(),attempt=(await engine.claim(id,randomUUID()))!;expect(await engine.markExternal(attempt,null)).toBe(true);await expire(id);await scheduler.recover();
 expect((await service.detail(a,id)).task.state).toBe('reconciling');expect(await engine.claim(id,randomUUID())).toBeNull();
 await expect(service.mutate(a,id,'retry',randomUUID(),{})).rejects.toMatchObject({code:'TASK_RETRY_NOT_ALLOWED'});
 const waiting=await create(),external=(await engine.claim(waiting,randomUUID()))!;await engine.markExternal(external,null);await engine.waitingExternal(external,'fake-test-reference');
 expect((await service.detail(a,waiting)).task.state).toBe('waiting_external');await service.mutate(a,waiting,'cancel',randomUUID(),{});await scheduler.recover();expect((await service.detail(a,waiting)).task.state).toBe('reconciling');
});
it('two scheduler instances create one persistent window; delivery outage retains intent',async()=>{
 const s2=new TaskScheduler(schedulerPool,publisher);await Promise.all([scheduler.schedules(),s2.schedules()]);
 expect((await root.query('SELECT count(*)::int n FROM task_schedule_windows')).rows[0].n).toBe(1);
 const failed=new TaskScheduler(schedulerPool,{publish:async()=>{throw new Error('queue offline');}});await failed.dispatch();
 expect((await root.query("SELECT count(*)::int n FROM task_outbox WHERE last_error='QUEUE_UNAVAILABLE' AND status='pending'")).rows[0].n).toBeGreaterThan(0);
});
it('enqueue before ack crash and lost Redis job recover from PG; only ID enters BullMQ',async()=>{
 const id=await create('private-not-in-redis');
 // Isolate this test delivery from earlier fixtures without deleting their durable records.
 await root.query("UPDATE task_outbox SET available_at=now()+interval '1 hour' WHERE task_id<>$1 AND status='pending'",[id]);
 const d=(await scheduler.claim())!;expect(d.task_id).toBe(id);await publisher.publish(d);
 const queue=publisher.queues.get('content')!;const job=await queue.getJob(d.id);expect(job!.data).toEqual({taskId:id});
 await root.query("UPDATE task_outbox SET lease_until=now()-interval '1 second' WHERE id=$1",[d.id]);
 const again=(await scheduler.claim())!;expect(again.id).toBe(d.id);await publisher.publish(again);await scheduler.acknowledge(again);
 await job!.remove();await root.query("UPDATE task_outbox SET sent_at=now()-interval '1 minute' WHERE id=$1",[d.id]);await scheduler.recover();await scheduler.dispatch();
 const workers=new TaskWorkers(workerPool,cfg('worker'));
 try{await until(async()=>(await service.detail(a,id)).task.state==='succeeded');expect((await root.query('SELECT count(*)::int n FROM task_results WHERE task_id=$1',[id])).rows[0].n).toBe(1);}finally{await workers.close();}
},15000);
it('real API contract: task wrapper, auth, schema, result readiness and Admin CSRF/RBAC',async()=>{
 const api=await buildApiServer({config:cfg('api-server')}),admin=await buildAdminServer({config:cfg('admin')});
 const token='app_'+randomBytes(32).toString('base64url');await root.query('UPDATE user_sessions SET access_hash=$2 WHERE id=$1',[a.sessionId,hash(token)]);
 const headers={authorization:'Bearer '+token,'x-idempotency-key':randomUUID()};
 try{
  const createResponse=await api.inject({method:'POST',url:'/api/v1/tasks/demo',headers,payload:{workspaceId:wa,text:'contract'}});expect(createResponse.statusCode).toBe(200);const id=createResponse.json().data.task.taskId;
  const read=await api.inject({url:`/api/v1/tasks/${id}`,headers:{authorization:headers.authorization}});expect(read.json().data).toMatchObject({task:{taskType:'demo.digest',status:'queued'},retryActions:[{action:'runtime',allowed:false}]});
  expect((await api.inject(`/api/v1/tasks/${id}`)).statusCode).toBe(401);
  expect((await api.inject({url:`/api/v1/tasks/${id}/result`,headers:{authorization:headers.authorization}})).statusCode).toBe(409);
  expect((await api.inject({url:`/admin/api/v1/tasks/${id}`,headers})).statusCode).toBe(404);
  expect((await admin.inject({url:`/admin/api/v1/tasks/${id}`,headers})).statusCode).toBe(401);
  const adminPool=poolFor(cfg('admin')),adminService=new AdminService(adminPool,env.ADMIN_SESSION_SECRET);
  try{const {hashPassword}=await import('../../src/modules/identity/crypto.js');const adminId=randomUUID();await root.query("INSERT INTO admin_users(id,username,password_hash,role) VALUES($1,'taskoperator',$2,'operator')",[adminId,await hashPassword('a-long-test-password')]);
   const login=await adminService.login('taskoperator','a-long-test-password','127.9.9.9','trace-task');
   const cookie='hh_admin_session='+login.cookie;expect((await admin.inject({url:`/admin/api/v1/tasks/${id}`,headers:{cookie}})).statusCode).toBe(200);
   const url=`/admin/api/v1/tasks/${id}/retry`;
   expect((await admin.inject({method:'POST',url,headers:{cookie},payload:{reason:'test'}})).statusCode).toBe(403);
   expect((await admin.inject({method:'POST',url,headers:{cookie,origin:'http://localhost:3001','x-csrf-token':login.csrfToken,'x-idempotency-key':randomUUID()},payload:{reason:'test'}})).statusCode).toBe(403);
  }finally{await root.query("DELETE FROM admin_sessions WHERE admin_id IN (SELECT id FROM admin_users WHERE username='taskoperator')");await root.query("DELETE FROM admin_users WHERE username='taskoperator'");await adminPool.end();}
 }finally{await api.close();await admin.close();}
});
