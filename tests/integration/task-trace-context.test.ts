import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config/config.js';
import { migrate } from '../../src/db/migrate.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { enqueueIntent } from '../../src/modules/tasks/model.js';
import { TaskEngine } from '../../src/modules/tasks/engine.js';
import { taskLogFields, withTaskTrace } from '../../src/modules/tasks/observability.js';
import { transaction } from '../../src/modules/identity/store.js';
import { withTraceContext } from '../../src/observability/telemetry.js';
import { insertFixtureUser } from './jwt-fixture.js';

const migrationUrl=process.env.TEST_DATABASE_MIGRATION_URL;
if(!migrationUrl||!/^huahuo_test_/.test(new URL(migrationUrl).pathname.slice(1)))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
const config=loadConfig('migrate',{DATABASE_URL:migrationUrl});
const root=poolFor(config),api=poolFor({...config,databaseUrl:process.env.TEST_DATABASE_API_URL!}),worker=poolFor({...config,databaseUrl:process.env.TEST_DATABASE_WORKER_URL!});
const userId=randomUUID(),workspaceId=randomUUID();
const producer={traceparent:'00-1234567890abcdef1234567890abcdef-1234567890abcdef-01',tracestate:'fixture=producer'};
const other={traceparent:'00-abcdef1234567890abcdef1234567890-abcdef1234567890-01'};
async function queued(){
 const id=randomUUID();await api.query("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,state,trace_id) VALUES($1,$2,$3,'maintenance.check','content','queued','original-correlation')",[id,userId,workspaceId]);return id;
}
const context=async(id:string)=>(await api.query('SELECT trace_context FROM tasks WHERE id=$1',[id])).rows[0].trace_context;
beforeAll(async()=>{
 await migrate(config);await insertFixtureUser(root,userId);
 await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'trace fixture',true,$3)",[workspaceId,userId,randomUUID()]);
},20000);
afterAll(()=>Promise.all([root.end(),api.end(),worker.end()]));

it('persists the producer with the outbox, preserves it on retry, and restores it in a fresh consumer',async()=>{
 const id=await queued();
 await withTraceContext({...producer,authorization:'not-carried'},()=>transaction(api,tx=>enqueueIntent(tx,id)));
 expect(await context(id)).toEqual(producer);
 await withTraceContext(other,()=>transaction(api,tx=>enqueueIntent(tx,id)));
 expect(await context(id)).toEqual(producer);
 const first=(await new TaskEngine(worker,60000).claim(id,randomUUID()))!;
 expect(first.task.trace_context).toEqual(producer);
 const fields=await withTaskTrace(first,async()=>taskLogFields(first));
 expect(fields).toMatchObject({taskId:id,traceId:'original-correlation',trace_id:producer.traceparent.split('-')[1]});
 expect(fields.span_id).not.toBe(producer.traceparent.split('-')[2]);
 await withTraceContext(other,()=>new TaskEngine(worker,60000).fail(first,'RETRY_PROBE',true));
 await root.query('UPDATE tasks SET available_at=now() WHERE id=$1',[id]);
 const restarted=(await new TaskEngine(worker,60000).claim(id,randomUUID()))!;
 expect(restarted.attempt).toBe(2);expect(restarted.task.trace_context).toEqual(producer);
 const retried=await withTaskTrace(restarted,async()=>taskLogFields(restarted));
 expect(retried.trace_id).toBe(fields.trace_id);expect(retried.span_id).not.toBe(fields.span_id);
});

it('rolls back carrier capture and outbox together and leaves legacy attempted tasks NULL',async()=>{
 const id=await queued();
 await expect(withTraceContext(producer,()=>transaction(api,async tx=>{await enqueueIntent(tx,id);throw Error('ROLLBACK_PROBE');}))).rejects.toThrow('ROLLBACK_PROBE');
 expect(await context(id)).toBeNull();
 expect((await api.query('SELECT id FROM task_outbox WHERE task_id=$1',[id])).rows).toEqual([]);
 await root.query('UPDATE tasks SET attempt_no=1 WHERE id=$1',[id]);
 await withTraceContext(other,()=>transaction(api,tx=>enqueueIntent(tx,id)));
 expect(await context(id)).toBeNull();
});

it('adds nullable bounded technical metadata without a backfill or physical relationship',async()=>{
 const column=(await root.query("SELECT is_nullable,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='tasks' AND column_name='trace_context'")).rows[0];
 expect(column).toEqual({is_nullable:'YES',data_type:'jsonb'});
 const id=await queued();expect(await context(id)).toBeNull();
 for(const invalid of [{},[],{traceparent:'bad'},{...producer,authorization:'private'}]){
  await expect(api.query('UPDATE tasks SET trace_context=$2::jsonb WHERE id=$1',[id,JSON.stringify(invalid)])).rejects.toMatchObject({code:'23514'});
 }
 await api.query('UPDATE tasks SET trace_context=$2::jsonb WHERE id=$1',[id,JSON.stringify(producer)]);expect(await context(id)).toEqual(producer);
 expect(Number((await root.query("SELECT count(*) count FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace")).rows[0].count)).toBe(0);
});
