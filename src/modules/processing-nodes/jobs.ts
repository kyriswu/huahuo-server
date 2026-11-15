import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import type {AppConfig} from '../../config/config.js';
import {digest,canonical} from '../../lib/crypto.js';
import {ParserExecutionDeferred} from '../../lib/document-parser-machine/index.js';
import {assertSuperadmin,type AdminScope} from '../admin/service.js';
import {DomainError,lock,transaction} from '../identity/store.js';
import {enqueueIntent,event} from '../tasks/model.js';
import type {Attempt} from '../tasks/engine.js';
import {ProcessingNodes} from './service.js';
import {nodeFromRow,nodeConfig} from './model.js';
import {PgEvents} from '../../lib/pg-events.js';

/** Manual startup uses the existing maintenance queue; no process or loop per node. */
export class ProcessingNodeJobs {
 private readonly nodes:ProcessingNodes;
 private readonly events:PgEvents;
 constructor(private readonly pool:pg.Pool,private readonly config:AppConfig,nodes?:ProcessingNodes){this.nodes=nodes??new ProcessingNodes(pool,config);this.events=new PgEvents(pool);}
 async close(){await this.nodes.close();await this.events.close();}
 watch(taskId:string,changed:()=>void){return this.events.subscribe('task_events',taskId,changed);}
 async start(nodeId:string,scope:AdminScope,traceId:string){
  if(!this.config.processingNodes.enabled)throw new DomainError(503,'PROCESSING_NODES_DISABLED');
  return transaction(this.pool,async tx=>{
   await assertSuperadmin(tx,scope);await lock(tx,'node-start:'+nodeId);await lock(tx,'processing-nodes');
   const nodeRow=(await tx.query('SELECT * FROM processing_nodes WHERE id=$1',[nodeId])).rows[0];
   if(!nodeRow)throw new DomainError(404,'PROCESSING_NODE_NOT_FOUND');
   const node=nodeFromRow(nodeRow);nodeConfig(node,this.config.processingNodes);
   if(node.mode!=='ecs')throw new DomainError(400,'PROCESSING_NODE_START_NOT_REQUIRED');
   const reference='node-start:'+nodeId;
   const old=(await tx.query("SELECT id FROM tasks WHERE kind='processing.node-start' AND external_reference=$1 AND state NOT IN ('succeeded','failed','cancelled') LIMIT 1",[reference])).rows[0];
   if(old)return {taskId:old.id,state:'starting'};
   const id=randomUUID();await tx.query("INSERT INTO tasks(id,kind,queue,state,external_reference) VALUES($1,'processing.node-start','maintenance','queued',$2)",[id,reference]);
   await tx.query('INSERT INTO processing_node_assignments(request_id,node_id,capability,snapshot) VALUES($1,$2,$3,$4)',['manual:'+id,node.id,node.capabilities[0],JSON.stringify(node)]);
   await enqueueIntent(tx,id);await event(tx,id);
   await tx.query('INSERT INTO admin_audit_events(id,admin_id,action,target_id,trace_id,reason) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),scope.adminId,'processing-node.start',nodeId,traceId,JSON.stringify({taskId:id})]);
   return {taskId:id,state:'starting'};
  });
 }
 async status(nodeId:string){
  const task=(await this.pool.query("SELECT id,state,error_code,created_at,updated_at FROM tasks WHERE kind='processing.node-start' AND external_reference=$1 ORDER BY created_at DESC LIMIT 1",['node-start:'+nodeId])).rows[0];
  return task?{taskId:task.id,state:task.state==='succeeded'?'ready':['failed','cancelled'].includes(task.state)?'failed':'starting',error:task.error_code,updatedAt:task.updated_at.toISOString()}:null;
 }
 async execute(a:Attempt){
  const reference=(await this.pool.query('SELECT external_reference FROM tasks WHERE id=$1',[a.task.id])).rows[0]?.external_reference;
  const id=typeof reference==='string'?reference.slice('node-start:'.length):'';
  const node=await this.nodes.assigned('manual:'+a.task.id);if(node.id!==id)throw new DomainError(409,'PROCESSING_ASSIGNMENT_CONFLICT');
  const input={requestId:'manual:'+a.task.id,fingerprint:digest(canonical({node:id,operation:'start'})),nodeId:id,recoverAdmission:a.task.attempt_no>1,step:true,admissionSignal:a.signal};
  if(Date.now()-a.task.created_at.getTime()>node.startupSeconds*1000){
   await this.nodes.acknowledgeSettled(input).catch(()=>undefined);
   throw Object.assign(new Error('PROCESSING_NODE_START_TIMEOUT'),{code:'PROCESSING_NODE_START_TIMEOUT',retryable:false});
  }
  try{return await this.nodes.withNode(node.capabilities[0]!,input,async()=>({digest:input.fingerprint,bytes:0}));}
  catch(error){if(error instanceof ParserExecutionDeferred)throw error;throw new ParserExecutionDeferred('admitting',5000);}
 }
}
