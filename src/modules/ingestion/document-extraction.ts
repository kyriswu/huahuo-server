import type pg from 'pg';
import { Readable } from 'node:stream';
import {createHash} from 'node:crypto';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import type { AppConfig } from '../../config/config.js';
import { canonical, digest } from '../../lib/crypto.js';
import { createDocumentParserMachine, ParserMachineError } from '../../lib/document-parser-machine/index.js';
import { DocumentExtractionClient, DocumentExtractionError, type ExtractionResponse,type ExtractionDocument } from '../../integrations/document-extraction.js';
import { transaction } from '../identity/store.js';
import {event} from '../tasks/model.js';
import type { Attempt } from '../tasks/engine.js';
import type { StoragePort } from '../storage/port.js';
import type { DownloadedSource } from '../rag/document-preparation.js';
import { verifyStructuredSource } from '../rag/document-preparation.js';
import type { DocumentParserSnapshot } from '../rag/processing-profile.js';

interface ParseState {
  phase:'intent'|'job'|'cancelling'|'cancelled'|'complete'|'failed'; requestId:string; fingerprint:string;
  jobId?:string; artifactUri?:string; canonicalUri?:string; manifestUri?:string;
  fileName?:string;mimeType?:string;
}
export interface SavedExtraction {
  response:ExtractionResponse; content:string; contentHash:string; artifactUri:string; canonicalUri:string; manifestUri:string;
  requestId:string; fingerprint:string;
}
export class ManagedExtractionError extends Error {constructor(readonly code:string,readonly retryable=false){super(code);}}
function decode(value:string|null):ParseState|undefined{
  if(!value?.startsWith('xberg-'))return;
  const match=/^xberg-(intent|job|cancelling|cancelled|complete|failed):([A-Za-z0-9_-]+)$/.exec(value);
  if(!match)throw new ManagedExtractionError('DOCUMENT_EXTRACTION_STATE_INVALID');
  try{
    const state=JSON.parse(Buffer.from(match[2]!,'base64url').toString()) as ParseState;
    if(state.phase!==match[1]||typeof state.requestId!=='string'||!/^[a-f0-9]{64}$/.test(state.fingerprint)
      ||(['job','cancelling'].includes(state.phase)&&(typeof state.jobId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(state.jobId))))throw new Error();
    return state;
  }catch{throw new ManagedExtractionError('DOCUMENT_EXTRACTION_STATE_INVALID');}
}
export class ManagedDocumentExtractor {
  private runtime?:ReturnType<typeof createDocumentParserMachine>;
  private connecting?:Promise<void>;
  constructor(private readonly pool:pg.Pool,private readonly config:AppConfig,private readonly storage:StoragePort,
    private readonly fetchImpl:typeof fetch=fetch){}
  private async module(){
    if(!this.config.documentParserMachine.enabled)throw new ManagedExtractionError('DOCUMENT_PARSER_DISABLED');
    this.runtime??=createDocumentParserMachine(this.config.documentParserMachine,this.config.redisQueueUrl,this.config.queuePrefix);
    this.connecting??=this.runtime!.connect();await this.connecting;return this.runtime!;
  }
  async close(){await this.runtime?.close();}
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
  async pending(a:Attempt):Promise<boolean>{const state=await this.state(a);return state?.phase==='job'||state?.phase==='cancelling';}
  private async saveState(tx:pg.PoolClient,a:Attempt,state:ParseState){
    const external=state.phase==='intent'?'unknown':['job','cancelling'].includes(state.phase)?'submitted':'none';
    await tx.query('UPDATE tasks SET external_state=$2,external_reference=$3 WHERE id=$1',
      [a.task.id,external,`xberg-${state.phase}:`+Buffer.from(JSON.stringify(state)).toString('base64url')]);
  }
  private async setState(a:Attempt,state:ParseState){await transaction(this.pool,async tx=>{await this.fence(tx,a);await this.saveState(tx,a,state);});}
  private async recordJob(a:Attempt,state:ParseState){
    await transaction(this.pool,async tx=>{
      const row=(await tx.query('SELECT external_reference FROM tasks WHERE id=$1 AND user_id=$2 AND workspace_id=$3 FOR UPDATE',[a.task.id,a.task.user_id,a.task.workspace_id])).rows[0];
      const intent=row?decode(row.external_reference):undefined;
      // A cancel/lease transition may race the accepted POST. Save only the ID of this exact durable intent;
      // this does not grant a stale worker permission to publish results or start another extraction.
      if(!intent||intent.requestId!==state.requestId||intent.fingerprint!==state.fingerprint||!['intent','job'].includes(intent.phase)
        ||(intent.jobId&&intent.jobId!==state.jobId))throw new ManagedExtractionError('DOCUMENT_EXTRACTION_STALE_ATTEMPT');
      await this.saveState(tx,a,state);
    });
  }
  private async cancellation(a:Attempt,state:ParseState):Promise<'send'|'wait'|false>{
    return transaction(this.pool,async tx=>{
      const row=(await tx.query('SELECT cancel_requested_at,external_reference FROM tasks WHERE id=$1 AND user_id=$2 AND workspace_id=$3 FOR UPDATE',[a.task.id,a.task.user_id,a.task.workspace_id])).rows[0];
      if(!row?.cancel_requested_at)return false;
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
      await tx.query("UPDATE tasks SET state='cancelled',version=version+1,lease_owner=NULL,lease_until=NULL,error_code='TASK_CANCELLED',retryable=false WHERE id=$1",[a.task.id]);
      await tx.query("UPDATE task_attempts SET state='abandoned',finished_at=now() WHERE task_id=$1 AND state='running'",[a.task.id]);await event(tx,a.task.id);
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
    const runtime=await this.module();
    try{await runtime.machine.acknowledgeSettled({requestId:state.requestId,fingerprint:state.fingerprint});}
    catch(error){if(!(error instanceof ParserMachineError&&['DOCUMENT_PARSER_LEASE_LOST','DOCUMENT_PARSER_NOT_UNCERTAIN'].includes(error.code)))throw error;}
  }
  async parse(a:Attempt,source:DownloadedSource,snapshot:DocumentParserSnapshot,
    commit:(tx:pg.PoolClient,saved:SavedExtraction)=>Promise<void>):Promise<SavedExtraction>{
    const previous=await this.state(a),resume=previous?.phase==='job'||previous?.phase==='cancelling';
    if(!resume)await verifyStructuredSource(source);
    if(previous?.phase==='intent')throw new ManagedExtractionError('DOCUMENT_EXTRACTION_SUBMISSION_UNKNOWN');
    const fingerprint=resume&&source.bytes.length===0?previous!.fingerprint:digest(canonical({sourceHash:createHash('sha256').update(source.bytes).digest('hex'),fileName:source.fileName,
      mime:source.contentType,sourceResourceId:snapshot.sourceResourceId,parseRunId:snapshot.parseRunId,config:snapshot.extraction.parameters}));
    if(resume&&previous.fingerprint!==fingerprint)throw new ManagedExtractionError('DOCUMENT_EXTRACTION_SOURCE_CHANGED');
    const state:ParseState=resume?previous!:{phase:'intent',requestId:`${a.task.id}:parse:${a.attempt}`,fingerprint,fileName:source.fileName,mimeType:source.contentType??'application/octet-stream'};
    const runtime=await this.module();let providerFailure:DocumentExtractionError|undefined;
    try{
      return await runtime.machine.withDocumentParser({requestId:state.requestId,fingerprint,resume,admissionSignal:a.signal},async context=>{
        let response:ExtractionResponse;
        try{
          response=await new DocumentExtractionClient(snapshot.extraction,this.fetchImpl).extract([{
            bytes:source.bytes,fileName:state.fileName??source.fileName,mimeType:state.mimeType??source.contentType??'application/octet-stream',
            source_resource_id:snapshot.sourceResourceId,parse_run_id:snapshot.parseRunId,
          }],context,{
            beforeSubmit:async()=>{await this.setState(a,state);},
            submitted:async jobId=>{state.phase='job';state.jobId=jobId;await this.recordJob(a,state);},
            cancellation:()=>this.cancellation(a,state),
          },resume?state.jobId:undefined);
          if(await this.cancellation(a,state))throw new DocumentExtractionError('DOCUMENT_EXTRACTION_CANCELLED','settled',false,undefined,'completed');
          if(response.summary.errors||response.results.length!==1)throw new DocumentExtractionError('DOCUMENT_EXTRACTION_FAILED','settled',true);
          if(Buffer.byteLength(response.results[0]!.content)>16*1024*1024)throw new DocumentExtractionError('DOCUMENT_EXTRACTION_CONTENT_TOO_LARGE','settled');
        }catch(error){if(error instanceof DocumentExtractionError)providerFailure=error;throw error;}
        const content=response.results[0]!.content,contentHash=digest(content),raw=JSON.stringify(response),rawHash=digest(raw);
        const prefix=`extractions/${snapshot.sourceResourceId}/${snapshot.parseRunId}`;
        const canonicalUri=`${prefix}/${contentHash}.md`,artifactUri=`${prefix}/${rawHash}.json.gz`,manifestUri=`${prefix}/${rawHash}.assets.json`;
        await this.put(canonicalUri,content,'text/markdown');await this.put(artifactUri,await promisify(gzip)(Buffer.from(raw)),'application/gzip');
        await this.put(manifestUri,JSON.stringify((response.results[0] as ExtractionDocument).kb.uploaded_resources),'application/json');
        const saved:SavedExtraction={response,content,contentHash,canonicalUri,artifactUri,manifestUri,requestId:state.requestId,fingerprint};
        await transaction(this.pool,async tx=>{
          await this.fence(tx,a);await commit(tx,saved);
          await this.saveState(tx,a,{...state,phase:'complete',canonicalUri,artifactUri,manifestUri});
        });
        return saved;
      });
    }catch(error){
      if(providerFailure?.outcome==='settled'){
        if(providerFailure.code==='DOCUMENT_EXTRACTION_CANCELLED')await this.settleCancellation(a,state,providerFailure.terminalState);
        else await this.setState(a,{...state,phase:'failed'});
        throw new ManagedExtractionError(providerFailure.code,providerFailure.retryable);
      }
      if(error instanceof ManagedExtractionError)throw error;
      if(error instanceof ParserMachineError)throw new ManagedExtractionError(error.code,!['DOCUMENT_PARSER_DUPLICATE','DOCUMENT_PARSER_CONFLICT'].includes(error.code));
      throw new ManagedExtractionError('DOCUMENT_EXTRACTION_UNKNOWN',true);
    }
  }
}
