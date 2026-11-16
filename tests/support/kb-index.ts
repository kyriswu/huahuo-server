import type {HybridIndex,KeywordIndex,IndexPoint,SearchOptions} from '../../src/lib/search-index/types.js';
/** Test-only deterministic index; never selected implicitly by live code. */
export function mockKnowledgeIndex():HybridIndex & {points:Map<string,IndexPoint>;keyword:KeywordIndex & {points:Map<string,IndexPoint>}} {
 const points=new Map<string,IndexPoint>();
 const search=async(query:string,options:SearchOptions)=>[...points.values()].filter(p=>options.scope.pointIds.includes(p.id)&&p.userId===options.scope.userId&&p.workspaceId===options.scope.workspaceId&&p.content.toLowerCase().includes(query.split(/\s/u)[0]!.toLowerCase())).slice(0,options.limit).map(p=>({chunkKey:p.id,content:p.content,score:1}));
 const common={points,ensureReady:async()=>{},upsert:async(rows:readonly IndexPoint[])=>{for(const p of rows)points.set(p.id,p);},deletePoints:async(ids:readonly string[])=>{for(const id of ids)points.delete(id);},close:async()=>{},searchKeyword:search};
 return {...common,kind:'hybrid',keyword:{...common,kind:'keyword'},search:async(_v,o)=>search('',o),hybridSearch:async(_v,q,o)=>search(q,o)};
}
