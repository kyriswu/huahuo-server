import type {IndexItemResult,IndexOptions} from '../rag-indexing/index.js';
import type {KeywordPoint,KeywordIndex} from './types.js';
/** Model-free, bounded keyword writes. Business persistence is the caller's responsibility. */
export async function indexKeywordChunks(records:readonly KeywordPoint[],index:KeywordIndex,options:IndexOptions & {maxContentChars?:number}={}):Promise<IndexItemResult[]>{
 const batchSize=options.batchSize??32,concurrency=options.concurrency??2,timeout=options.timeoutMs??30000,retries=options.maxRetries??2;
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>512||!Number.isInteger(concurrency)||concurrency<1||concurrency>32||!Number.isInteger(timeout)||timeout<1||!Number.isInteger(retries)||retries<0||retries>5)throw new Error('KB_KEYWORD_OPTIONS_INVALID');
 if(new Set(records.map(r=>r.id)).size!==records.length)throw new Error('KB_KEYWORD_DUPLICATE_ID');
 if(options.maxContentChars!==undefined&&(!Number.isSafeInteger(options.maxContentChars)||options.maxContentChars<1))throw new Error('KB_KEYWORD_OPTIONS_INVALID');
 if(records.some(r=>!r.id||!r.content.trim()||options.maxContentChars!==undefined&&[...r.content].length>options.maxContentChars||r.embedding!==undefined))throw new Error('KB_KEYWORD_RECORD_INVALID');
 let cursor=0,stop=false;const results:IndexItemResult[]=new Array(records.length);
 const worker=async()=>{while(!stop&&cursor<records.length){const start=cursor;cursor+=batchSize;const batch=records.slice(start,start+batchSize);let attempts=0;
  try{for(;;){attempts++;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([index.upsert([...batch],{signal:controller.signal}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();stop=true;reject(Object.assign(new Error('KB_KEYWORD_TIMEOUT'),{retryable:true}));},timeout);})]);break;}
   catch(e){if(stop||attempts>retries||(e as {retryable?:boolean}).retryable===false)throw e;await new Promise(r=>setTimeout(r,Math.min(100*2**(attempts-1),1000)));}
   finally{clearTimeout(timer);}
  }
  for(const [i,row] of batch.entries())results[start+i]={id:row.id,ordinal:start+i,status:'indexed',stage:'upsert',attempts,retryable:false};
  }catch(e){for(const [i,row] of batch.entries())results[start+i]={id:row.id,ordinal:start+i,status:'failed',stage:'upsert',attempts,retryable:(e as {retryable?:boolean}).retryable!==false,errorCode:stop?'KB_KEYWORD_TIMEOUT':'KB_KEYWORD_WRITE_FAILED'};}
 }};
 await Promise.all(Array.from({length:Math.min(concurrency,Math.ceil(records.length/batchSize))},worker));
 return records.map((row,ordinal)=>results[ordinal]??{id:row.id,ordinal,status:'failed',stage:'upsert',attempts:0,retryable:true,errorCode:'KB_KEYWORD_NOT_SCHEDULED'});
}
