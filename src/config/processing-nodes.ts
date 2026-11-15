export interface ProcessingNodesConfig {
 enabled:boolean;
 coordination:{leaseMs:number;receiptTtlMs:number;maxPending:number};
 credentials:()=>Promise<{accessKeyId:string;accessKeySecret:string;securityToken?:string}>;
 token:(name:string)=>string|undefined;
}
export function loadProcessingNodesConfig(env:Readonly<Record<string,string|undefined>>):ProcessingNodesConfig{
 const value=env.PROCESSING_NODES_ENABLED??'false';
 if(!['true','false'].includes(value))throw Error('INVALID_CONFIG:PROCESSING_NODES_ENABLED');
 const number=(key:string,defaultValue:number,min:number,max:number)=>{const n=Number(env[key]??defaultValue);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('INVALID_CONFIG:'+key);return n;};
 return {enabled:value==='true',coordination:{leaseMs:number('PROCESSING_NODE_LEASE_MS',30000,6000,120000),receiptTtlMs:number('PROCESSING_NODE_DEDUP_TTL_SECONDS',86400,60,604800)*1000,maxPending:number('PROCESSING_NODE_MAX_PENDING',128,1,1024)},credentials:async()=>{
  if(!env.ALIYUN_RAM_ACCESS_KEY_ID?.trim()||!env.ALIYUN_RAM_ACCESS_KEY_SECRET?.trim())throw Error('PROCESSING_NODE_CREDENTIALS_UNAVAILABLE');
  return {accessKeyId:env.ALIYUN_RAM_ACCESS_KEY_ID.trim(),accessKeySecret:env.ALIYUN_RAM_ACCESS_KEY_SECRET.trim(),...(env.ALIYUN_RAM_SECURITY_TOKEN?.trim()?{securityToken:env.ALIYUN_RAM_SECURITY_TOKEN.trim()}:{})};
 },token:name=>{
  if(!/^PROCESSING_NODE_TOKEN_[A-Z0-9_]{1,64}$/.test(name))throw Error('PROCESSING_NODE_TOKEN_REFERENCE_INVALID');
  return env[name]?.trim()||undefined;
 }};
}
