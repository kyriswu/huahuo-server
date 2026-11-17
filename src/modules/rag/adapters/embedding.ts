/* eslint-disable @typescript-eslint/no-explicit-any */
import { NOTE_EMBEDDING_MAX_BATCH_SIZE, NOTE_EMBEDDING_MAX_INPUT_TOKENS } from '../model-profile.js';
import { ServiceHttpClient, readJsonResponse } from '../../../integrations/http-client.js';
export class EmbeddingError extends Error {
  constructor(readonly code:string, message:string, readonly retryable=true, options?:{cause?:unknown}) { super(message,options); this.name='EmbeddingError'; }
}
export interface EmbeddingAttempt { attempt:number; durationMs:number; firstByteMs?:number; status?:number; succeeded:boolean; }
export interface EmbeddingRequestOptions { signal?:AbortSignal; textType?:'query'|'document'; onAttempt?: (attempt:EmbeddingAttempt)=>void; }
export interface EmbeddingClient { embed(texts:string[], options?:EmbeddingRequestOptions):Promise<number[][]>; model:string; dimensions:number; }
export interface EmbeddingOptions { baseUrl:string; apiKey:string; model:string; dimensions:number; timeoutMs:number; maxRetries:number; fetchImpl?:typeof fetch; }
function retryableStatus(status:number){return status===408||status===425||status===429||status>=500;}
function sleep(ms:number){return new Promise<void>(resolve=>setTimeout(resolve,ms));}
function vectors(data:unknown,count:number,dimensions:number):number[][]{
  if(!Array.isArray(data)||data.length!==count)throw new EmbeddingError('EMBEDDING_RESPONSE_INVALID',`Embedding count mismatch: expected ${count}`,false);
  const indexed=data.map((item:any)=>({index:item?.text_index,embedding:item?.embedding}));
  if(new Set(indexed.map(v=>v.index)).size!==count||indexed.some(v=>!Number.isInteger(v.index)||v.index<0||v.index>=count))throw new EmbeddingError('EMBEDDING_RESPONSE_INVALID','Embedding indexes are invalid',false);
  indexed.sort((a,b)=>a.index-b.index);
  const result=indexed.map((v,i)=>{if(!Array.isArray(v.embedding)||v.embedding.some((n:any)=>typeof n!=='number'||!Number.isFinite(n)))throw new EmbeddingError('EMBEDDING_RESPONSE_INVALID',`Embedding ${i} is not finite`,false);if(v.embedding.length!==dimensions)throw new EmbeddingError('EMBEDDING_DIMENSION_MISMATCH',`Expected ${dimensions} dimensions, got ${v.embedding.length}`,false);return v.embedding as number[];});
  return result;
}
/** Native DashScope API, shared by Beijing public and provisioned PrivateLink hosts. */
export class BailianEmbeddingClient implements EmbeddingClient {
  readonly model:string; readonly dimensions:number; private readonly http:ServiceHttpClient;
  constructor(private readonly options:EmbeddingOptions){this.model=options.model;this.dimensions=options.dimensions;this.http=new ServiceHttpClient({fetchImpl:options.fetchImpl,dependency:'embedding',operation:'embed'});if(!options.baseUrl||!options.apiKey||!options.model)throw new EmbeddingError('EMBEDDING_CONFIG_INVALID','Embedding provider configuration is incomplete',false);}
  async embed(texts:string[], requestOptions?:EmbeddingRequestOptions):Promise<number[][]>{
    if(!texts.length)return [];
    if(texts.some(t=>!t.trim()))throw new EmbeddingError('EMBEDDING_INPUT_INVALID','Embedding input contains empty text',false);
    if(texts.some(t=>Buffer.byteLength(t,'utf8')+16>NOTE_EMBEDDING_MAX_INPUT_TOKENS))throw new EmbeddingError('EMBEDDING_INPUT_INVALID','Embedding input exceeds conservative model input budget',false);
    const result:number[][]=[];
    for(let offset=0;offset<texts.length;offset+=NOTE_EMBEDDING_MAX_BATCH_SIZE){
      result.push(...await this.embedBatch(texts.slice(offset,offset+NOTE_EMBEDDING_MAX_BATCH_SIZE),requestOptions));
    }
    return result;
  }
  private async embedBatch(texts:string[],requestOptions?:EmbeddingRequestOptions):Promise<number[][]>{
    // Flash returns native 1024 dimensions. No truncation, projection or padding.
    const body={model:this.options.model,input:{texts},parameters:{text_type:requestOptions?.textType??'document'}};
    let last:unknown;
    for(let attempt=0;attempt<=this.options.maxRetries;attempt++){
      requestOptions?.signal?.throwIfAborted();
      const started=performance.now();
      const observation:EmbeddingAttempt={attempt,durationMs:0,succeeded:false};
      try{
        return await this.http.request(`${this.options.baseUrl.replace(/\/$/,'')}/services/embeddings/text-embedding/text-embedding`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${this.options.apiKey}`},body:JSON.stringify(body),signal:requestOptions?.signal},{timeoutMs:this.options.timeoutMs},async response=>{
          observation.status=response.status;observation.firstByteMs=performance.now()-started;
          if(!response.ok)throw new EmbeddingError('EMBEDDING_PROVIDER_UNAVAILABLE',`Embedding provider HTTP ${response.status}`,retryableStatus(response.status));
          let payload:unknown;
          try{payload=await readJsonResponse(response,8*1024*1024);}catch(error){if(error instanceof Error&&['AbortError','TimeoutError'].includes(error.name))throw error;throw new EmbeddingError('EMBEDDING_RESPONSE_INVALID','Embedding provider returned invalid JSON',false,{cause:error});}
          const result=vectors((payload as {output?:{embeddings?:unknown}}|null)?.output?.embeddings,texts.length,this.options.dimensions);
          observation.succeeded=true;
          return result;
        });
      }catch(error){
        last=error;
        if(requestOptions?.signal?.aborted)throw new EmbeddingError('EMBEDDING_PROVIDER_TIMEOUT','Embedding request cancelled',true,{cause:error});
        if(error instanceof EmbeddingError&&!error.retryable)throw error;
        if(attempt>=this.options.maxRetries)throw error instanceof EmbeddingError?error:new EmbeddingError(error instanceof Error&&['AbortError','TimeoutError'].includes(error.name)?'EMBEDDING_PROVIDER_TIMEOUT':'EMBEDDING_PROVIDER_UNAVAILABLE','Embedding request failed',true,{cause:error});
      }finally{
        observation.durationMs=performance.now()-started;
        try{requestOptions?.onAttempt?.({...observation});}catch{/* Diagnostics never change provider behavior. */}
      }
      await sleep(100*2**attempt);
    }
    throw new EmbeddingError('EMBEDDING_PROVIDER_UNAVAILABLE','Embedding request failed',true,{cause:last});
  }
}

export class DeterministicEmbeddingClient implements EmbeddingClient {
  readonly model='mock-embedding'; readonly dimensions:number; constructor(dimensions:number){this.dimensions=dimensions;}
  async embed(texts:string[]):Promise<number[][]>{return texts.map(text=>{const out:number[]=[];let seed=0;for(const c of text)seed=(seed*31+c.charCodeAt(0))>>>0;for(let i=0;i<this.dimensions;i++){seed=(1664525*seed+1013904223)>>>0;out.push((seed/0xffffffff)*2-1);}return out;});}
}
