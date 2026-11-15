import type pg from 'pg';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {AppConfig} from '../../config/config.js';
import {canonical,digest,seal,unseal} from '../../lib/crypto.js';
import {validateExtractionResponse,type ExtractionResponse,type FileContext} from '../../integrations/document-extraction.js';
import {DomainError,transaction} from '../identity/store.js';
import {enqueueIntent,event,parserRequestId} from '../tasks/model.js';
import {decodeDocumentReference,encodeDocumentReference} from './document-reference.js';

export interface CallbackInbox {
 id:string;request_id:string;task_id:string;job_id:string|null;
 contexts:FileContext[];terminal_state:'completed'|'failed'|'cancelled'|null;
 result:ExtractionResponse|null;result_hash:string|null;consumed:boolean;deadline_at:Date;
 max_response_bytes:number;token_hash:string;token_sealed:string;
 fingerprint:string;
}
/** The callback token is per submission. Only a hash and encrypted retry copy are persisted. */
export class DocumentCallbacks {
 constructor(private readonly pool:pg.Pool,private readonly config:AppConfig){}
 async prepare(tx:pg.PoolClient,input:{requestId:string;fingerprint:string;taskId:string;contexts:FileContext[];timeoutMs:number;maxResponseBytes:number}){
  const baseUrl=this.config.apiServiceBaseUrl;
  if(!baseUrl)throw new DomainError(503,'API_SERVICE_ADDRESS_REQUIRED');
  let row=(await tx.query<CallbackInbox>('SELECT * FROM document_parse_callbacks WHERE request_id=$1',[input.requestId])).rows[0];
  const secret=this.config.appTokenSecret;
  if(!secret)throw new DomainError(503,'DOCUMENT_CALLBACK_SECRET_UNAVAILABLE');
  if(!row){
   const token=randomBytes(32).toString('base64url');
   row=(await tx.query<CallbackInbox>(`INSERT INTO document_parse_callbacks(id,request_id,task_id,token_hash,token_sealed,contexts,max_response_bytes,deadline_at,fingerprint)
    VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8*interval '1 millisecond',$9) RETURNING *`,
    [randomUUID(),input.requestId,input.taskId,digest(token),seal(token,secret),JSON.stringify(input.contexts),input.maxResponseBytes,input.timeoutMs,input.fingerprint])).rows[0]!;
  }
  if(row.task_id!==input.taskId||row.fingerprint!==input.fingerprint||canonical(row.contexts)!==canonical(input.contexts))throw new DomainError(409,'DOCUMENT_CALLBACK_CONTEXT_CONFLICT');
  const token=unseal<string>(row.token_sealed,secret);
  return {row,url:new URL(`api/v1/document-parser/callbacks/${row.id}/${token}`,baseUrl+'/').href};
 }
 async forRequest(requestId:string){return (await this.pool.query<CallbackInbox>('SELECT * FROM document_parse_callbacks WHERE request_id=$1',[requestId])).rows[0];}
 async bindJob(tx:pg.PoolClient,requestId:string,jobId:string){
  const row=(await tx.query<CallbackInbox>('SELECT * FROM document_parse_callbacks WHERE request_id=$1 FOR UPDATE',[requestId])).rows[0];
  if(!row||(row.job_id&&row.job_id!==jobId))throw new DomainError(409,'DOCUMENT_CALLBACK_JOB_CONFLICT');
  await tx.query('UPDATE document_parse_callbacks SET job_id=$2 WHERE id=$1',[row.id,jobId]);
 }
 async authorize(id:string,token:string){
  const row=(await this.pool.query<CallbackInbox>('SELECT * FROM document_parse_callbacks WHERE id=$1',[id])).rows[0];
  if(!row||row.token_hash.length!==64||!/^[A-Za-z0-9_-]{43}$/.test(token)||!timingSafeEqual(Buffer.from(row.token_hash),Buffer.from(digest(token))))throw new DomainError(404,'DOCUMENT_CALLBACK_NOT_FOUND');
  return row;
 }
 async receive(id:string,token:string,body:unknown){
  const initial=await this.authorize(id,token),b=body as Record<string,unknown>;
  if(!b||typeof b!=='object'||Array.isArray(b)||typeof b.job_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(b.job_id)
   ||typeof b.event_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(b.event_id)||!['completed','failed','cancelled'].includes(String(b.state))
   ||b.event!==`extraction.${String(b.state)}`)throw new DomainError(400,'DOCUMENT_CALLBACK_INVALID');
  if(Buffer.byteLength(JSON.stringify(body))>initial.max_response_bytes)throw new DomainError(413,'DOCUMENT_CALLBACK_TOO_LARGE');
  let result:ExtractionResponse|null=null;
  if(b.state==='completed'){
   try{result=validateExtractionResponse(b.result,initial.contexts);}catch{throw new DomainError(400,'DOCUMENT_CALLBACK_RESULT_INVALID');}
  }
  const jobId=b.job_id,resultHash=digest(canonical({job:b.job_id,state:b.state,result,error:b.error??null}));
  const received=await transaction(this.pool,async tx=>{
   // Task before inbox is the shared lock order with admission/defer/cancellation.
   const task=initial.task_id?(await tx.query('SELECT kind,state,external_reference,lease_until IS NULL OR lease_until<clock_timestamp() AS lease_expired FROM tasks WHERE id=$1 FOR UPDATE',[initial.task_id])).rows[0]:undefined;
   const row=(await tx.query<CallbackInbox>('SELECT * FROM document_parse_callbacks WHERE id=$1 FOR UPDATE',[id])).rows[0]!;
   if(row.job_id&&row.job_id!==b.job_id)throw new DomainError(409,'DOCUMENT_CALLBACK_JOB_CONFLICT');
   const duplicate=Boolean(row.result_hash);
   if(duplicate&&row.result_hash!==resultHash)throw new DomainError(409,'DOCUMENT_CALLBACK_EVENT_CONFLICT');
   let rebound=false;
   if(task&&['rag.document-ingest','text.ingest'].includes(task.kind)&&['running','waiting_external','reconciling','cancel_requested'].includes(task.state)){
    let reference;
    try{reference=decodeDocumentReference(task.external_reference);}catch{throw new DomainError(409,'DOCUMENT_CALLBACK_CONTEXT_CONFLICT');}
    // The authenticated inbox belongs to one immutable submission. A late callback
    // may be retained, but must never bind a different attempt or source fingerprint.
    if(reference?.requestId===row.request_id){
     if(reference.fingerprint!==row.fingerprint)throw new DomainError(409,'DOCUMENT_CALLBACK_CONTEXT_CONFLICT');
     if(reference.jobId&&reference.jobId!==b.job_id)throw new DomainError(409,'DOCUMENT_CALLBACK_JOB_CONFLICT');
     if(reference.phase==='intent'&&!row.consumed){
      task.external_reference=encodeDocumentReference({...reference,phase:'job',jobId});
      // Preserve the active attempt/version and any cancellation request. This is
      // an accepted-job receipt, not ownership of the task or permission to POST.
      await tx.query("UPDATE tasks SET external_state='submitted',external_reference=$2 WHERE id=$1",[initial.task_id,task.external_reference]);
      rebound=true;
     }
    }
   }
   if(!duplicate)await tx.query(`UPDATE document_parse_callbacks SET job_id=$2,event_id=$3,terminal_state=$4,result=$5,result_hash=$6,received_at=now() WHERE id=$1`,[id,b.job_id,b.event_id,b.state,result?JSON.stringify(result):null,resultHash]);
   if((!duplicate||rebound)&&task&&['waiting_external','reconciling','cancel_requested'].includes(task.state)&&task.lease_expired){
    if(parserRequestId(task.external_reference)===row.request_id){
     await tx.query("UPDATE tasks SET state='reconciling',available_at=now() WHERE id=$1",[initial.task_id]);
     await enqueueIntent(tx,initial.task_id!);await event(tx,initial.task_id!);
    }
   }
   // PostgreSQL notification is a wakeup only; the durable inbox remains authoritative after disconnects.
   await tx.query("SELECT pg_notify('document_parser_callbacks',$1)",[row.request_id]);
   return {accepted:true,duplicate};
  });
  return received;
 }
 async consume(tx:pg.PoolClient,requestId:string){await tx.query('UPDATE document_parse_callbacks SET consumed=true,result=NULL WHERE request_id=$1',[requestId]);}
}
