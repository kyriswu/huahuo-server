import type pg from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import type {AppConfig} from '../../config/config.js';
import {canonical,digest} from '../../lib/crypto.js';
import {DocumentExtractionClient,DocumentExtractionError,type ExtractionResponse} from '../../integrations/document-extraction.js';
import {DocumentPreparationError,downloadSourceBytes,parseDownloadedText,validateSourceUri,verifyStructuredSource,type DownloadedSource} from '../rag/document-preparation.js';
import {ProcessingNodes} from '../processing-nodes/service.js';
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
 admission:AbortController;remoteJobId?:string;
}
const native=/\.(txt|md|markdown|csv)$/i;
const supported=/\.(pdf|docx?|pptx?|xlsx?|txt|md|markdown|csv)$/i;
const MAX_BYTES=32*1024*1024;
const TTL=15*60*1000;

/** Admin-only, bounded in-memory results. No notes, resources, ingestion tasks or indexes are created. */
export class AdminDocumentTrials {
 private readonly jobs=new Map<string,Trial>();
 private readonly work=new Set<Promise<void>>();
 private readonly nodes:ProcessingNodes;
 private readonly settings:RuntimeSettings;
 private readonly expiration:NodeJS.Timeout;
 private closed=false;
 constructor(private readonly pool:pg.Pool,private readonly config:AppConfig,private readonly fetchImpl:typeof fetch=fetch){
  this.nodes=new ProcessingNodes(pool,config);this.settings=new RuntimeSettings(pool,config);
  this.expiration=setInterval(()=>this.prune(),60000);this.expiration.unref();
 }
 async authorize(scope:AdminScope){await transaction(this.pool,tx=>assertSuperadmin(tx,scope));}
 async capabilities(){
  const state=await this.settings.load();
  return {maxBytes:Math.min(MAX_BYTES,Number(state.values['storage.maxUploadBytes']),Number(state.values['storage.maxSourceBytes'])),
   structuredEnabled:this.config.processingNodes.enabled&&state.values['document.mode']!=='disabled',retentionSeconds:TTL/1000,
   onlineNodes:(await this.nodes.list()).filter(n=>n.enabled&&n.capabilities.includes('document')).map(n=>({id:n.id,name:n.name})),configRevision:state.revision};
 }
 private prune(){
  const completed=[...this.jobs.values()].filter(j=>j.state!=='running').sort((a,b)=>a.finishedAt!-b.finishedAt!);
  for(const job of completed)if(Date.now()-job.finishedAt!>TTL||this.jobs.size>=4)this.jobs.delete(job.id);
 }
 private audit(scope:AdminScope,action:string,id:string,traceId:string,reason:unknown){
  return this.pool.query('INSERT INTO admin_audit_events(id,admin_id,action,target_id,trace_id,reason) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),scope.adminId,action,id,traceId,JSON.stringify(reason)]);
 }
 async start(scope:AdminScope,input:{url:string}|{file:DownloadedSource},traceId:string){
  await this.authorize(scope);this.prune();
  const loaded=await this.settings.load(),config=applyValues(this.config,loaded.values,loaded.revision);
  if(this.closed||[...this.jobs.values()].some(j=>j.state==='running'))throw new DomainError(429,'ADMIN_TRIAL_BUSY');
  const limit=Math.min(MAX_BYTES,config.maxUploadBytes,config.rag.maxSourceBytes);
  if('url' in input){try{validateSourceUri(input.url,config);}catch(error){if(error instanceof DocumentPreparationError)throw new DomainError(400,error.code);throw error;}}
  else{
   if(!supported.test(input.file.fileName)||input.file.fileName.length>255||/[\0\r\n/\\]/.test(input.file.fileName)||!input.file.bytes.byteLength)throw new DomainError(400,'ADMIN_TRIAL_FILE_INVALID');
   if(input.file.bytes.byteLength>limit)throw new DomainError(413,'ADMIN_TRIAL_FILE_TOO_LARGE');
   if(!native.test(input.file.fileName)&&(!config.documentExtraction.enabled||!config.processingNodes.enabled))throw new DomainError(503,'ADMIN_TRIAL_PARSER_NOT_CONFIGURED');
  }
  const job:Trial={id:randomUUID(),owner:scope.adminId,state:'running',phase:'preparing',createdAt:new Date().toISOString(),configRevision:loaded.revision,metrics:{},cancelRequested:false,admission:new AbortController()};
  this.jobs.set(job.id,job);
  try{await this.audit(scope,'document-trial.start',job.id,traceId,{source:'url' in input?'url':'upload',configRevision:loaded.revision});}
  catch(error){this.jobs.delete(job.id);throw error;}
  const work=this.execute(job,input,config,scope,traceId).finally(()=>this.work.delete(work));this.work.add(work);
  return this.status(scope,job.id);
 }
 private async execute(job:Trial,input:{url:string}|{file:DownloadedSource},config:AppConfig,scope:AdminScope,traceId:string){
  const start=performance.now();
  try{
   job.phase='downloading';const at=performance.now();
   const source='file' in input?input.file:await downloadSourceBytes(input.url,{...config,rag:{...config.rag,maxSourceBytes:Math.min(MAX_BYTES,config.maxUploadBytes,config.rag.maxSourceBytes)}} ,this.fetchImpl);
   job.metrics.downloadMs='file' in input?0:performance.now()-at;job.bytes=source.bytes.byteLength;job.fileName=source.fileName;
   if(!supported.test(source.fileName))throw new DomainError(400,'ADMIN_TRIAL_FILE_INVALID');
   if(job.cancelRequested)throw new DocumentExtractionError('DOCUMENT_EXTRACTION_CANCELLED','settled');
   const validation=performance.now();job.phase='validating';
   if(native.test(source.fileName)){
    const parsed=await parseDownloadedText(source,config.rag.plainTextMaxChars);
    job.result=parsed;job.metrics.parseMs=performance.now()-validation;
   }else{
    const extraction=config.documentExtraction;
    if(!extraction.enabled||!config.processingNodes.enabled)throw new DomainError(503,'ADMIN_TRIAL_PARSER_NOT_CONFIGURED');
    await verifyStructuredSource(source);job.metrics.validationMs=performance.now()-validation;job.configHash=extraction.configHash;job.phase='waiting_node';
    const wait=performance.now(),runId=randomUUID();
    const fingerprint=digest(canonical({sha256:createHash('sha256').update(source.bytes).digest('hex'),fileName:source.fileName,config:extraction.configHash,runId}));
    job.result=await this.nodes.withNode('document',{requestId:job.id,fingerprint,admissionSignal:job.admission.signal},async context=>{
     job.nodeId=(await this.nodes.assigned(job.id)).id;job.metrics.nodeWaitMs=performance.now()-wait;job.phase='parsing';const parse=performance.now();
     const response=await new DocumentExtractionClient(extraction,this.fetchImpl).extract([{bytes:source.bytes,fileName:source.fileName,mimeType:source.contentType??'application/octet-stream',source_resource_id:job.id,parse_run_id:runId}],context,{
      beforeSubmit:async()=>{if(job.cancelRequested)throw new DocumentExtractionError('DOCUMENT_EXTRACTION_CANCELLED','settled');},
      submitted:async id=>{job.remoteJobId=id;},cancellation:async()=>job.cancelRequested?'send':false,
     });
     job.metrics.parseMs=performance.now()-parse;
     if(response.summary.errors||response.results.length!==1)throw new DocumentExtractionError('DOCUMENT_EXTRACTION_FAILED','settled');
     if(Buffer.byteLength(response.results[0]!.content)>16*1024*1024)throw new DocumentExtractionError('DOCUMENT_EXTRACTION_CONTENT_TOO_LARGE','settled');
     return response;
    });
   }
   job.metrics.resultBytes=Buffer.byteLength(JSON.stringify(job.result));job.state='completed';job.phase='completed';
  }catch(error){
   const code=(error as {code?:unknown}).code;
   job.error=typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(code)?code:'ADMIN_TRIAL_FAILED';
   job.state=job.cancelRequested&&['DOCUMENT_EXTRACTION_CANCELLED','DOCUMENT_PARSER_CANCELLED'].includes(job.error)?'cancelled':'failed';job.phase=job.state;delete job.result;
  }finally{
   job.metrics.totalMs=performance.now()-start;job.finishedAt=Date.now();
   await this.audit(scope,'document-trial.finish',job.id,traceId,{state:job.state,error:job.error,remoteJobId:job.remoteJobId,nodeId:job.nodeId,metrics:job.metrics}).catch(()=>undefined);
  }
 }
 private owned(scope:AdminScope,id:string){this.prune();const job=this.jobs.get(id);if(!job||job.owner!==scope.adminId)throw new DomainError(404,'ADMIN_TRIAL_NOT_FOUND');return job;}
 status(scope:AdminScope,id:string){const j=this.owned(scope,id);return {id:j.id,state:j.state,phase:j.phase,fileName:j.fileName,bytes:j.bytes,createdAt:j.createdAt,configRevision:j.configRevision,configHash:j.configHash,nodeId:j.nodeId,remoteJobId:j.remoteJobId,metrics:j.metrics,error:j.error};}
 result(scope:AdminScope,id:string){const job=this.owned(scope,id);if(job.state==='running')throw new DomainError(409,'ADMIN_TRIAL_RUNNING');return {state:job.state,error:job.error,result:job.result??null};}
 cancel(scope:AdminScope,id:string){const job=this.owned(scope,id);if(job.state==='running'){job.cancelRequested=true;job.admission.abort();}return this.status(scope,id);}
 async close(){this.closed=true;clearInterval(this.expiration);for(const j of this.jobs.values())if(j.state==='running'){j.cancelRequested=true;j.admission.abort();}let timer:NodeJS.Timeout|undefined;try{await Promise.race([Promise.allSettled(this.work),new Promise(r=>{timer=setTimeout(r,8000);timer.unref();})]);}finally{if(timer)clearTimeout(timer);}await this.nodes.close();this.jobs.clear();}
}
