import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import type {AppConfig} from '../../config/config.js';
import {DocumentExtractionClient,type ExtractionResponse} from '../../integrations/document-extraction.js';
import {DocumentPreparationError,sourceFromUrl} from '../rag/document-preparation.js';
import {ProcessingNodes} from '../processing-nodes/service.js';
import {nodeConfig,nodeDocumentConfig,type ProcessingNode} from '../processing-nodes/model.js';
import {RuntimeSettings} from '../runtime-settings/service.js';
import {applyValues} from '../runtime-settings/registry.js';
import {DomainError,transaction} from '../identity/store.js';
import {assertSuperadmin,type AdminScope} from './service.js';

type State='running'|'completed'|'failed'|'cancelled';
interface Trial {
 id:string;owner:string;state:State;phase:string;createdAt:string;finishedAt?:number;
 fileName:string;configRevision:number;configHash?:string;nodeId?:string;
 metrics:Record<string,number>;error?:string;result?:ExtractionResponse;cancelRequested:boolean;
 controller:AbortController;remoteJobId?:string;started:number;
}
const supported=/\.(pdf|docx?|pptx?|xlsx?|txt|md|markdown|csv)$/i;
const TTL=15*60*1000;

/** One Admin feature probe: bounded in-memory display, no task, callback or result writes. */
export class AdminDocumentTrials {
 private readonly jobs=new Map<string,Trial>();private readonly changes=new EventEmitter();
 private readonly nodes:ProcessingNodes;private readonly settings:RuntimeSettings;
 private readonly expiration:NodeJS.Timeout;private closed=false;
 constructor(private readonly pool:pg.Pool,private readonly config:AppConfig,private readonly fetchImpl:typeof fetch=fetch){
  this.nodes=new ProcessingNodes(pool,config);this.settings=new RuntimeSettings(pool,config);
  this.expiration=setInterval(()=>this.prune(),60000);this.expiration.unref();
 }
 async authorize(scope:AdminScope){await transaction(this.pool,tx=>assertSuperadmin(tx,scope));}
 async capabilities(){const state=await this.settings.load(),onlineNodes=(await this.nodes.list()).filter(n=>n.capabilities.includes('document')).map(n=>({id:n.id,name:n.name}));
  return {parserEnabled:onlineNodes.length>0,
   retentionSeconds:TTL/1000,unavailableReason:!onlineNodes.length?'no_online_node':null,onlineNodes,configRevision:state.revision};
 }
 private prune(){for(const j of [...this.jobs.values()].filter(j=>j.state!=='running').sort((a,b)=>a.finishedAt!-b.finishedAt!))if(Date.now()-j.finishedAt!>TTL||this.jobs.size>=4)this.jobs.delete(j.id);}
 async start(scope:AdminScope,input:{url:string}){
  await this.authorize(scope);this.prune();const loaded=await this.settings.load(),config=applyValues(this.config,loaded.values,loaded.revision);
  if(this.closed||[...this.jobs.values()].some(j=>j.state==='running'))throw new DomainError(429,'ADMIN_TRIAL_BUSY');
  let source:ReturnType<typeof sourceFromUrl>;
  try{source=sourceFromUrl(input.url,config);}catch(e){if(e instanceof DocumentPreparationError)throw new DomainError(400,e.code);throw e;}
  if(!supported.test(source.fileName))throw new DomainError(400,'ADMIN_TRIAL_FILE_INVALID');
  const node=(await this.nodes.list()).find(n=>n.capabilities.includes('document'));
  if(!node)throw new DomainError(503,'ADMIN_TRIAL_PARSER_NOT_CONFIGURED');
  // Re-check after capability reads so concurrent submissions cannot both enter.
  if(this.closed||[...this.jobs.values()].some(j=>j.state==='running'))throw new DomainError(429,'ADMIN_TRIAL_BUSY');
  const job:Trial={id:randomUUID(),owner:scope.adminId,state:'running',phase:'preparing',fileName:source.fileName,createdAt:new Date().toISOString(),configRevision:loaded.revision,metrics:{},cancelRequested:false,controller:new AbortController(),started:performance.now()};
  this.jobs.set(job.id,job);void this.execute(job,source,node,config);return this.status(scope,job.id);
 }
 private async execute(job:Trial,source:ReturnType<typeof sourceFromUrl>,node:ProcessingNode,config:AppConfig){
  const fetchTrial:typeof fetch=(url,options)=>this.fetchImpl(url,{...options,signal:options?.signal?AbortSignal.any([job.controller.signal,options.signal]):job.controller.signal});
  try{
   job.controller.signal.throwIfAborted();job.phase='parsing';this.changed(job);const parsing=performance.now();
   const target=nodeConfig(node,config.processingNodes),extraction=nodeDocumentConfig(node);
   job.nodeId=node.id;job.configHash=extraction.configHash;
   // Probe the configured API directly. User task admission, machine power,
   // durable callbacks and restart recovery belong to the business workflow.
   if(target.healthPath)try{
    const ready=await fetchTrial(new URL(target.baseUrl.replace(/\/$/,'')+target.healthPath),{method:'GET',headers:target.apiToken?{Authorization:`Bearer ${target.apiToken}`}:{},signal:AbortSignal.any([job.controller.signal,AbortSignal.timeout(5000)]),redirect:'error'});
    const healthy=ready.ok;await ready.body?.cancel();if(!healthy)throw Error('NOT_READY');
   }catch{throw new DomainError(503,'ADMIN_TRIAL_SERVICE_UNREACHABLE');}
   job.result=await new DocumentExtractionClient(extraction,fetchTrial).extract([{
    ...source,source_resource_id:job.id,parse_run_id:randomUUID(),
   }],{baseUrl:target.baseUrl,headers:target.apiToken?{Authorization:`Bearer ${target.apiToken}`}:{},signal:job.controller.signal},{
    beforeSubmit:async()=>{job.controller.signal.throwIfAborted();},submitted:async id=>{job.remoteJobId=id;},
    cancellation:async()=>job.cancelRequested?'send':false,
   });
   job.metrics.parseMs=performance.now()-parsing;this.finish(job,job.cancelRequested?'cancelled':'completed');
  }catch(error){const code=(error as {code?:unknown}).code;this.finish(job,job.cancelRequested?'cancelled':'failed',typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(code)?code:'ADMIN_TRIAL_FAILED');}
 }
 private changed(job:Trial){if(!this.closed)this.changes.emit(job.id);}
 private finish(job:Trial,state:Exclude<State,'running'>,error?:string){
  if(job.state!=='running')return;job.state=state;job.phase=state;job.error=error;job.finishedAt=Date.now();
  if(state!=='completed')delete job.result;else job.metrics.resultBytes=Buffer.byteLength(JSON.stringify(job.result));
  job.metrics.totalMs=performance.now()-job.started;this.changed(job);
 }
 private owned(scope:AdminScope,id:string){this.prune();const j=this.jobs.get(id);if(!j||j.owner!==scope.adminId)throw new DomainError(404,'ADMIN_TRIAL_NOT_FOUND');return j;}
 status(scope:AdminScope,id:string){const j=this.owned(scope,id);return {id:j.id,state:j.state,phase:j.phase,fileName:j.fileName,createdAt:j.createdAt,configRevision:j.configRevision,configHash:j.configHash,nodeId:j.nodeId,remoteJobId:j.remoteJobId,metrics:j.metrics,error:j.error};}
 watch(scope:AdminScope,id:string,changed:()=>void){this.owned(scope,id);this.changes.on(id,changed);return ()=>this.changes.off(id,changed);}
 result(scope:AdminScope,id:string){const j=this.owned(scope,id);if(j.state==='running')throw new DomainError(409,'ADMIN_TRIAL_RUNNING');return {state:j.state,error:j.error,result:j.result??null};}
 cancel(scope:AdminScope,id:string){const j=this.owned(scope,id);if(j.state==='running'){j.cancelRequested=true;if(!j.remoteJobId)j.controller.abort();}return this.status(scope,id);}
 async close(){this.closed=true;clearInterval(this.expiration);for(const j of this.jobs.values())j.controller.abort();this.jobs.clear();this.changes.removeAllListeners();await this.nodes.close();}
}
