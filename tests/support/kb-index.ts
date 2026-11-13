import type {HybridIndex} from '../../src/modules/kb/types.js';
/** Test-only deterministic index; never selected implicitly by live code. */
export function mockKnowledgeIndex():HybridIndex & {points:Map<string,import('../../src/modules/kb/types.js').IndexPoint>} {
 const points=new Map<string,import('../../src/modules/kb/types.js').IndexPoint>();
 const search=async(query:string,options:{scope:import('../../src/modules/kb/types.js').RecallScope;limit:number})=>[...points.values()].filter(p=>options.scope.pointIds.includes(p.id)&&p.userId===options.scope.userId&&p.workspaceId===options.scope.workspaceId&&p.content.toLowerCase().includes(query.split(/\s/u)[0]!.toLowerCase())).slice(0,options.limit).map(p=>({chunkKey:p.id,content:p.content,score:1}));
 return {points,ensureReady:async()=>{},upsert:async rows=>{for(const p of rows)points.set(p.id,p);},deletePoints:async ids=>{for(const id of ids)points.delete(id);},close:async()=>{},searchKeyword:search,search:async(_v,o)=>search('',o),hybridSearch:async(_v,q,o)=>search(q,o)};
}
