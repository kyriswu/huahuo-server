import type pg from 'pg';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import type {AppConfig} from '../../config/config.js';
import {DomainError,transaction} from '../identity/store.js';
import {applyValues,settings,validateValues,validateStoredValues,DEFAULT_DRAIN_TIMEOUT_MS,DRAIN_TIMEOUT_KEY,type Values,type Category} from './registry.js';
import {assertSuperadmin,type AdminScope} from '../admin/service.js';
const context=new AsyncLocalStorage<AppConfig>();
const bases=new WeakMap<AppConfig,AppConfig>();
const drainSnapshots=new WeakMap<AppConfig,{revision:number;timeoutMs:number}>();
const rememberDrainSnapshot=(base:AppConfig,values:Values,revision:number)=>{
 if(revision>=(drainSnapshots.get(base)?.revision??-1))drainSnapshots.set(base,{revision,timeoutMs:Number(values[DRAIN_TIMEOUT_KEY])});
};
export const currentRuntimeConfig=()=>context.getStore();
const dynamicKeys=new Set<PropertyKey>(['runtimeRevision','maxUploadBytes','storageQuotaBytes','billingPolicyVersion','tagExtractorProvider','taskPolicy']);
const ragKeys=['enabled','maxSourceBytes','downloadTimeoutMs','plainTextMaxChars','embeddingBatchSize','indexingConcurrency','embeddingTimeoutMs','embeddingMaxRetries','rerankTimeoutMs','noteRerankBudgetMs'] as const;
const milvusKeys=['searchConcurrency','denseCandidates','bm25Candidates','hybridCandidates','rrfK'] as const;
export const scopedConfig=(base:AppConfig):AppConfig=>{const proxy=new Proxy(base,{get(target,key){
 const active=context.getStore();
 if(active&&key==='rag')return {...target.rag,...Object.fromEntries(ragKeys.map(k=>[k,active.rag[k]]))};
 if(active&&key==='milvus')return {...target.milvus,...Object.fromEntries(milvusKeys.map(k=>[k,active.milvus[k]]))};
 if(active&&key==='kb')return {...target.kb,noteEnabled:active.kb.noteEnabled};
 return Reflect.get(active&&dynamicKeys.has(key)?active:target,key);
}});bases.set(proxy,base);return proxy;};
export class RuntimeSettings {
 private readonly base:AppConfig;
 constructor(private readonly pool:pg.Pool,base:AppConfig){this.base=bases.get(base)??base;}
 drainTimeoutSnapshotMs(){return drainSnapshots.get(this.base)?.timeoutMs??DEFAULT_DRAIN_TIMEOUT_MS;}
 async readDrainTimeoutMs():Promise<number>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([
   this.load().then(()=>this.drainTimeoutSnapshotMs()),
   new Promise<number>(resolve=>{timer=setTimeout(()=>resolve(this.drainTimeoutSnapshotMs()),1000);}),
  ]);}catch(error){return error instanceof DomainError&&error.code==='CONFIGURATION_UNAVAILABLE'?DEFAULT_DRAIN_TIMEOUT_MS:this.drainTimeoutSnapshotMs();}
  finally{if(timer)clearTimeout(timer);}
 }
 async load(){
  const row=(await this.pool.query('SELECT revision,"values",updated_at FROM runtime_configuration WHERE singleton=true')).rows[0];
  if(!row)throw new DomainError(503,'CONFIGURATION_UNAVAILABLE');
  const values=validateStoredValues(row.values,this.base);
  rememberDrainSnapshot(this.base,values,Number(row.revision));
  return {revision:Number(row.revision),values,updatedAt:(row.updated_at as Date).toISOString()};
 }
 async run<T>(execute:()=>Promise<T>):Promise<T>{const loaded=await this.load();return context.run(applyValues(this.base,loaded.values,loaded.revision),execute);}
 async enter(done:(error?:Error)=>void){try{const loaded=await this.load();context.run(applyValues(this.base,loaded.values,loaded.revision),()=>done());}catch(error){done(error as Error);}}
 async view(){const state=await this.load();return {...state,definitions:settings,bootstrap:{processingNodesEnabled:this.base.processingNodes.enabled,cloudControlEnabled:this.base.processingNodes.cloudControlEnabled,
  billingMode:this.base.billingMode,uploadHardMaxBytes:this.base.uploadHardMaxBytes,environmentKeys:['DATABASE_URL','REDIS_QUEUE_URL','REDIS_CACHE_URL','ALIYUN_RAM_ACCESS_KEY_ID','ALIYUN_RAM_ACCESS_KEY_SECRET','PROCESSING_NODES_CLOUD_CONTROL_ENABLED','PROCESSING_NODES_ENABLED','HTTP_UPLOAD_HARD_MAX_BYTES','BILLING_MODE','HOST','PORT','LOG_LEVEL',
   'MILVUS_ADDRESS','MILVUS_USERNAME','MILVUS_PASSWORD','MILVUS_DATABASE','MILVUS_TLS','MILVUS_CREATE_IF_MISSING','KB_NOTE_HYBRID_COLLECTION','KB_DOCUMENT_KEYWORD_COLLECTION',
   'RAG_PROVIDER_MODE','RAG_SOURCE_ALLOWED_HOSTS','RAG_EMBEDDING_BASE_URL','RAG_EMBEDDING_API_KEY','RAG_EMBEDDING_MODEL','RAG_EMBEDDING_DIMENSIONS','RAG_EMBEDDING_PROFILE',
   'RAG_RERANK_PROVIDER','RAG_RERANK_BASE_URL','RAG_RERANK_API_KEY','RAG_RERANK_MODEL']},
  billingPolicies:(await this.pool.query('SELECT policy_version,mode,monthly_credit_limit::text,currency FROM billing_policies ORDER BY policy_version')).rows};}
 async save(category:Category,patch:Values,expectedRevision:number,scope:AdminScope,traceId:string){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new DomainError(400,'CONFIGURATION_INVALID');
  if(!Object.keys(patch).length||Object.keys(patch).some(key=>settings.find(d=>d.key===key)?.category!==category))throw new DomainError(400,'CONFIGURATION_CATEGORY_INVALID');
  const result=await transaction(this.pool,async tx=>{
   await assertSuperadmin(tx,scope);
   const row=(await tx.query('SELECT * FROM runtime_configuration WHERE singleton=true FOR UPDATE')).rows[0];
   if(!row||Number(row.revision)!==expectedRevision)throw new DomainError(409,'CONFIGURATION_CONFLICT');
   const previous=validateStoredValues(row.values,this.base);
   const values=validateValues({...previous,...patch},this.base);
   const policy=(await tx.query('SELECT mode FROM billing_policies WHERE policy_version=$1',[values['billing.policyVersion']])).rows[0];
   if(!policy||this.base.billingMode!=='disabled'&&policy.mode!==this.base.billingMode)throw new DomainError(400,'CONFIGURATION_BILLING_POLICY_INVALID');
   // Preserve fields owned by newer compatible binaries, without persisting
   // this binary's defaults or allowing Admin input to change schema metadata.
   // Leave implicit v1 implicit: pre-compatibility binaries reject new metadata.
   const stored={...row.values,...patch};
   const result=await tx.query('UPDATE runtime_configuration SET "values"=$1,revision=revision+1,updated_by=$2,updated_at=now() WHERE singleton=true RETURNING revision,updated_at',[JSON.stringify(stored),scope.adminId]);
   const before=Object.fromEntries(Object.keys(patch).map(key=>[key,previous[key]]));
   await tx.query('INSERT INTO admin_audit_events(id,admin_id,action,reason,trace_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),scope.adminId,'configuration.update',JSON.stringify({category,before,after:patch,revision:result.rows[0].revision}),traceId]);
   return {revision:Number(result.rows[0].revision),values,updatedAt:result.rows[0].updated_at.toISOString()};
  });
  rememberDrainSnapshot(this.base,result.values,result.revision);
  return result;
 }
}
