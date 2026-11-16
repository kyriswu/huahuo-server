import type {AppConfig} from '../../config/config.js';
import {DomainError} from '../identity/store.js';
export type Category='rag'|'tasks'|'storage'|'billing'|'features'|'deployment';
export const DRAIN_TIMEOUT_KEY='deployment.drainTimeoutMs';
export const DEFAULT_DRAIN_TIMEOUT_MS=600000;
export const MAX_DRAIN_TIMEOUT_MS=3600000;
export interface SettingDefinition {key:string;category:Category;label:string;description:string;type:'number'|'boolean'|'select'|'string';default:unknown;min?:number;max?:number;options?:string[];effect:string;}
export const settings:SettingDefinition[]=[
 {key:DRAIN_TIMEOUT_KEY,category:'deployment',label:'服务排空上限（毫秒）',description:'旧服务最多等待10–60分钟；工作完成后立即退出，达到上限强制结束。首次排空信号固定本次预算，重复停止信号不延长。',type:'number',min:DEFAULT_DRAIN_TIMEOUT_MS,max:MAX_DRAIN_TIMEOUT_MS,default:DEFAULT_DRAIN_TIMEOUT_MS,effect:'用于后续排空；发布期间请勿调整，不改变已开始的排空预算'},
 {key:'rag.denseCandidates',category:'rag',label:'向量召回候选数',description:'Note 混合检索中向量分支的候选数量。',type:'number',min:1,max:200,default:20,effect:'后续查询，执行中查询保持原参数'},
 {key:'rag.bm25Candidates',category:'rag',label:'关键词召回候选数',description:'BM25 关键词分支的候选数量；最终返回数量仍由请求 topK 决定。',type:'number',min:1,max:200,default:20,effect:'后续查询'},
 {key:'rag.hybridCandidates',category:'rag',label:'混合检索候选数',description:'融合后送入权限复核与可选重排的候选预算。',type:'number',min:1,max:200,default:30,effect:'后续查询'},
 {key:'rag.rrfK',category:'rag',label:'RRF 融合平滑参数',description:'控制多路排序融合对名次差异的敏感程度；不是返回条数。',type:'number',min:1,max:10000,default:60,effect:'后续混合查询'},
 {key:'rag.searchConcurrency',category:'rag',label:'检索客户端并发上限',description:'每个缓存检索客户端的并发预算，不是集群总额度；旧请求完成后释放旧客户端。',type:'number',min:1,max:50,default:50,effect:'后续查询客户端，不中断执行中查询'},
 {key:'rag.embeddingBatchSize',category:'rag',label:'Embedding 索引批次',description:'Note 单次百炼请求最多20条，构建快照会将较大配置限制为20；资料关键词模式不调用 Embedding。',type:'number',min:1,max:256,default:20,effect:'新索引构建快照'},
 {key:'rag.indexConcurrency',category:'rag',label:'索引批次并发',description:'单次索引构建中的批次并发，独立于 Worker 队列并发。',type:'number',min:1,max:16,default:2,effect:'新索引构建快照'},
 {key:'rag.embeddingTimeoutMs',category:'rag',label:'Embedding 超时（毫秒）',description:'索引构建和查询向量请求的执行时限。',type:'number',min:1000,max:600000,default:30000,effect:'新索引构建快照及后续查询'},
 {key:'rag.embeddingMaxRetries',category:'rag',label:'Embedding 索引重试次数',description:'单批索引的额外尝试上限；查询保持现有不自动重试约定。',type:'number',min:0,max:5,default:2,effect:'新索引构建快照'},
 {key:'rag.rerankTimeoutMs',category:'rag',label:'重排请求超时（毫秒）',description:'已配置重排服务时使用的 HTTP 执行时限。',type:'number',min:1000,max:600000,default:30000,effect:'后续查询'},
 {key:'rag.noteRerankBudgetMs',category:'rag',label:'Note 重排等待预算（毫秒）',description:'超出预算沿用已授权召回顺序，不把等待预算当作服务调用超时。',type:'number',min:1,max:30000,default:200,effect:'后续 Note 查询'},
 {key:'rag.plainTextMaxChars',category:'rag',label:'原生文本字符上限',description:'TXT、Markdown、CSV 原生提取的字符数上限，超过明确失败。',type:'number',min:1,max:5000000,default:50000,effect:'新执行批次'},
 {key:'tasks.maxAttempts',category:'tasks',label:'自动执行次数上限',description:'包含首次执行；只应用到新建任务。',type:'number',min:1,max:9,default:3,effect:'新建任务'},
 {key:'tasks.retryBaseMs',category:'tasks',label:'重试基础间隔（毫秒）',description:'指数退避并保留抖动，未知外部结果不自动重提交。',type:'number',min:100,max:60000,default:1000,effect:'新执行批次'},
 {key:'tasks.retryMaxMs',category:'tasks',label:'重试最大间隔（毫秒）',description:'必须不小于基础间隔。',type:'number',min:100,max:3600000,default:60000,effect:'新执行批次'},
 ...(['content','ai','commercial','maintenance'] as const).map((q,i)=>({key:`tasks.concurrency.${q}`,category:'tasks' as const,label:`${({content:'内容',ai:'AI',commercial:'商业',maintenance:'维护'})[q]}队列并发`,description:'每个Worker进程的消费上限；节点另有全局并发限制。',type:'number' as const,min:1,max:32,default:i===0?2:1,effect:'Worker约5秒同步，不中断执行中任务'})),
 {key:'tasks.downloadTimeoutMs',category:'tasks',label:'源文件下载超时（毫秒）',description:'文档准备阶段下载时限。',type:'number',min:1000,max:600000,default:120000,effect:'新执行批次'},
 {key:'storage.maxUploadBytes',category:'storage',label:'业务上传上限（字节）',description:'同时受部署HTTP硬上限限制。',type:'number',min:1,max:2147483648,default:104857600,effect:'新上传申请'},
 {key:'storage.quotaBytes',category:'storage',label:'用户存储额度（字节）',description:'当前统一额度；不自动删除已有对象。',type:'number',min:1,max:Number.MAX_SAFE_INTEGER,default:1073741824,effect:'后续容量检查'},
 {key:'storage.maxSourceBytes',category:'storage',label:'文档源文件上限（字节）',description:'处理器下载源文件的大小限制。',type:'number',min:1,max:2147483648,default:209715200,effect:'新执行批次'},
 {key:'billing.policyVersion',category:'billing',label:'计费策略版本',description:'选择已有不可变策略；历史账户和账本不重写。',type:'string',default:'credit-policy-v1',effect:'后续新发放/预留，沿用现有计费规则'},
 {key:'features.documentIngestion',category:'features',label:'文档入库',description:'控制资料受理，继续使用现有关键词流水线。',type:'boolean',default:true,effect:'后续请求'},
 {key:'features.noteIndexing',category:'features',label:'Note 正文索引',description:'控制后续正文修改是否创建索引任务，不删除已有索引或取消执行中任务。',type:'boolean',default:false,effect:'后续正文变更请求'},
 {key:'features.tagProvider',category:'features',label:'标签提取提供器',description:'生产禁用 deterministic；LLM/Dify 适配器尚未接入，选择后仍会明确失败。',type:'select',options:['disabled','llm','dify','deterministic'],default:'disabled',effect:'新执行批次'},
];
export type Values=Record<string,unknown>;
export const RUNTIME_CONFIGURATION_SCHEMA_KEY='$schemaVersion';
export const RUNTIME_CONFIGURATION_SCHEMA_VERSION=1;
export const defaults=():Values=>Object.fromEntries(settings.map(d=>[d.key,structuredClone(d.default)]));
export function rejectSecrets(value:unknown):void{
 if(!value||typeof value!=='object')return;
 for(const[key,child]of Object.entries(value)){
  const name=key.toLowerCase().replace(/[_-]/g,'');
  if(/(?:password|secret|apikey|accesskeyid|accesskeysecret|securitytoken|authorization|credentials?|accesstoken|privatekey)$/.test(name))throw new DomainError(400,'CONFIGURATION_SECRET_FORBIDDEN');
  if(typeof child==='string'&&/^https?:\/\//.test(child)){
   try{const url=new URL(child);if(url.username||url.password||[...url.searchParams.keys()].some(k=>/token|signature|secret|accesskey/i.test(k)))throw new DomainError(400,'CONFIGURATION_SECRET_FORBIDDEN');}catch(e){if(e instanceof DomainError)throw e;}
  }
  rejectSecrets(child);
 }
}
export function validateValues(values:Values,base:AppConfig):Values{
 if(!values||typeof values!=='object'||Array.isArray(values))throw new DomainError(400,'CONFIGURATION_INVALID');
 rejectSecrets(values);
 const all=defaults();
 for(const[key,value]of Object.entries(values)){
  const d=settings.find(d=>d.key===key);if(!d)throw new DomainError(400,'CONFIGURATION_KEY_UNKNOWN');
  if(d.type==='number'&&(!Number.isSafeInteger(value)||Number(value)<d.min!||Number(value)>d.max!)
   ||d.type==='boolean'&&typeof value!=='boolean'||d.type==='select'&&!d.options!.includes(value as string)
   ||d.type==='string'&&(typeof value!=='string'||!/^[A-Za-z0-9._-]{1,64}$/.test(value)))throw new DomainError(400,'CONFIGURATION_INVALID');
  all[key]=structuredClone(value);
 }
 if(Number(all['tasks.retryBaseMs'])>Number(all['tasks.retryMaxMs'])||Number(all['storage.maxUploadBytes'])>base.uploadHardMaxBytes)throw new DomainError(400,'CONFIGURATION_INVALID');
 if(base.appEnv==='production'&&all['features.tagProvider']==='deterministic')throw new DomainError(400,'CONFIGURATION_TEST_PROVIDER_FORBIDDEN');
 return all;
}
// Only optional, additive fields may share a schema version. Changes to existing
// semantics or safety requirements must bump the stored contract before use.
// Missing metadata always means v1, even when a future reader supports v2.
export function validateStoredValues(values:Values,base:AppConfig):Values{
 if(!values||typeof values!=='object'||Array.isArray(values))throw new DomainError(400,'CONFIGURATION_INVALID');
 const version=Object.hasOwn(values,RUNTIME_CONFIGURATION_SCHEMA_KEY)?values[RUNTIME_CONFIGURATION_SCHEMA_KEY]:1;
 if(version!==RUNTIME_CONFIGURATION_SCHEMA_VERSION)throw new DomainError(503,'CONFIGURATION_VERSION_UNSUPPORTED');
 rejectSecrets(values);
 // Unknown persisted fields are opaque: never apply or expose them through an
 // older Admin. Known fields keep the same validation as strict Admin input.
 return validateValues(Object.fromEntries(Object.entries(values).filter(([key])=>settings.some(d=>d.key===key))),base);
}
export function applyValues(base:AppConfig,values:Values,revision:number):AppConfig{
 const v=validateValues(values,base);
 return {...base,runtimeRevision:revision,maxUploadBytes:Number(v['storage.maxUploadBytes']),storageQuotaBytes:Number(v['storage.quotaBytes']),
  billingPolicyVersion:v['billing.policyVersion'] as string,tagExtractorProvider:v['features.tagProvider'] as AppConfig['tagExtractorProvider'],
  rag:{...base.rag,enabled:v['features.documentIngestion'] as boolean,maxSourceBytes:Number(v['storage.maxSourceBytes']),downloadTimeoutMs:Number(v['tasks.downloadTimeoutMs']),
   plainTextMaxChars:Number(v['rag.plainTextMaxChars']),embeddingBatchSize:Number(v['rag.embeddingBatchSize']),indexingConcurrency:Number(v['rag.indexConcurrency']),
   embeddingTimeoutMs:Number(v['rag.embeddingTimeoutMs']),embeddingMaxRetries:Number(v['rag.embeddingMaxRetries']),rerankTimeoutMs:Number(v['rag.rerankTimeoutMs']),noteRerankBudgetMs:Number(v['rag.noteRerankBudgetMs'])},
  milvus:{...base.milvus,searchConcurrency:Number(v['rag.searchConcurrency']),denseCandidates:Number(v['rag.denseCandidates']),bm25Candidates:Number(v['rag.bm25Candidates']),hybridCandidates:Number(v['rag.hybridCandidates']),rrfK:Number(v['rag.rrfK'])},
  kb:{...base.kb,noteEnabled:v['features.noteIndexing'] as boolean},
  taskPolicy:{maxAttempts:Number(v['tasks.maxAttempts']),retryBaseMs:Number(v['tasks.retryBaseMs']),retryMaxMs:Number(v['tasks.retryMaxMs']),
   concurrency:Object.fromEntries(['content','ai','commercial','maintenance'].map(q=>[q,Number(v[`tasks.concurrency.${q}`])])) as AppConfig['taskPolicy']['concurrency']}};
}
