import type pg from 'pg';
import type {AppConfig} from '../../config/config.js';
import type {Attempt} from '../tasks/engine.js';
import {transaction} from '../identity/store.js';
import {DocumentPreparationError,sourceMetadataFromUrl} from '../rag/document-preparation.js';
import type {FileProcessingSnapshot} from '../rag/processing-profile.js';
import {KnowledgeIndexJobs,type KbDependencies} from '../kb/jobs.js';
import {TextIngestionSourceType} from './types.js';
import {assertTextEncoding} from './policy.js';
import {ManagedDocumentExtractor,ManagedExtractionError} from '../ingestion/document-extraction.js';
import {storageFor} from '../storage/port.js';
import {ParserExecutionDeferred} from '../../lib/document-parser-machine/index.js';
export class TextIngestionError extends Error{constructor(readonly code:string,readonly retryable=false){super(code);}}
interface TextIngestionJobRow{id:string;workspace_id:string;created_by:string;source_type:TextIngestionSourceType;raw_content:string|null;origin_resource_uri:string|null;current_task_id:string;content_hash:string|null;artifact_uri:string|null;}
export class TextIngestionJobs {
 private readonly extractor:ManagedDocumentExtractor;
 constructor(readonly pool:pg.Pool,readonly config:AppConfig,readonly dependencies:KbDependencies={}){this.extractor=new ManagedDocumentExtractor(pool,config,storageFor(config));}
 async close():Promise<void>{await this.extractor.close();}
 private async current(tx:pg.PoolClient,id:string,a:Attempt){
  const row=(await tx.query<TextIngestionJobRow>(`SELECT j.* FROM text_ingestion_jobs j JOIN workspaces w ON w.id=j.workspace_id AND w.user_id=j.created_by AND w.state='ready'
   JOIN tasks t ON t.id=j.current_task_id WHERE j.id=$1 AND j.created_by=$2 AND j.workspace_id=$3 AND t.id=$4
   AND t.state='running' AND t.lease_owner=$5 AND t.version=$6 AND t.attempt_no=$7 AND t.lease_until>clock_timestamp() FOR UPDATE OF j,t`,[id,a.task.user_id,a.task.workspace_id,a.task.id,a.owner,a.version,a.attempt])).rows[0];
  if(!row)throw new TextIngestionError('TEXT_INGESTION_STALE_ATTEMPT');return row;
 }
 async execute(a:Attempt){
  const input=(await this.pool.query('SELECT body FROM task_inputs WHERE id=$1 AND user_id=$2 AND workspace_id=$3',[a.task.input_id,a.task.user_id,a.task.workspace_id])).rows[0];if(!input)throw new TextIngestionError('TEXT_INGESTION_INPUT_MISSING');
  const {jobId,snapshot}=JSON.parse(String(input.body)) as {jobId:string;snapshot:FileProcessingSnapshot};
  if(snapshot?.keyword?.mode!=='keyword')throw new TextIngestionError('TEXT_INGESTION_SNAPSHOT_INVALID');
  try{
   let job=await transaction(this.pool,tx=>this.current(tx,jobId,a));
   if(job.raw_content===null){
    await transaction(this.pool,async tx=>{await this.current(tx,jobId,a);await tx.query("UPDATE text_ingestion_jobs SET ingest_status='parsing' WHERE id=$1",[jobId]);});
    if(job.source_type!==TextIngestionSourceType.FILE_UPLOAD)throw new TextIngestionError('TEXT_SOURCE_ADAPTER_UNAVAILABLE');
    if(!snapshot.parser)throw new TextIngestionError('DOCUMENT_EXTRACTION_SNAPSHOT_INVALID');
    const saved=await this.extractor.parse(a,sourceMetadataFromUrl(job.origin_resource_uri!),snapshot.parser,async(tx,result)=>{
      await this.current(tx,jobId,a);
      await tx.query("UPDATE text_ingestion_jobs SET raw_content=$2,content_hash=$3,artifact_uri=$4,ingest_status='chunking' WHERE id=$1",[jobId,result.content,result.contentHash,result.canonicalUri]);
    });
    assertTextEncoding(saved.content);if(!saved.content.trim())throw new TextIngestionError('TEXT_INGESTION_CONTENT_EMPTY');
    job=await transaction(this.pool,tx=>this.current(tx,jobId,a));
   }
   await this.extractor.acknowledgeCompleted(a);
   await transaction(this.pool,async tx=>{await this.current(tx,jobId,a);await tx.query("UPDATE text_ingestion_jobs SET ingest_status='chunking' WHERE id=$1",[jobId]);});
   const result=await new KnowledgeIndexJobs(this.pool,this.config,this.dependencies).indexSource({type:'text',id:job.id,revision:job.content_hash!,userId:job.created_by,workspaceId:job.workspace_id,content:job.raw_content!,format:snapshot.format},a,snapshot.keyword);
   await transaction(this.pool,async tx=>{await this.current(tx,jobId,a);await tx.query("UPDATE text_ingestion_jobs SET ingest_status='success',error_msg=NULL,updated_at=now() WHERE id=$1",[jobId]);});return result;
  }catch(e){if(e instanceof ParserExecutionDeferred)throw e;await this.pool.query("UPDATE text_ingestion_jobs SET ingest_status='failed',error_msg=$3 WHERE id=$1 AND current_task_id=$2",[jobId,a.task.id,e instanceof TextIngestionError||e instanceof ManagedExtractionError||e instanceof DocumentPreparationError?e.code:'TEXT_INGESTION_FAILED']);throw e;}
 }
}
