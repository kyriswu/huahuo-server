import type {HybridIndex,KeywordIndex,IndexPoint,SearchOptions} from '../../src/lib/search-index/types.js';
function withinTime(metadata:NonNullable<IndexPoint['assetMetadata']>,time:NonNullable<NonNullable<SearchOptions['filter']>['time']>){
 const value=time.field==='created_at'?metadata.createdAt:metadata.updatedAt;
 return (time.from===undefined||value>=time.from)&&(time.to===undefined||value<=time.to);
}
/** Test-only deterministic index; never selected implicitly by live code. */
export function mockKnowledgeIndex():HybridIndex & {points:Map<string,IndexPoint>;keyword:KeywordIndex & {points:Map<string,IndexPoint>}} {
 const points=new Map<string,IndexPoint>();
 const search=async(query:string,options:SearchOptions)=>[...points.values()].filter(p=>(options.scope.accountWide||options.scope.pointIds.includes(p.id))&&p.userId===options.scope.userId&&p.workspaceId===options.scope.workspaceId&&(!options.filter?.sourceIds||options.filter.sourceIds.includes(p.sourceId))
  &&(!options.filter?.assetKinds||(p.assetMetadata&&options.filter.assetKinds.includes(p.assetMetadata.assetKind)))
  &&(!options.filter?.time||(p.assetMetadata&&withinTime(p.assetMetadata,options.filter.time)))
  &&p.content.toLowerCase().includes(query.split(/\s/u)[0]!.toLowerCase())).slice(0,options.limit).map(p=>({chunkKey:p.id,content:p.content,score:1}));
 const common={points,ensureReady:async()=>{},upsert:async(rows:readonly IndexPoint[])=>{for(const p of rows)points.set(p.id,p);},deletePoints:async(ids:readonly string[])=>{for(const id of ids)points.delete(id);},close:async()=>{},searchKeyword:search};
 return {...common,kind:'hybrid',updateAssetMetadata:async(ids,assetMetadata)=>{for(const id of ids){const point=points.get(id);if(point)points.set(id,{...point,assetMetadata});}},keyword:{...common,kind:'keyword'},search:async(_v,o)=>search('',o),hybridSearch:async(_v,q,o)=>search(q,o)};
}
