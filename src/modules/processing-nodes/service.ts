import type pg from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {canonical} from '../../lib/crypto.js';
import type {AppConfig} from '../../config/config.js';
import {createDocumentParserMachine,type ParserContext,type ParserRequest,type MachineObservation} from '../../lib/document-parser-machine/index.js';
import {DomainError,lock,transaction} from '../identity/store.js';
import {nodeConfig,nodeFromRow,type Capability,type ProcessingNode} from './model.js';
import {defaultDocumentApi} from '../../config/document-extraction.js';
import {assertSuperadmin,type AdminScope} from '../admin/service.js';
type Runtime=ReturnType<typeof createDocumentParserMachine>;
type Factory=(config:ReturnType<typeof nodeConfig>)=>Runtime;
export type NodeObservation=MachineObservation&{checkedAt:string};
const routing=(node:ProcessingNode)=>{const value={...node} as ProcessingNode&{enabled?:boolean};delete value.enabled;return canonical({...value,name:'',revision:0,capabilities:[...node.capabilities].sort(),eciFallback:node.eciFallback??null});};
const lifecycleRouting=(node:ProcessingNode)=>routing({...node,documentApi:defaultDocumentApi()});
export class ProcessingNodes {
 private runtimes=new Map<string,{key:string;runtime:Runtime;connected:Promise<void>}>();
 private timer?:NodeJS.Timeout;private refresh?:Promise<void>;private closed=false;
 private readonly observations=new Map<string,{key:string;until:number;pending:Promise<NodeObservation>}>();
 constructor(private readonly pool:pg.Pool,private readonly config:AppConfig,private readonly factory:Factory=cfg=>createDocumentParserMachine(cfg,config.redisQueueUrl,config.queuePrefix)){ }
 async list():Promise<ProcessingNode[]>{return (await this.pool.query('SELECT * FROM processing_nodes ORDER BY created_at,id')).rows.map(nodeFromRow);}
 private async node(id:string){const row=(await this.pool.query('SELECT * FROM processing_nodes WHERE id=$1',[id])).rows[0];if(!row)throw new DomainError(404,'PROCESSING_NODE_NOT_FOUND');return nodeFromRow(row);}
 async observe(id:string):Promise<NodeObservation>{
  const node=await this.node(id),key=routing(node),cached=this.observations.get(id);
  if(cached?.key===key&&cached.until>Date.now())return cached.pending;
  const pending=(async()=>{
   try{return {...await (await this.runtime(node,false)).machine.observe(),checkedAt:new Date().toISOString()};}
   catch{return {state:'unknown' as const,source:node.mode==='ecs'?'ecs' as const:'http' as const,serviceReady:null,serviceStatus:'not_checked' as const,canStart:false,reason:'PROCESSING_NODE_STATUS_UNAVAILABLE',checkedAt:new Date().toISOString()};}
  })();
  this.observations.set(id,{key,until:Date.now()+3000,pending});return pending;
 }
 async watchStatus(id:string,changed:()=>void){
  const runtime=await this.runtime(await this.node(id),false);let timer:NodeJS.Timeout|undefined;
  const unsubscribe=await runtime.watch(()=>{if(!timer){timer=setTimeout(()=>{timer=undefined;this.observations.delete(id);changed();},300);timer.unref();}});
  return ()=>{if(timer)clearTimeout(timer);unsubscribe();};
 }
 invalidateStatus(id:string){this.observations.delete(id);}
 async runtime(node:ProcessingNode,requireApiToken=true):Promise<Runtime>{
  const cfg={...nodeConfig(node,this.config.processingNodes,requireApiToken),canStop:async()=>!(await this.pool.query('SELECT 1 FROM processing_node_assignments WHERE node_id=$1 AND NOT settled LIMIT 1',[node.id])).rowCount},key=JSON.stringify({...cfg,apiToken:cfg.apiToken?createHash('sha256').update(cfg.apiToken).digest('hex'):undefined});
  let entry=this.runtimes.get(node.id);
  if(entry&&entry.key!==key){await entry.connected;await entry.runtime.close();this.runtimes.delete(node.id);entry=undefined;}
  if(!entry){const runtime=this.factory(cfg);entry={key,runtime,connected:runtime.connect()};this.runtimes.set(node.id,entry);}
  try{await entry.connected;return entry.runtime;}catch(error){if(this.runtimes.get(node.id)===entry)this.runtimes.delete(node.id);await entry.runtime.close().catch(()=>undefined);throw error;}
 }
 async bind(requestId:string,capability:Capability,recoverAdmission=false,retryFrom?:string,nodeId?:string,powerOnly=false):Promise<ProcessingNode>{
  if(powerOnly&&!this.config.processingNodes.cloudControlEnabled)throw new DomainError(503,'PROCESSING_NODE_CLOUD_CONTROL_DISABLED');
  if(!requestId||requestId.length>256||!['document','audio'].includes(capability))throw new DomainError(400,'PROCESSING_ASSIGNMENT_INVALID');
  return transaction(this.pool,async tx=>{
   await lock(tx,'processing-nodes');
   const old=(await tx.query('SELECT * FROM processing_node_assignments WHERE request_id=$1',[requestId])).rows[0];
   if(old){
    if(old.capability!==capability)throw new DomainError(409,'PROCESSING_ASSIGNMENT_CONFLICT');
    if(old.settled){
     if(!recoverAdmission)throw new DomainError(409,'PROCESSING_ASSIGNMENT_SETTLED');
     const current=(await tx.query('SELECT * FROM processing_nodes WHERE id=$1',[old.node_id])).rows[0];
     if(!current||routing(nodeFromRow(current))!==routing(old.snapshot))throw new DomainError(409,'PROCESSING_NODE_CONFIGURATION_CHANGED');
     await tx.query('UPDATE processing_node_assignments SET settled=false,settled_at=NULL WHERE request_id=$1',[requestId]);
    }
    return old.snapshot as ProcessingNode;
   }
   let node:ProcessingNode;
   if(retryFrom){
    const previous=(await tx.query('SELECT * FROM processing_node_assignments WHERE request_id=$1',[retryFrom])).rows[0];
    if(!previous?.settled||previous.capability!==capability)throw new DomainError(409,'PROCESSING_ASSIGNMENT_CONFLICT');
    const current=(await tx.query('SELECT * FROM processing_nodes WHERE id=$1',[previous.node_id])).rows[0];
    if(!current||lifecycleRouting(nodeFromRow(current))!==lifecycleRouting(previous.snapshot))throw new DomainError(409,'PROCESSING_NODE_CONFIGURATION_CHANGED');
    node=previous.snapshot as ProcessingNode;
   }else if(nodeId){
    const row=(await tx.query('SELECT * FROM processing_nodes WHERE id=$1',[nodeId])).rows[0];
    if(!row)throw new DomainError(404,'PROCESSING_NODE_NOT_FOUND');node=nodeFromRow(row);
    if(!node.capabilities.includes(capability))throw new DomainError(409,'PROCESSING_ASSIGNMENT_CONFLICT');
   }else{
   const row=(await tx.query(`SELECT n.* FROM processing_nodes n
    WHERE n.config @> jsonb_build_object('capabilities',jsonb_build_array($1::text))
    ORDER BY (SELECT count(*)::float/(n.config->>'concurrency')::integer FROM processing_node_assignments a WHERE a.node_id=n.id AND NOT a.settled),n.created_at,n.id
    LIMIT 1`,[capability])).rows[0];
   if(!row)throw new DomainError(503,'PROCESSING_NODE_UNAVAILABLE');
   node=nodeFromRow(row);
   }
   nodeConfig(node,this.config.processingNodes,!powerOnly);
   await tx.query('INSERT INTO processing_node_assignments(request_id,node_id,capability,snapshot) VALUES($1,$2,$3,$4)',[requestId,node.id,capability,JSON.stringify(node)]);
   return node;
  });
 }
 async assigned(requestId:string):Promise<ProcessingNode>{
  const row=(await this.pool.query('SELECT snapshot,settled FROM processing_node_assignments WHERE request_id=$1',[requestId])).rows[0];
  if(!row)throw new DomainError(409,'PROCESSING_ASSIGNMENT_MISSING');if(row.settled)throw new DomainError(409,'PROCESSING_ASSIGNMENT_SETTLED');return row.snapshot as ProcessingNode;
 }
 async settle(requestId:string){await this.pool.query('UPDATE processing_node_assignments SET settled=true,settled_at=coalesce(settled_at,now()) WHERE request_id=$1',[requestId]);}
 async withNode<T>(capability:Capability,input:ParserRequest&{retryFrom?:string;nodeId?:string},execute:(context:ParserContext,node:ProcessingNode)=>Promise<T>):Promise<T>{
  const powerOnly=input.readiness==='instance';
  if(powerOnly&&!this.config.processingNodes.cloudControlEnabled)throw new DomainError(503,'PROCESSING_NODE_CLOUD_CONTROL_DISABLED');
  const node=input.resume?await this.assigned(input.requestId):await this.bind(input.requestId,capability,input.recoverAdmission,input.retryFrom,input.nodeId,powerOnly);
  if(!node.capabilities.includes(capability))throw new DomainError(409,'PROCESSING_ASSIGNMENT_CONFLICT');
  const runtime=await this.runtime(node,!powerOnly);
  try{
   // Lost Redis must not erase durable remote occupancy or turn an uncertain old run into a new POST.
   const count=Number((await this.pool.query('SELECT count(*) AS n FROM processing_node_assignments WHERE node_id=$1 AND NOT settled AND started AND request_id<>$2',[node.id,input.requestId])).rows[0].n);
   const state=await runtime.machine.state.status();
   const own=(await this.pool.query('SELECT started FROM processing_node_assignments WHERE request_id=$1',[input.requestId])).rows[0];
   if(!state&&own?.started)throw new DomainError(503,'PROCESSING_NODE_COORDINATION_UNCERTAIN');
   if(count>(state?.active??0)+(state?.queued??0))throw new DomainError(503,'PROCESSING_NODE_COORDINATION_UNCERTAIN');
   await this.pool.query('UPDATE processing_node_assignments SET started=true WHERE request_id=$1',[input.requestId]);
   return await runtime.machine.withDocumentParser(input,async context=>{
    return execute(context,node);
   });
  }
  finally{
   // A missing Redis database is not evidence of completion. Require its settled receipt.
   try{const outcome=await runtime.machine.state.requestOutcome(createHash('sha256').update(input.requestId).digest('hex'));
    if(outcome&&['succeeded','failed','cancelled','settled'].includes(outcome))await this.settle(input.requestId);
   }catch{/* Preserve the durable assignment on ambiguous coordination/storage failure. */}
  }
 }
 async acknowledgeSettled(input:ParserRequest,db:Pick<pg.PoolClient,'query'>=this.pool){
  const row=(await db.query('SELECT settled,snapshot FROM processing_node_assignments WHERE request_id=$1',[input.requestId])).rows[0];if(row?.settled)return;
  if(!row)throw new DomainError(409,'PROCESSING_ASSIGNMENT_MISSING');
  const runtime=await this.runtime(row.snapshot as ProcessingNode,input.readiness!=='instance');
  try{await runtime.machine.acknowledgeSettled(input);}catch(error){if(!['DOCUMENT_PARSER_LEASE_LOST','DOCUMENT_PARSER_NOT_UNCERTAIN'].includes((error as {code:string}).code))throw error;}
  await db.query('UPDATE processing_node_assignments SET settled=true,settled_at=coalesce(settled_at,now()) WHERE request_id=$1',[input.requestId]);
 }
 async startMonitors(onError:(error:unknown)=>void=()=>undefined){
  if(!this.config.processingNodes.cloudControlEnabled)return;
  const update=async()=>{
   try{
    for(const node of await this.list()){
    try{const runtime=await this.runtime(node,false);await runtime.startIdleMonitor({onError});}catch(error){onError(error);}
   }}catch(error){onError(error);}
   finally{if(!this.closed){this.timer=setTimeout(()=>{this.refresh=update();},30000);this.timer.unref();}}
  };this.refresh=update();await this.refresh;
 }
 async close(){this.closed=true;if(this.timer)clearTimeout(this.timer);await this.refresh;await Promise.all([...this.runtimes.values()].map(async e=>{await e.connected.catch(()=>undefined);await e.runtime.close();}));this.runtimes.clear();this.observations.clear();}
 async update(input:ProcessingNode,expectedRevision:number,scope:AdminScope,traceId:string):Promise<ProcessingNode>{
  return transaction(this.pool,async tx=>{
   await assertSuperadmin(tx,scope);
   await lock(tx,'processing-nodes');
   const oldRow=(await tx.query('SELECT * FROM processing_nodes WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
   if(!oldRow)throw new DomainError(404,'PROCESSING_NODE_NOT_FOUND');
   const old=nodeFromRow(oldRow);
   if(old.revision!==expectedRevision)throw new DomainError(409,'CONFIGURATION_CONFLICT');
   const validated=nodeConfig(input,this.config.processingNodes);
   input={...input,name:input.name.trim(),baseUrl:validated.baseUrl,eciFallback:input.eciFallback??null,
    ...(input.capabilities.includes('document')?{documentApi:input.documentApi??defaultDocumentApi()}:{})};
   const changed=routing(old)!==routing(input);
   let release:(()=>Promise<void>)|undefined;
   try{
    if(changed){
     if((await tx.query('SELECT 1 FROM processing_node_assignments WHERE node_id=$1 AND NOT settled LIMIT 1',[input.id])).rowCount)throw new DomainError(409,'PROCESSING_NODE_BUSY');
     const runtime=await this.runtime(old),status=await runtime.machine.state.status();
     if(status){
      if(status.phase!=='ready'||status.active||status.queued||status.uncertain||status.eciTarget||(old.mode==='ecs'&&!status.economicallyStopped))throw new DomainError(409,'PROCESSING_NODE_NOT_DRAINED');
      const token=randomUUID();if(!await runtime.machine.state.lock(token,'configure'))throw new DomainError(409,'PROCESSING_NODE_BUSY');
      release=()=>runtime.machine.state.unlock(token);
      // Freeze old runtimes before publishing the DB revision. DB rollback after this fails closed.
      const nextRuntime=this.factory(nodeConfig(input,this.config.processingNodes));
      try{await nextRuntime.connect();await nextRuntime.machine.state.configureLocked(token,old.mode);}finally{await nextRuntime.close();}
     }
    }
    const revision=expectedRevision+1;
    const config=Object.fromEntries(Object.entries(input).filter(([key])=>key!=='id'&&key!=='revision'));
    await tx.query('UPDATE processing_nodes SET config=$2,revision=$3,updated_at=now() WHERE id=$1',[input.id,JSON.stringify({...config,enabled:true}),revision]);
    await tx.query('INSERT INTO admin_audit_events(id,admin_id,action,target_id,reason,trace_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),scope.adminId,'processing-node.update',input.id,JSON.stringify({before:old,after:{...input,revision}}),traceId]);
    return {...input,revision};
   }catch(error){if((error as {code:string}).code==='23505')throw new DomainError(409,'PROCESSING_NODE_IDENTITY_EXISTS');throw error;}
   finally{await release?.();}
  });
 }
}
