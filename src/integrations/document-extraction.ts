import { setTimeout as sleep } from 'node:timers/promises';
import type { EnabledDocumentExtractionConfig } from '../config/document-extraction.js';
import { assertCompleteExtractionConfig } from '../config/document-extraction.js';
import type { ParserContext } from '../lib/document-parser-machine/index.js';
import { ServiceHttpClient, ServiceHttpError, readJsonResponse } from './http-client.js';
import { ParserExecutionError,ParserExecutionDeferred } from '../lib/document-parser-machine/index.js';
import {inputImages} from '../lib/markdown-images.js';

export interface FileContext { source_resource_id: string; parse_run_id: string }
export interface ExtractionFile { url: string; fileName: string; mimeType: string;source_resource_id?:string;parse_run_id?:string; }
export interface UploadedResource extends FileContext {
  resource_id: string; uuid: string; bucket: string; object_key: string; sha256: string; bytes: number;
  mime_type: string; etag: string; [key: string]: unknown;
}
export interface ExtractionDocument extends FileContext {
  content: string; content_format: 'kb-markdown-v1'; input_index: number; mime_type: string;
  images: Array<Record<string, unknown> & { resource_id: string; uuid: string }>;
  kb: Record<string, unknown> & { uploaded_resources: UploadedResource[] };
  [key: string]: unknown;
}
export interface ExtractionResponse {
  summary: { inputs: number; results: number; errors: number; [key: string]: unknown };
  results: Array<Record<string,unknown>&{content:string;input_index:number}>; errors: unknown[];
}
export class DocumentExtractionError extends ParserExecutionError {
  constructor(code: string, outcome: 'settled' | 'unknown', readonly retryable = false,readonly statusCode?:number,readonly terminalState?:string) { super(code, outcome); this.name = 'DocumentExtractionError'; }
}
export const validUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function imageReferences(content:string):string[]{
  try{
    const images=inputImages(content);
    if(images.some(image=>image.kind!=='kbimage'))protocol();
    return images.map(image=>image.url.slice('asset://'.length));
  }catch{protocol();}
}
function protocol():never { throw new DocumentExtractionError('DOCUMENT_EXTRACTION_RESPONSE_INVALID', 'settled'); }
export function validateExtractionResponse(value: unknown, contexts: readonly (FileContext|null)[]): ExtractionResponse {
  const body = object(value), summary = object(body.summary);
  if (!Array.isArray(body.errors) || !Array.isArray(body.results) || summary.inputs !== contexts.length) protocol();
  if (summary.results !== body.results.length || summary.errors!==body.errors.length) protocol();
  const covered=new Set<number>();
  for(const rawError of body.errors){const error=object(rawError);if(typeof error.index!=='number'||!Number.isInteger(error.index)||error.index<0||error.index>=contexts.length)protocol();covered.add(error.index);}
  body.results.forEach((raw: unknown) => {
    const doc = object(raw),i=doc.input_index;
    if(typeof i!=='number'||!Number.isInteger(i)||i<0||i>=contexts.length||covered.has(i)||typeof doc.content!=='string')protocol();
    covered.add(i);const context=contexts[i]!;
    if(context===null)return; // Independent image OCR keeps its existing response semantics.
    if (doc.source_resource_id !== context.source_resource_id || doc.parse_run_id !== context.parse_run_id
      || doc.content_format !== 'kb-markdown-v1' || typeof doc.content !== 'string' || !doc.content.trim() || !Array.isArray(doc.images)) protocol();
    const kb = object(doc.kb), receipts = kb.uploaded_resources;
    if (!Array.isArray(receipts)) protocol();
    const ids = new Map<string, UploadedResource>();
    for (const rawReceipt of receipts) {
      const r = object(rawReceipt);
      if (!validUuid(r.resource_id) || r.uuid !== r.resource_id || r.source_resource_id !== context.source_resource_id || r.parse_run_id !== context.parse_run_id
        || typeof r.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(r.sha256) || typeof r.bytes !== 'number' || !Number.isSafeInteger(r.bytes) || r.bytes <= 0
        || typeof r.mime_type !== 'string' || !r.mime_type.startsWith('image/') || typeof r.bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(r.bucket)
        || typeof r.object_key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/.test(r.object_key) || r.object_key.includes('..') || r.object_key.includes('//')
        || typeof r.etag !== 'string' || !r.etag) protocol();
      // Repeated page images can reuse one uploaded object. Require the same
      // ownership and storage receipt, while preserving per-occurrence metadata.
      const previous = ids.get(r.resource_id);
      if (previous && ['uuid','bucket','object_key','sha256','bytes','mime_type','etag','source_resource_id','parse_run_id'].some(key => previous[key] !== r[key])) protocol();
      ids.set(r.resource_id, r as UploadedResource);
    }
    for (const rawImage of doc.images) {
      const image = object(rawImage), receipt = typeof image.resource_id === 'string' ? ids.get(image.resource_id) : undefined;
      if (!receipt || image.uuid !== image.resource_id || image.sha256 !== receipt.sha256 || image.bytes !== receipt.bytes || image.mime_type !== receipt.mime_type) protocol();
      if (['data', 'base64', 'data_base64', 'bytes_array', 'path', 'file_path', 'local_path', 'container_path'].some(key => key in image)) protocol();
    }
    // Preserve Markdown/merged-table HTML and KB tags exactly; only verify image references.
    for (const id of imageReferences(doc.content)) if (!ids.has(id)) protocol();
    if (Array.isArray(kb.blocks)) for (const rawBlock of kb.blocks) {
      const block = object(rawBlock);
      if (block.source_resource_id !== context.source_resource_id || block.parse_run_id !== context.parse_run_id) protocol();
      if (block.resource_id !== null && block.resource_id !== undefined && (typeof block.resource_id !== 'string' || !ids.has(block.resource_id))) protocol();
    }
  });
  if(covered.size!==contexts.length)protocol();
  return value as ExtractionResponse;
}

