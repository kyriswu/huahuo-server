import { beforeAll,afterAll,it,expect,vi } from 'vitest';
import type {FastifyBaseLogger} from 'fastify';
import {withTraceId,currentTraceId} from '../../src/lib/trace.js';
import {enqueueIntent} from '../../src/modules/tasks/model.js';
import {transaction} from '../../src/modules/identity/store.js';
import { randomUUID } from 'node:crypto';
import { loadTestConfig as loadConfig } from '../sms-fixture.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { migrate } from '../../src/db/migrate.js';
import { TaskService } from '../../src/modules/tasks/service.js';
import { TaskEngine } from '../../src/modules/tasks/engine.js';
import { TaskScheduler } from '../../src/modules/tasks/scheduler.js';
import { QueuePublisher } from '../../src/modules/tasks/publisher.js';
import { createTaskWorkers } from '../../src/apps/worker.js';
import { hash } from '../../src/modules/tasks/model.js';
import { buildApiServer } from '../../src/apps/api-server.js';
import { buildAdminServer } from '../../src/apps/admin.js';
import { AdminService } from '../../src/modules/admin/service.js';
import type { Scope } from '../../src/modules/identity/store.js';
import { fixtureAccessToken, insertFixtureUser, insertFixtureSession, testJwtEnv } from './jwt-fixture.js';
import { fixtureScopeHeaders } from './jwt-fixture.js';
const migrationUrl=process.env.TEST_DATABASE_MIGRATION_URL!;
if(!migrationUrl||!/^huahuo_test_/.test(new URL(migrationUrl).pathname.slice(1)))throw new Error('TEST_DB_REQUIRED');
const env={...process.env,...testJwtEnv,APP_ENV:'test',LOG_LEVEL:'silent',APP_TOKEN_SECRET:'test-'.repeat(12),ADMIN_SESSION_SECRET:'admin-'.repeat(12),APP_PUBLIC_BASE_URL:'http://localhost:3000',ADMIN_PUBLIC_BASE_URL:'http://localhost:3001',REDIS_KEY_PREFIX:'p03-'+randomUUID(),ENABLE_DEMO_TASKS:'true'};
const cfg=(role:'api-server'|'worker'|'scheduler'|'admin')=>loadConfig(role,{...env,DATABASE_URL:process.env[`TEST_DATABASE_${role==='api-server'?'API':role.toUpperCase()}_URL`]});
const root=poolFor(loadConfig('migrate',{DATABASE_URL:migrationUrl})),apiPool=poolFor(cfg('api-server')),workerPool=poolFor(cfg('worker')),schedulerPool=poolFor(cfg('scheduler'));
const service=new TaskService(apiPool,cfg('api-server').appTokenSecret!),engine=new TaskEngine(workerPool,2000);
const publisher=new QueuePublisher(cfg('scheduler'));const scheduler=new TaskScheduler(schedulerPool,publisher,randomUUID(),1);
let a:Scope,b:Scope,wa:string,wb:string;
async function user(){const userId=randomUUID(),sessionId=randomUUID(),wid=randomUUID();
 await insertFixtureUser(root,userId);
 await insertFixtureSession(root,userId,sessionId);
 await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'fixture',true,$3)",[wid,userId,randomUUID()]);return {scope:{userId,sessionId,traceId:randomUUID()},wid};
}
const create=async(text='private input')=>(await service.create({...a,traceId:currentTraceId()??a.traceId},{workspaceId:wa,text},randomUUID())).task.taskId;
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
 const stored=(await root.query('SELECT response_cipher,expires_at>now() valid FROM api_idempotency WHERE scope=$1 AND operation=$2 AND key=$3',[`${a.userId}:${wa}`,'demo.create',key])).rows[0];
 expect(stored.valid).toBe(true);expect(stored.response_cipher).not.toContain(x.task.taskId);
});
it('expired task keys cannot repeat mutations, and revoked sessions cannot replay cached responses',async()=>{
 const u=await user(),key=randomUUID(),input={workspaceId:u.wid,text:'private task'};
 const first=await service.create(u.scope,input,key);
 await root.query("UPDATE api_idempotency SET expires_at=now()-interval '1 second' WHERE scope=$1 AND operation='demo.create' AND key=$2",[`${u.scope.userId}:${u.wid}`,key]);
 await expect(service.create(u.scope,input,key)).rejects.toMatchObject({statusCode:409,code:'IDEMPOTENCY_KEY_EXPIRED'});
 expect((await root.query('SELECT count(*)::int n FROM tasks WHERE user_id=$1',[u.scope.userId])).rows[0].n).toBe(1);
 const cancelKey=randomUUID();await service.mutate(u.scope,first.task.taskId,'cancel',cancelKey,{});
 await root.query('UPDATE user_sessions SET revoked_at=now() WHERE id=$1',[u.scope.sessionId]);
 await expect(service.mutate(u.scope,first.task.taskId,'cancel',cancelKey,{})).rejects.toMatchObject({statusCode:401,code:'AUTH_SESSION_EXPIRED'});
});
it('Admin retries use the shared encrypted store with separate caller scope and least-privilege credentials',async()=>{
 const id=await create();await root.query("UPDATE tasks SET state='failed',retryable=true WHERE id=$1",[id]);
 const adminPool=poolFor(cfg('admin')),adminTasks=new TaskService(adminPool,env.ADMIN_SESSION_SECRET),key=randomUUID(),adminId=randomUUID();
 await root.query("INSERT INTO admin_users(id,username,password_hash,role) VALUES($1,$2,'fixture','superadmin')",[adminId,`retry-${adminId}`]);
 const adminScope={adminId,sessionId:randomUUID(),role:'superadmin' as const,username:`retry-${adminId}`};
 try{
  const initial=await adminTasks.adminRetry(adminScope,id,key,'operator retry','trace');
  const replay=await adminTasks.adminRetry(adminScope,id,key,'operator retry','trace');
  expect(replay).toEqual(initial);expect(initial.task.state).toBe('queued');
  const rows=(await root.query('SELECT scope,response_cipher FROM api_idempotency WHERE operation=$1 AND key=$2',[`admin.retry:${id}`,key])).rows;
  expect(rows).toHaveLength(1);expect(rows[0].scope).toBe(adminId);expect(rows[0].response_cipher).not.toContain(id);
  expect((await root.query("SELECT count(*)::int n FROM admin_audit_events WHERE admin_id=$1 AND action='task.retry' AND target_id=$2",[adminId,id])).rows[0].n).toBe(1);
  await expect(adminTasks.adminRetry({...adminScope,role:'operator'},id,key,'operator retry','trace')).rejects.toMatchObject({statusCode:403});
 }finally{await root.query('DELETE FROM admin_audit_events WHERE admin_id=$1',[adminId]);await root.query('DELETE FROM admin_users WHERE id=$1',[adminId]);await adminPool.end();}
});
it('excludes a task whose workspace belongs to a different user without relying on a composite FK',async()=>{
 const id=randomUUID();
 await root.query("INSERT INTO tasks(trace_id,id,user_id,workspace_id,kind,queue,state) VALUES(gen_random_uuid()::text,$1,$2,$3,'demo.digest','content','queued')",[id,a.userId,wb]);
 try{
  expect((await service.running(a)).items.some(task=>task.taskId===id)).toBe(false);
  await expect(service.detail(a,id)).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
 }finally{await root.query('DELETE FROM tasks WHERE id=$1',[id]);}
});
it('duplicate delivery and concurrent workers create exactly one PG result; event replay ordered',async()=>{
 const id=await create('hello');const attempts=await Promise.all([engine.claim(id,randomUUID()),engine.claim(id,randomUUID())]);expect(attempts.filter(Boolean)).toHaveLength(1);
 const attempt=attempts.find(Boolean)!;expect(await engine.execute(attempt)).toBe(true);expect(await engine.execute(attempt)).toBe(false);expect(await engine.claim(id,randomUUID())).toBeNull();
 expect(await service.result(a,id)).toMatchObject({digest:hash('hello'),byteCount:5});
 const page=await service.events(a,id,0,2);expect(page.items.map(e=>e.sequence)).toEqual([1,2]);expect(page.hasMore).toBe(true);
 const rest=await service.events(a,id,page.nextSequence,100);expect(rest.items.map(e=>e.sequence)).toEqual([3]);
});
it('expired worker lease is recovered; stale attempt cannot overwrite new result',async()=>{
 const id=await create(),old=(await engine.claim(id,randomUUID()))!;expect(old).not.toBeNull();await expire(id);await scheduler.recover();
 const recovered=(await root.query('SELECT state,attempt_no,max_attempts,external_state,available_at<=now() AS available,lease_until FROM tasks WHERE id=$1',[id])).rows[0];
 expect(recovered).toMatchObject({state:'queued',attempt_no:1,max_attempts:3,external_state:'none',available:true,lease_until:null});
 const next=await engine.claim(id,randomUUID());expect(next).not.toBeNull();if(!next)throw new Error('RECOVERED_TASK_NOT_CLAIMABLE');
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
 const id=await create();
 const delivery=(await root.query('SELECT o.id,o.task_id,o.attempts,t.queue FROM task_outbox o JOIN tasks t ON t.id=o.task_id WHERE task_id=$1',[id])).rows[0];
 await publisher.publish(delivery);await root.query("UPDATE task_outbox SET status='sent',sent_at=now() WHERE id=$1",[delivery.id]);
 await root.query('UPDATE tasks SET max_attempts=1 WHERE id=$1',[id]);const attempt=(await engine.claim(id,randomUUID()))!;
 await engine.fail(attempt,'TEMPORARY_FAILURE',true);expect((await service.detail(a,id)).task.state).toBe('failed');
 await service.mutate(a,id,'retry',randomUUID(),{stage:'runtime'});expect((await service.detail(a,id)).task.state).toBe('queued');
 const intents=(await root.query('SELECT id,status FROM task_outbox WHERE task_id=$1',[id])).rows;
 expect(intents).toHaveLength(2);expect(intents).toContainEqual({id:delivery.id,status:'sent'});
 expect(intents.find(row=>row.status==='pending')?.id).not.toBe(delivery.id);
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
 const scheduleId='task-concurrency-'+randomUUID();
 await root.query('INSERT INTO task_schedules(id,interval_seconds) VALUES($1,3600)',[scheduleId]);
 try{
  const s2=new TaskScheduler(schedulerPool,publisher);await Promise.all([scheduler.schedules(),s2.schedules()]);
  expect((await root.query('SELECT count(*)::int n FROM task_schedule_windows WHERE schedule_id=$1',[scheduleId])).rows[0].n).toBe(1);
 }finally{await root.query('UPDATE task_schedules SET enabled=false WHERE id=$1',[scheduleId]);}
 const failed=new TaskScheduler(schedulerPool,{publish:async()=>{throw new Error('queue offline');}});await failed.dispatch();
 expect((await root.query("SELECT count(*)::int n FROM task_outbox WHERE last_error='QUEUE_UNAVAILABLE' AND status='pending'")).rows[0].n).toBeGreaterThan(0);
});
it('enqueue before ack crash and lost Redis job recover from PG; only ID enters BullMQ',async()=>{
 const traceId='queue-original-'+randomUUID(),id=await withTraceId(traceId,()=>create('private-not-in-redis'));
 await withTraceId('retry-different-trace',()=>transaction(workerPool,tx=>enqueueIntent(tx,id)));
 expect((await root.query('SELECT trace_id FROM tasks WHERE id=$1',[id])).rows[0].trace_id).toBe(traceId);
 // Isolate this test delivery from earlier fixtures without deleting their durable records.
 await root.query("UPDATE task_outbox SET available_at=now()+interval '1 hour' WHERE task_id<>$1 AND status='pending'",[id]);
 const d=(await scheduler.claim())!;expect(d.task_id).toBe(id);await publisher.publish(d);
 const queue=publisher.queues.get('content')!;const job=await queue.getJob(d.id);expect(job!.data).toEqual({taskId:id});
 await root.query("UPDATE task_outbox SET lease_until=now()-interval '1 second' WHERE id=$1",[d.id]);
 const again=(await scheduler.claim())!;expect(again.id).toBe(d.id);await publisher.publish(again);await scheduler.acknowledge(again);
 await job!.remove();await root.query("UPDATE task_outbox SET sent_at=now()-interval '1 minute' WHERE id=$1",[d.id]);await scheduler.recover();await scheduler.dispatch();
 expect((await root.query('SELECT id,status FROM task_outbox WHERE task_id=$1',[id])).rows).toEqual([{id:d.id,status:'sent'}]);
 expect((await queue.getJob(d.id))?.data).toEqual({taskId:id});
 const logs:Array<{fields:Record<string,unknown>;message:string}>=[],original=TaskEngine.prototype.execute;
 const logger={info:(fields:Record<string,unknown>,message:string)=>logs.push({fields,message}),error:()=>undefined} as unknown as FastifyBaseLogger;
 const workers=createTaskWorkers(workerPool,cfg('worker'),undefined,logger);
 const execute=vi.spyOn(TaskEngine.prototype,'execute').mockImplementation(function(this:TaskEngine,attempt){if(attempt.task.id===id)expect(currentTraceId()).toBe(traceId);return original.call(this,attempt);});
 try{
  await until(async()=>(await service.detail(a,id)).task.state==='succeeded');
  await until(async()=>logs.some(log=>log.fields.taskId===id&&log.fields.event==='task.step.finished'));
  expect((await root.query('SELECT count(*)::int n FROM task_results WHERE task_id=$1',[id])).rows[0].n).toBe(1);
  const started=logs.find(log=>log.fields.taskId===id&&log.fields.event==='task.step.started');
  expect(started?.fields).toMatchObject({taskId:id,kind:'demo.digest',queue:'content',attempt:1,traceId:traceId,trace_id:expect.stringMatching(/^[a-f0-9]{32}$/),span_id:expect.stringMatching(/^[a-f0-9]{16}$/)});
  const returned=logs.find(log=>log.fields.taskId===id&&log.fields.event==='task.step.finished');
  expect(returned?.fields).toMatchObject({taskId:id,traceId:traceId,trace_id:started?.fields.trace_id,span_id:started?.fields.span_id,'step.outcome':'recorded'});
  expect(returned?.message).toBe('Task step returned');
  expect(logs.map(log=>log.message)).not.toContain('Task step completed');
 }finally{await workers.close();execute.mockRestore();}
},15000);
it('real API contract: task wrapper, auth, schema, result readiness and Admin CSRF/RBAC',async()=>{
 const api=await buildApiServer({config:cfg('api-server')}),admin=await buildAdminServer({config:cfg('admin')});
 const token=await fixtureAccessToken(a.userId,a.sessionId);await root.query('UPDATE user_sessions SET access_hash=$2 WHERE id=$1',[a.sessionId,hash(token)]);
 const headers={...fixtureScopeHeaders(token),'x-idempotency-key':randomUUID(),'x-trace-id':'task-http-original'};
 try{
  const createResponse=await api.inject({method:'POST',url:'/api/v1/tasks/demo',headers,payload:{workspaceId:wa,text:'contract'}});expect(createResponse.statusCode).toBe(200);const id=createResponse.json().data.task.taskId;
  expect(createResponse.headers['x-trace-id']).toBe('task-http-original');expect((await root.query('SELECT trace_id FROM tasks WHERE id=$1',[id])).rows[0].trace_id).toBe('task-http-original');
  const read=await api.inject({url:`/api/v1/tasks/${id}`,headers:fixtureScopeHeaders(token)});expect(read.json().data).toMatchObject({task:{taskType:'demo.digest',state:'queued'},retryActions:[{action:'runtime',allowed:false}]});
  expect((await api.inject(`/api/v1/tasks/${id}`)).statusCode).toBe(401);
  expect((await api.inject({url:`/api/v1/tasks/${id}/result`,headers:fixtureScopeHeaders(token)})).statusCode).toBe(409);
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
