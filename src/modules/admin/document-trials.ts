import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import type {AppConfig} from '../../config/config.js';
import {DocumentExtractionClient,type ExtractionResponse} from '../../integrations/document-extraction.js';
import {DocumentPreparationError,downloadSourceBytes,parseDownloadedText,validateSourceUri,verifyStructuredSource,type DownloadedSource} from '../rag/document-preparation.js';
import {ProcessingNodes} from '../processing-nodes/service.js';
import {nodeConfig,nodeDocumentConfig} from '../processing-nodes/model.js';
import {RuntimeSettings} from '../runtime-settings/service.js';
import {applyValues} from '../runtime-settings/registry.js';
import {DomainError,transaction} from '../identity/store.js';
import {assertSuperadmin,type AdminScope} from './service.js';

type Result=ExtractionResponse|{content:string;format:string};
type State='running'|'completed'|'failed'|'cancelled';
interface Trial {
 id:string;owner:string;state:State;phase:string;createdAt:string;finishedAt?:number;
 fileName?:string;bytes?:number;configRevision:number;configHash?:string;nodeId?:string;
 metrics:Record<string,number>;error?:string;result?:Result;cancelRequested:boolean;
 controller:AbortController;remoteJobId?:string;started:number;
}
const native=/\.(txt|md|markdown|csv)$/i,supported=/\.(pdf|docx?|pptx?|xlsx?|txt|md|markdown|csv)$/i;
const MAX_BYTES=32*1024*1024,TTL=15*60*1000;

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
 async capabilities(){const state=await this.settings.load(),onlineNodes=(await this.nodes.list()).filter(n=>n.enabled&&n.capabilities.includes('document')).map(n=>({id:n.id,name:n.name}));
  return {maxBytes:Math.min(MAX_BYTES,Number(state.values['storage.maxUploadBytes']),Number(state.values['storage.maxSourceBytes'])),structuredEnabled:this.config.processingNodes.enabled&&onlineNodes.length>0,
   retentionSeconds:TTL/1000,unavailableReason:!this.config.processingNodes.enabled?'deployment_disabled':!onlineNodes.length?'no_online_node':null,onlineNodes,configRevision:state.revision};
 }
 private prune(){for(const j of [...this.jobs.values()].filter(j=>j.state!=='running').sort((a,b)=>a.finishedAt!-b.finishedAt!))if(Date.now()-j.finishedAt!>TTL||this.jobs.size>=4)this.jobs.delete(j.id);}
 async start(scope:AdminScope,input:{url:string}|{file:DownloadedSource}){
  await this.authorize(scope);this.prune();const loaded=await this.settings.load(),config=applyValues(this.config,loaded.values,loaded.revision);
  if(this.closed||[...this.jobs.values()].some(j=>j.state==='running'))throw new DomainError(429,'ADMIN_TRIAL_BUSY');
  if('url' in input){try{validateSourceUri(input.url,config);}catch(e){if(e instanceof DocumentPreparationError)throw new DomainError(400,e.code);throw e;}}
  else{
   if(!supported.test(input.file.fileName)||input.file.fileName.length>255||/[\0\r\n/\\]/.test(input.file.fileName)||!input.file.bytes.byteLength)throw new DomainError(400,'ADMIN_TRIAL_FILE_INVALID');
   if(input.file.bytes.byteLength>Math.min(MAX_BYTES,config.maxUploadBytes,config.rag.maxSourceBytes))throw new DomainError(413,'ADMIN_TRIAL_FILE_TOO_LARGE');
   if(!native.test(input.file.fileName)&&!(await this.capabilities()).structuredEnabled)throw new DomainError(503,'ADMIN_TRIAL_PARSER_NOT_CONFIGURED');
  }
  // Re-check after capability reads so concurrent submissions cannot both enter.
  if(this.closed||[...this.jobs.values()].some(j=>j.state==='running'))throw new DomainError(429,'ADMIN_TRIAL_BUSY');
  const job:Trial={id:randomUUID(),owner:scope.adminId,state:'running',phase:'preparing',createdAt:new Date().toISOString(),configRevision:loaded.revision,metrics:{},cancelRequested:false,controller:new AbortController(),started:performance.now()};
  this.jobs.set(job.id,job);void this.execute(job,input,config);return this.status(scope,job.id);
 }
 private async execute(job:Trial,input:{url:string}|{file:DownloadedSource},config:AppConfig){
  const fetchTrial:typeof fetch=(url,options)=>this.fetchImpl(url,{...options,signal:options?.signal?AbortSignal.any([job.controller.signal,options.signal]):job.controller.signal});
  try{
   job.phase='downloading';this.changed(job);const at=performance.now();
   const source='file' in input?input.file:await downloadSourceBytes(input.url,{...config,rag:{...config.rag,maxSourceBytes:Math.min(MAX_BYTES,config.maxUploadBytes,config.rag.maxSourceBytes)}},fetchTrial);
   job.metrics.downloadMs='file' in input?0:performance.now()-at;job.bytes=source.bytes.byteLength;job.fileName=source.fileName;
   if(!supported.test(source.fileName))throw new DomainError(400,'ADMIN_TRIAL_FILE_INVALID');
   job.controller.signal.throwIfAborted();job.phase='parsing';this.changed(job);const parsing=performance.now();
   if(native.test(source.fileName))job.result=await parseDownloadedText(source,config.rag.plainTextMaxChars);
   else{
    if(!config.processingNodes.enabled)throw new DomainError(503,'ADMIN_TRIAL_PARSER_NOT_CONFIGURED');
    await verifyStructuredSource(source);
    const node=(await this.nodes.list()).find(n=>n.enabled&&n.capabilities.includes('document'));
    if(!node)throw new DomainError(503,'ADMIN_TRIAL_PARSER_NOT_CONFIGURED');
    const target=nodeConfig(node,config.processingNodes),extraction=nodeDocumentConfig(node);
    job.nodeId=node.id;job.configHash=extraction.configHash;
    // Probe the configured API directly. User task admission, machine power,
    // durable callbacks and restart recovery belong to the business workflow.
    job.result=await new DocumentExtractionClient(extraction,fetchTrial,Math.min(MAX_BYTES,config.maxUploadBytes,config.rag.maxSourceBytes)).extract([{
     bytes:source.bytes,fileName:source.fileName,mimeType:source.contentType??'application/pdf',source_resource_id:job.id,parse_run_id:randomUUID(),
    }],{baseUrl:target.baseUrl,headers:target.apiToken?{Authorization:`Bearer ${target.apiToken}`}:{},signal:job.controller.signal},{
     beforeSubmit:async()=>{job.controller.signal.throwIfAborted();},submitted:async id=>{job.remoteJobId=id;},
     cancellation:async()=>job.cancelRequested?'send':false,
    });
   }
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
 status(scope:AdminScope,id:string){const j=this.owned(scope,id);return {id:j.id,state:j.state,phase:j.phase,fileName:j.fileName,bytes:j.bytes,createdAt:j.createdAt,configRevision:j.configRevision,configHash:j.configHash,nodeId:j.nodeId,remoteJobId:j.remoteJobId,metrics:j.metrics,error:j.error};}
 watch(scope:AdminScope,id:string,changed:()=>void){this.owned(scope,id);this.changes.on(id,changed);return ()=>this.changes.off(id,changed);}
 result(scope:AdminScope,id:string){const j=this.owned(scope,id);if(j.state==='running')throw new DomainError(409,'ADMIN_TRIAL_RUNNING');return {state:j.state,error:j.error,result:j.result??null};}
 cancel(scope:AdminScope,id:string){const j=this.owned(scope,id);if(j.state==='running'){j.cancelRequested=true;if(!j.remoteJobId)j.controller.abort();}return this.status(scope,id);}
 async close(){this.closed=true;clearInterval(this.expiration);for(const j of this.jobs.values())j.controller.abort();this.jobs.clear();this.changes.removeAllListeners();await this.nodes.close();}
}