export class DocumentExtractionClient {
  private readonly http:ServiceHttpClient;
  constructor(readonly config: EnabledDocumentExtractionConfig, fetchImpl: typeof fetch = fetch) {
    this.http=new ServiceHttpClient({fetchImpl,dependency:'document_parser'});
    if(config.parameters!==null)assertCompleteExtractionConfig(config.parameters);
  }
  private url(baseUrl: string, path: string): URL { return new URL(baseUrl.replace(/\/$/, '') + path); }
  private async request(url: URL, init: RequestInit, signal: AbortSignal, submitting: boolean, allowPending = false): Promise<{status:number;body:unknown}> {
    let headersReceived=false;
    try {
      const operation=init.method==='DELETE'?'cancel':url.pathname.endsWith('/ack')?'ack':url.pathname.endsWith('/extract-async')?'submit':url.pathname.endsWith('/extract')?'extract':url.pathname.endsWith('/result')?'job_result':'job_status';
      return await this.http.request(url,{...init,signal},{timeoutMs:this.config.timeoutMs,operation},async response=>{
        headersReceived=true;
        if (response.status !== 200 && !((submitting && this.config.mode==='async' || allowPending) && response.status === 202)) {
          const settled = submitting && response.status >= 400 && response.status < 500 && response.status !== 408;
          throw new DocumentExtractionError('DOCUMENT_EXTRACTION_HTTP_FAILED', settled ? 'settled' : 'unknown', response.status >= 500 || response.status === 429,response.status);
        }
        try { return {status:response.status,body:await readJsonResponse(response,this.config.maxResponseBytes)}; }
        catch(error) {
          if(error instanceof ServiceHttpError&&error.code==='HTTP_RESPONSE_TOO_LARGE')throw new DocumentExtractionError('DOCUMENT_EXTRACTION_RESPONSE_TOO_LARGE','unknown');
          if(error instanceof ServiceHttpError&&error.code==='HTTP_RESPONSE_EMPTY')throw new DocumentExtractionError('DOCUMENT_EXTRACTION_EMPTY_RESPONSE','unknown');
          throw new DocumentExtractionError('DOCUMENT_EXTRACTION_RESPONSE_UNREADABLE','unknown');
        }
      });
    } catch(error) {
      if(error instanceof DocumentExtractionError)throw error;
      throw new DocumentExtractionError(headersReceived?'DOCUMENT_EXTRACTION_RESPONSE_UNREADABLE':'DOCUMENT_EXTRACTION_TRANSPORT_UNKNOWN','unknown',!headersReceived);
    }
  }

