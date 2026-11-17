import {DOCUMENT_CANONICAL_MAX_BYTES} from '../../config/document-extraction.js';
import type pg from 'pg';
import { Readable } from 'node:stream';
import {createHash} from 'node:crypto';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import type { AppConfig } from '../../config/config.js';
import { canonical, digest } from '../../lib/crypto.js';
import { ParserMachineError,ParserExecutionDeferred } from '../../lib/document-parser-machine/index.js';
import {ProcessingNodes} from '../processing-nodes/service.js';
import {nodeDocumentConfig} from '../processing-nodes/model.js';
import { DocumentExtractionClient, DocumentExtractionError, type ExtractionResponse,type ExtractionDocument } from '../../integrations/document-extraction.js';
import { transaction,DomainError } from '../identity/store.js';
import type {TaskRow} from '../tasks/model.js';
import {finalizeUnsuccessfulTaskTx} from '../tasks/reservations.js';
import type { Attempt } from '../tasks/engine.js';
import type { StoragePort } from '../storage/port.js';
import {DocumentPreparationError,validateSourceUri, type DocumentSource} from '../rag/document-preparation.js';
import type { DocumentParserSnapshot } from '../rag/processing-profile.js';
import {DocumentCallbacks} from './document-callbacks.js';
import {decodeDocumentReference,encodeDocumentReference,type DocumentParseState as ParseState} from './document-reference.js';
import {ownedObjectKey} from '../storage/object-locator.js';
export interface SavedExtraction {
  response:ExtractionResponse; content:string; contentHash:string; artifactUri:string; canonicalUri:string; manifestUri:string;
  requestId:string; fingerprint:string;
  configHash:string;
}
export class ManagedExtractionError extends Error {constructor(readonly code:string,readonly retryable=false){super(code);}}
function decode(value:string|null):ParseState|undefined{
  try{return decodeDocumentReference(value);}catch{throw new ManagedExtractionError('DOCUMENT_EXTRACTION_STATE_INVALID');}
}
export class ManagedDocumentExtractor {
  private readonly nodes:ProcessingNodes;
  private readonly callbacks:DocumentCallbacks;
  constructor(private readonly pool:pg.Pool,private readonly config:AppConfig,private readonly storage:StoragePort,
    private readonly fetchImpl:typeof fetch=fetch){this.nodes=new ProcessingNodes(pool,config);this.callbacks=new DocumentCallbacks(pool,config);}
  async close(){await this.nodes.close();}
  private async fence(tx:pg.PoolClient,a:Attempt){
    if(!(await tx.query(`SELECT id FROM tasks WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND state='running'
      AND lease_owner=$4 AND version=$5 AND attempt_no=$6 AND lease_until>clock_timestamp() FOR UPDATE`,
      [a.task.id,a.task.user_id,a.task.workspace_id,a.owner,a.version,a.attempt])).rowCount)throw new ManagedExtractionError('DOCUMENT_EXTRACTION_STALE_ATTEMPT');
  }
  private async state(a:Attempt){
    const row=(await this.pool.query<{external_reference:string|null}>('SELECT external_reference FROM tasks WHERE id=$1 AND user_id=$2 AND workspace_id=$3',
      [a.task.id,a.task.user_id,a.task.workspace_id])).rows[0];
    if(!row)throw new ManagedExtractionError('DOCUMENT_EXTRACTION_STALE_ATTEMPT');return decode(row.external_reference);
  }
  async pending(a:Attempt):Promise<boolean>{const state=await this.state(a);return state?.phase==='bound'||state?.phase==='job'||state?.phase==='cancelling';}
  private async saveState(tx:pg.PoolClient,a:Attempt,state:ParseState){
    const external=state.phase==='intent'?'unknown':['job','cancelling'].includes(state.phase)?'submitted':'none';
    await tx.query('UPDATE tasks SET external_state=$2,external_reference=$3 WHERE id=$1',
      [a.task.id,external,encodeDocumentReference(state)]);
  }
  private async setState(a:Attempt,state:ParseState){await transaction(this.pool,async tx=>{await this.fence(tx,a);await this.saveState(tx,a,state);});}
  private async cancellationRequested(tx:pg.PoolClient,a:Attempt){return Boolean((await tx.query('SELECT cancel_requested_at FROM tasks WHERE id=$1',[a.task.id])).rows[0]?.cancel_requested_at);}
  private async recordJob(a:Attempt,state:ParseState){
    await transaction(this.pool,async tx=>{
      const row=(await tx.query('SELECT external_reference FROM tasks WHERE id=$1 AND user_id=$2 AND workspace_id=$3 FOR UPDATE',[a.task.id,a.task.user_id,a.task.workspace_id])).rows[0];
      const intent=row?decode(row.external_reference):undefined;
      // A cancel/lease transition may race the accepted POST. Save only the ID of this exact durable intent;
      // this does not grant a stale worker permission to publish results or start another extraction.
      if(!intent||intent.requestId!==state.requestId||intent.fingerprint!==state.fingerprint||!['intent','job'].includes(intent.phase)
        ||(intent.jobId&&intent.jobId!==state.jobId))throw new ManagedExtractionError('DOCUMENT_EXTRACTION_STALE_ATTEMPT');
      await this.saveState(tx,a,state);
      await this.callbacks.bindJob(tx,state.requestId,state.jobId!);
    });
  }
  private async cancellation(a:Attempt,state:ParseState):Promise<'send'|'wait'|false>{
    return transaction(this.pool,async tx=>{
      const row=(await tx.query('SELECT cancel_requested_at,external_reference FROM tasks WHERE id=$1 AND user_id=$2 AND workspace_id=$3 FOR UPDATE',[a.task.id,a.task.user_id,a.task.workspace_id])).rows[0];
      if(!row?.cancel_requested_at&&!state.timedOut)return false;
      const current=decode(row.external_reference);if(current?.requestId!==state.requestId)throw new ManagedExtractionError('DOCUMENT_EXTRACTION_STATE_INVALID');
      if(current.phase==='cancelling')return 'wait';
      if(!state.jobId)return 'send';
      await this.saveState(tx,a,{...state,phase:'cancelling'});return 'send';
    });
  }
  private async settleCancellation(a:Attempt,state:ParseState,remoteState?:string){
    await transaction(this.pool,async tx=>{
      const row=(await tx.query('SELECT id,external_reference FROM tasks WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND cancel_requested_at IS NOT NULL FOR UPDATE',[a.task.id,a.task.user_id,a.task.workspace_id])).rows[0];
      if(!row||decode(row.external_reference)?.requestId!==state.requestId)throw new ManagedExtractionError('DOCUMENT_EXTRACTION_STALE_ATTEMPT');
      await this.saveState(tx,a,{...state,phase:'cancelled',...{remoteState}});
      const current=(await tx.query<TaskRow>('SELECT * FROM tasks WHERE id=$1',[a.task.id])).rows[0]!;
      await this.callbacks.consume(tx,state.requestId);
      await tx.query("UPDATE task_attempts SET state='abandoned',finished_at=now() WHERE task_id=$1 AND state='running'",[a.task.id]);
      await finalizeUnsuccessfulTaskTx(tx,current,{state:'cancelled',errorCode:state.timedOut?'DOCUMENT_EXTRACTION_TIMEOUT':'TASK_CANCELLED'});
    });
  }
  private async put(key:string,text:string|Uint8Array,mime:string){
    const bytes=Buffer.from(text),hash=createHash('sha256').update(bytes).digest('hex');
    try{const old=await this.storage.stat(key,mime);if(old.sha256!==hash)throw new ManagedExtractionError('DOCUMENT_EXTRACTION_ARTIFACT_CHANGED');return;}
    catch(error){if(error instanceof ManagedExtractionError)throw error;}
    const saved=await this.storage.put(key,Readable.from([bytes]),mime,bytes.byteLength);
    if(saved.sha256!==hash)throw new ManagedExtractionError('DOCUMENT_EXTRACTION_ARTIFACT_CHANGED');
  }
  async acknowledgeCompleted(a:Attempt){
    const state=await this.state(a);if(state?.phase!=='complete')return;
    try{await this.nodes.acknowledgeSettled({requestId:state.requestId,fingerprint:state.fingerprint});}
    catch(error){if(!(error instanceof ParserMachineError&&['DOCUMENT_PARSER_LEASE_LOST','DOCUMENT_PARSER_NOT_UNCERTAIN'].includes(error.code)))throw error;}
  }
  private async rejectBoundSource(a:Attempt,state:ParseState,error:DocumentPreparationError):Promise<never>{
    const cancelled=await transaction(this.pool,async tx=>{
      await this.fence(tx,a);
      const current=decode((await tx.query('SELECT external_reference FROM tasks WHERE id=$1',[a.task.id])).rows[0]?.external_reference);
      if(current?.phase!=='bound'||current.requestId!==state.requestId||current.fingerprint!==state.fingerprint)
        throw new ManagedExtractionError('DOCUMENT_EXTRACTION_STALE_ATTEMPT');
      // Keep the task locked through settlement: no other attempt may advance this
      // known-unsubmitted receipt to intent while its admission is being released.
      try{await this.nodes.acknowledgeSettled({requestId:state.requestId,fingerprint:state.fingerprint},tx);}
      catch(cause){if(!(cause instanceof DomainError&&cause.code==='PROCESSING_ASSIGNMENT_MISSING'))throw cause;}
      await this.saveState(tx,a,{...state,phase:'failed'});
      await this.callbacks.consume(tx,state.requestId);
      return this.cancellationRequested(tx,a);
    });
    if(cancelled){await this.settleCancellation(a,state);throw new ManagedExtractionError('DOCUMENT_EXTRACTION_CANCELLED');}
    throw new ManagedExtractionError(error.code,error.retryable);
  }
  /** Persistent resource identity owns the source; a stored signed URL is only its locator. */
  private async submissionSource(a:Attempt,source:DocumentSource,snapshot:DocumentParserSnapshot):Promise<DocumentSource>{
    const key=ownedObjectKey(source.url,this.config);
    if(key===undefined)return source;
    if(key!==snapshot.sourceResourceId)throw new ManagedExtractionError('DOCUMENT_SOURCE_RESOURCE_MISMATCH');
    const row=(await this.pool.query<{file_name:string;mime_type:string;object_key:string;object_version:string;storage_driver:string;storage_bucket:string}>(`SELECT r.file_name,r.mime_type,r.object_key,r.object_version,r.storage_driver,r.storage_bucket
      FROM resources r JOIN workspaces w ON w.id=$3 AND w.user_id=r.user_id AND w.state='ready'
      WHERE r.resource_id=$1 AND r.user_id=$2 AND r.status='ready'`,[snapshot.sourceResourceId,a.task.user_id,a.task.workspace_id])).rows[0];
    if(!row||row.object_key!==key||row.storage_driver!=='aliyun-oss'||row.storage_bucket!==this.config.storageAliyunOss?.bucket||!this.storage.signUrl)
      throw new ManagedExtractionError('DOCUMENT_SOURCE_RESOURCE_UNAVAILABLE');
    const version=row.object_version.startsWith('oss-version:')?row.object_version.slice('oss-version:'.length):null;
    const versions=new URL(source.url).searchParams.getAll('versionId');
    if(version?versions.length!==1||versions[0]!==version:versions.length!==0)throw new ManagedExtractionError('DOCUMENT_SOURCE_RESOURCE_MISMATCH');
    const url=await this.storage.signUrl(row.object_key,3600,{version:row.object_version});
    return {url,fileName:row.file_name,mimeType:row.mime_type};
  }
  async parse(a:Attempt,source:DocumentSource,snapshot:DocumentParserSnapshot,
    commit:(tx:pg.PoolClient,saved:SavedExtraction)=>Promise<void>):Promise<SavedExtraction>{
    const previous=await this.state(a),resume=previous?.phase==='job'||previous?.phase==='cancelling';
    if(previous?.phase==='intent')throw new ManagedExtractionError('DOCUMENT_EXTRACTION_SUBMISSION_UNKNOWN');
    const fingerprint=digest(canonical({sourceUrl:source.url,fileName:source.fileName,
      mime:source.mimeType,sourceResourceId:snapshot.sourceResourceId,parseRunId:snapshot.parseRunId}));
    if((resume||previous?.phase==='bound')&&previous!.fingerprint!==fingerprint)throw new ManagedExtractionError('DOCUMENT_EXTRACTION_SOURCE_CHANGED');
    if(!resume)try{validateSourceUri((await this.submissionSource(a,source,snapshot)).url,this.config);}
    catch(error){
      if(previous?.phase==='bound'&&error instanceof DocumentPreparationError)return this.rejectBoundSource(a,previous,error);
      throw error;
    }
    const state:ParseState=resume||previous?.phase==='bound'?previous!:{phase:'bound',requestId:`${a.task.id}:parse:${a.attempt}`,fingerprint,startedAt:Date.now(),...(previous?.phase==='failed'?{retryFrom:previous.requestId}:{})};
    // Persist admission identity before assignment/startup so redelivery cannot select a second machine.
    if(!resume&&previous?.phase!=='bound')await this.setState(a,state);
    let providerFailure:DocumentExtractionError|undefined;
    try{
      if(!resume&&state.startedAt&&Date.now()-state.startedAt>3600000){await this.nodes.acknowledgeSettled({requestId:state.requestId,fingerprint});throw new ManagedExtractionError('DOCUMENT_PARSER_STARTUP_TIMEOUT');}
      return await this.nodes.withNode('document',{requestId:state.requestId,fingerprint,resume,retryFrom:state.retryFrom,recoverAdmission:previous?.phase==='bound',admissionSignal:a.signal,step:true},async(context,node)=>{
        const extraction=nodeDocumentConfig(node);
        const contexts=[{source_resource_id:snapshot.sourceResourceId,parse_run_id:snapshot.parseRunId}];
        const prepared=await transaction(this.pool,async tx=>{await this.fence(tx,a);return this.callbacks.prepare(tx,{requestId:state.requestId,fingerprint,taskId:a.task.id,contexts,timeoutMs:extraction.timeoutMs,maxResponseBytes:extraction.maxResponseBytes});});
        let response:ExtractionResponse;
        try{
          const inbox=await this.callbacks.forRequest(state.requestId);
          if(inbox?.terminal_state){
            if(inbox.job_id!==state.jobId)throw new DocumentExtractionError('DOCUMENT_CALLBACK_JOB_CONFLICT','unknown');
            if(state.timedOut||await transaction(this.pool,tx=>this.cancellationRequested(tx,a)))throw new DocumentExtractionError('DOCUMENT_EXTRACTION_CANCELLED','settled',false,undefined,inbox.terminal_state);
            if(inbox.terminal_state!=='completed')throw new DocumentExtractionError('DOCUMENT_EXTRACTION_FAILED','settled',inbox.terminal_state==='failed');
            if(!inbox.result)throw new DocumentExtractionError('DOCUMENT_CALLBACK_RESULT_MISSING','unknown');
            response=inbox.result;
          }else{
          if(inbox&&inbox.deadline_at.getTime()<Date.now()){
            state.timedOut=true;await transaction(this.pool,async tx=>{await this.fence(tx,a);await tx.query('UPDATE tasks SET cancel_requested_at=coalesce(cancel_requested_at,now()) WHERE id=$1',[a.task.id]);await this.saveState(tx,a,state);});
          }
          const requestSource=resume?source:await this.submissionSource(a,source,snapshot);
          response=await new DocumentExtractionClient(extraction,this.fetchImpl).extract([{
            ...requestSource,
            source_resource_id:snapshot.sourceResourceId,parse_run_id:snapshot.parseRunId,
          }],context,{
            beforeSubmit:async()=>{await transaction(this.pool,async tx=>{
              await this.fence(tx,a);
              const row=(await tx.query('SELECT external_reference FROM tasks WHERE id=$1',[a.task.id])).rows[0];
              const current=decode(row?.external_reference);
              if(current?.phase!=='bound'||current.requestId!==state.requestId||current.fingerprint!==state.fingerprint)
                throw new DocumentExtractionError('DOCUMENT_EXTRACTION_SUBMISSION_UNKNOWN','unknown');
              if(await this.cancellationRequested(tx,a))throw new DocumentExtractionError('DOCUMENT_EXTRACTION_CANCELLED','settled');
              // Startup/queueing can outlast a signed URL. Recheck before recording
              // intent so an expired source never becomes an ambiguous submission.
              try{validateSourceUri(requestSource.url,this.config);}
              catch(error){if(error instanceof DocumentPreparationError)throw new DocumentExtractionError(error.code,'settled',error.retryable);throw error;}
              state.phase='intent';await this.saveState(tx,a,state);
            });},
            submitted:async jobId=>{state.phase='job';state.jobId=jobId;await this.recordJob(a,state);},
            cancellation:()=>this.cancellation(a,state),
            callbackUrl:prepared.url,singleStep:true,
            received:async(jobId,result)=>{const token=new URL(prepared.url).pathname.split('/').at(-1)!;await this.callbacks.receive(prepared.row.id,token,{event:'extraction.completed',event_id:digest(jobId),job_id:jobId,state:'completed',result});},
          },resume?state.jobId:undefined);
          }
          if(await this.cancellation(a,state))throw new DocumentExtractionError('DOCUMENT_EXTRACTION_CANCELLED','settled',false,undefined,'completed');
          if(response.summary.errors||response.results.length!==1)throw new DocumentExtractionError('DOCUMENT_EXTRACTION_FAILED','settled',true);
          if(Buffer.byteLength(response.results[0]!.content)>DOCUMENT_CANONICAL_MAX_BYTES)throw new DocumentExtractionError('DOCUMENT_EXTRACTION_CONTENT_TOO_LARGE','settled');
        }catch(error){if(error instanceof DocumentExtractionError)providerFailure=error;throw error;}
        const content=response.results[0]!.content,contentHash=digest(content),raw=JSON.stringify(response),rawHash=digest(raw);
        const prefix=`extractions/${snapshot.sourceResourceId}/${snapshot.parseRunId}`;
        const canonicalUri=`${prefix}/${contentHash}.md`,artifactUri=`${prefix}/${rawHash}.json.gz`,manifestUri=`${prefix}/${rawHash}.assets.json`;
        await this.put(canonicalUri,content,'text/markdown');await this.put(artifactUri,await promisify(gzip)(Buffer.from(raw)),'application/gzip');
        await this.put(manifestUri,JSON.stringify((response.results[0] as ExtractionDocument).kb.uploaded_resources),'application/json');
        const saved:SavedExtraction={response,content,contentHash,canonicalUri,artifactUri,manifestUri,requestId:state.requestId,fingerprint,configHash:extraction.configHash};
        await transaction(this.pool,async tx=>{
          await this.fence(tx,a);await commit(tx,saved);
          await this.saveState(tx,a,{...state,phase:'complete',canonicalUri,artifactUri,manifestUri});
          await this.callbacks.consume(tx,state.requestId);
        });
        return saved;
      });
    }catch(error){
      if(error instanceof ParserExecutionDeferred)throw error;
      if(providerFailure?.outcome==='settled'){
        if(providerFailure.code==='DOCUMENT_EXTRACTION_CANCELLED')await this.settleCancellation(a,state,providerFailure.terminalState);
        else await transaction(this.pool,async tx=>{await this.fence(tx,a);await this.saveState(tx,a,{...state,phase:'failed'});await this.callbacks.consume(tx,state.requestId);});
        throw new ManagedExtractionError(providerFailure.code,providerFailure.retryable);
      }
      if(error instanceof ManagedExtractionError)throw error;
      if(error instanceof DomainError)throw new ManagedExtractionError(error.code,error.statusCode===503);
      if(error instanceof ParserMachineError)throw new ManagedExtractionError(error.code,!['DOCUMENT_PARSER_DUPLICATE','DOCUMENT_PARSER_CONFLICT'].includes(error.code));
      throw new ManagedExtractionError('DOCUMENT_EXTRACTION_UNKNOWN',true);
    }
  }
}
