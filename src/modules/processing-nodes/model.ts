import {createDocumentParserConfig,type EnabledDocumentParserMachineConfig} from '../../config/document-parser-machine.js';
import type {ProcessingNodesConfig} from '../../config/processing-nodes.js';
import {DomainError} from '../identity/store.js';
import {createDocumentExtractionConfig,defaultDocumentApi,type DocumentApiSettings} from '../../config/document-extraction.js';
import {rejectSecrets} from '../runtime-settings/registry.js';
export type {EciFallbackSettings as EciFallback} from '../../config/document-parser-eci.js';
import {createDocumentParserEciConfig,type EciFallbackSettings as EciFallback} from '../../config/document-parser-eci.js';
export type Capability='document'|'audio';
export interface ProcessingNode {
 id:string;name:string;capabilities:Capability[];resourceClass:'cpu'|'gpu';mode:'ecs'|'always-on';
 regionId:string|null;instanceId:string|null;privateIp:string|null;baseUrl:string;healthPath:string;tokenEnv:string|null;
 concurrency:number;idleSeconds:number;startupSeconds:number;queueSeconds:number;revision:number;
 eciFallback?:EciFallback|null;
 documentApi?:DocumentApiSettings;
}
export function nodeDocumentConfig(node:ProcessingNode){
 const api=node.documentApi??defaultDocumentApi();
 if(api.mode!=='async')throw new DomainError(400,'PROCESSING_NODE_ASYNC_REQUIRED');
 rejectSecrets(api);
 return createDocumentExtractionConfig(api.mode,api.parameters,api.pollMs,api.maxResponseBytes,api.timeoutSeconds*1000);
}
export function nodeConfig(node:ProcessingNode,bootstrap:ProcessingNodesConfig,requireApiToken=true):EnabledDocumentParserMachineConfig{
 if(!bootstrap.enabled)throw new DomainError(503,'PROCESSING_NODE_UNAVAILABLE');
 try{
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(node.id)||!node.name?.trim()||node.name.length>80||!['cpu','gpu'].includes(node.resourceClass)
   ||!Array.isArray(node.capabilities)||!node.capabilities.length||new Set(node.capabilities).size!==node.capabilities.length
   ||node.capabilities.some(c=>!['document','audio'].includes(c))||!Number.isSafeInteger(node.revision)||node.revision<1)throw Error();
  if(node.tokenEnv&&!/^PROCESSING_NODE_TOKEN_[A-Z0-9_]{1,64}$/.test(node.tokenEnv))throw Error();
  if(node.mode==='always-on'&&(node.instanceId||node.regionId||node.privateIp))throw Error();
  const fallback=node.eciFallback;
  if(node.documentApi&&!node.capabilities.includes('document'))throw Error();
  if(node.capabilities.includes('document'))nodeDocumentConfig(node);
  if(fallback&&(node.mode!=='ecs'||node.resourceClass!=='gpu'||node.capabilities.length!==1||node.capabilities[0]!=='document'))throw Error();
  const config=createDocumentParserConfig({mode:node.mode,baseUrl:node.baseUrl,healthPath:node.healthPath,
   regionId:node.regionId??undefined,instanceId:node.instanceId??undefined,privateIp:node.privateIp??undefined,
   concurrency:node.concurrency,idleMs:node.idleSeconds*1000,startupTimeoutMs:node.startupSeconds*1000,queueTimeoutMs:node.queueSeconds*1000,
   ...bootstrap.coordination,coordinationId:node.id,credentials:bootstrap.credentials,
   ...(fallback?{eciFallback:createDocumentParserEciConfig(fallback,node.regionId!)}:{})});
  // The DB stores only a secret reference. Resolve it in the owning deployment.
  const token=node.tokenEnv?bootstrap.token(node.tokenEnv):undefined;
  if(requireApiToken&&node.tokenEnv&&!token)throw new DomainError(503,'PROCESSING_NODE_TOKEN_UNAVAILABLE');
  if(token&&(token.length>4096||/[\r\n]/.test(token)))throw new DomainError(503,'PROCESSING_NODE_TOKEN_UNAVAILABLE');
  return {...config,powerControlEnabled:bootstrap.cloudControlEnabled,...(token?{apiToken:token}:{})};
 }catch(error){if(error instanceof DomainError)throw error;throw new DomainError(400,'PROCESSING_NODE_INVALID');}
}
export function nodeFromRow(row:Record<string,unknown>):ProcessingNode{
 const config={...row.config as Record<string,unknown>};
 const node={...config,id:row.id as string,revision:Number(row.revision)} as ProcessingNode;
 return {...node,...(node.capabilities.includes('document')?{documentApi:node.documentApi??defaultDocumentApi()}:{} )};
}