  async extract(files: readonly ExtractionFile[], context: ParserContext, hooks: { beforeSubmit: () => Promise<void>; submitted: (jobId: string) => Promise<void>;cancellation?:()=>Promise<'send'|'wait'|false>;callbackUrl?:string;singleStep?:boolean;received?:(jobId:string,response:ExtractionResponse)=>Promise<void> }, resumeJobId?: string): Promise<ExtractionResponse> {
    if (!files.length || files.length > 16) throw new DocumentExtractionError('DOCUMENT_EXTRACTION_INPUT_INVALID', 'settled');
    const contexts:Array<FileContext|null>=[];
    for (const file of files) {
      const independent=file.mimeType.startsWith('image/')&&file.source_resource_id===undefined&&file.parse_run_id===undefined;
      if ((!independent&&(!validUuid(file.source_resource_id)||!validUuid(file.parse_run_id))) || !file.fileName || file.fileName.length > 255 || /[\0\r\n/\\]/.test(file.fileName)) throw new DocumentExtractionError('DOCUMENT_EXTRACTION_INPUT_INVALID', 'settled');
      if (!resumeJobId) {
        let source: URL;
        try { source = new URL(file.url); } catch { throw new DocumentExtractionError('DOCUMENT_EXTRACTION_INPUT_INVALID', 'settled'); }
        if (!['https:', 'http:'].includes(source.protocol) || source.username || source.password || source.hash || file.url.length > 4096)
          throw new DocumentExtractionError('DOCUMENT_EXTRACTION_INPUT_INVALID', 'settled');
      }
      contexts.push(independent?null:{source_resource_id:file.source_resource_id!.toLowerCase(),parse_run_id:file.parse_run_id!.toLowerCase()});
    }
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(this.config.timeoutMs)]);
    let jobId = resumeJobId;
    if (!jobId) {
      const payload = {
        inputs: files.map(file => ({ kind: 'uri', uri: file.url, mime_type: file.mimeType })),
        file_contexts: contexts,
        ...(this.config.parameters === null ? {} : { config: this.config.parameters }),
        ...(hooks.callbackUrl ? { callback_url: hooks.callbackUrl } : {}),
      };
      const headers = new Headers(context.headers);
      headers.set('Content-Type', 'application/json');
      try{await hooks.beforeSubmit();}catch(error){if(error instanceof DocumentExtractionError)throw error;throw new DocumentExtractionError('DOCUMENT_EXTRACTION_PRE_SUBMISSION_FAILED','settled',true);}
      const response = await this.request(this.url(context.baseUrl, this.config.mode === 'sync' ? '/extract' : '/extract-async'), { method: 'POST', headers, body: JSON.stringify(payload) }, signal, true);
      if (this.config.mode === 'sync') return validateExtractionResponse(response.body, contexts);
      const id = object(response.body).job_id;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new DocumentExtractionError('DOCUMENT_EXTRACTION_JOB_ID_UNKNOWN', 'unknown');
      jobId = id; await hooks.submitted(id);
      if(hooks.singleStep)throw new ParserExecutionDeferred('external');
    }
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId)) throw new DocumentExtractionError('DOCUMENT_EXTRACTION_JOB_ID_INVALID', 'unknown');
    let cancelling=false;
    while (true) {
      const cancellation=await hooks.cancellation?.();
      if(cancellation){
        const first=!cancelling;
        cancelling=true;
        if(cancellation==='send'&&first)try{await this.cancel(jobId,context);}catch(error){if(!(error instanceof DocumentExtractionError&&error.statusCode===409))throw error;}
      }
      const job = object((await this.request(this.url(context.baseUrl, `/jobs/${jobId}`), { method: 'GET', headers: context.headers }, signal, false)).body);
      if (job.job_id !== jobId) throw new DocumentExtractionError('DOCUMENT_EXTRACTION_JOB_MISMATCH', 'unknown');
      if(cancelling&&['completed','failed','cancelled'].includes(String(job.state))){
        await this.ack(jobId,context);
        throw new DocumentExtractionError('DOCUMENT_EXTRACTION_CANCELLED','settled',false,undefined,String(job.state));
      }
      if (job.state === 'failed' || job.state === 'cancelled') {
        await this.ack(jobId,context);
        throw new DocumentExtractionError('DOCUMENT_EXTRACTION_FAILED', 'settled', job.state === 'failed');
      }
      if (job.state === 'completed') {
        if(job.result_state==='consumed')throw new DocumentExtractionError('DOCUMENT_EXTRACTION_RESULT_CONSUMED','settled',false,410);
        let received:{status:number;body:unknown};
        try{received=await this.request(this.url(context.baseUrl,`/jobs/${jobId}/result`),{method:'GET',headers:context.headers},signal,false,true);}
        catch(error){
          if(error instanceof DocumentExtractionError&&error.statusCode===410)throw new DocumentExtractionError('DOCUMENT_EXTRACTION_RESULT_CONSUMED','settled',false,410);
          throw error;
        }
        const terminal=object(received.body);
        if(terminal.job_id!==jobId)throw new DocumentExtractionError('DOCUMENT_EXTRACTION_JOB_MISMATCH','unknown');
        if(received.status===200){
          if(terminal.state!=='completed')throw new DocumentExtractionError('DOCUMENT_EXTRACTION_JOB_STATE_UNKNOWN','unknown');
          const result=validateExtractionResponse(terminal.result,contexts);
          await hooks.received?.(jobId,result);return result;
        }
        if(!['queued','pending','running'].includes(String(terminal.state)))throw new DocumentExtractionError('DOCUMENT_EXTRACTION_JOB_STATE_UNKNOWN','unknown');
      } else if (!['queued', 'pending', 'running'].includes(String(job.state))) throw new DocumentExtractionError('DOCUMENT_EXTRACTION_JOB_STATE_UNKNOWN', 'unknown');
      if(hooks.singleStep)throw new ParserExecutionDeferred('external');
      try { await sleep(this.config.pollMs, undefined, { signal }); }
      catch { throw new DocumentExtractionError('DOCUMENT_EXTRACTION_TRANSPORT_UNKNOWN', 'unknown', true); }
    }
  }
  async cancel(jobId:string,context:ParserContext):Promise<unknown>{
    if(!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId))throw new DocumentExtractionError('DOCUMENT_EXTRACTION_JOB_ID_INVALID','unknown');
    return (await this.request(this.url(context.baseUrl,`/jobs/${jobId}`),{method:'DELETE',headers:context.headers},AbortSignal.any([context.signal,AbortSignal.timeout(10000)]),false)).body;
  }
  /** Only for terminal work that was explicitly cancelled/failed; successful GET /result consumes itself. */
  async ack(jobId:string,context:ParserContext):Promise<void>{
    if(!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId))throw new DocumentExtractionError('DOCUMENT_EXTRACTION_JOB_ID_INVALID','unknown');
    await this.request(this.url(context.baseUrl,`/jobs/${jobId}/ack`),{method:'POST',headers:context.headers},AbortSignal.any([context.signal,AbortSignal.timeout(10000)]),false);
  }
}
