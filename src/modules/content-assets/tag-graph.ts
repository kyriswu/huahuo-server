import type pg from 'pg';
import { DomainError } from '../identity/store.js';
export interface GraphQuery {tagId?:string;contentAssetId?:string;cursor?:string;maxNodes?:number;maxEdges?:number;}
export interface TagEvidence {tagId:string;tagName:string;}
export interface TagEdge {id:string;source:string;target:string;kind:string;relationType:string;origin:'tag';label:string;directed:boolean;evidence:{tagId?:string;tagName?:string;sharedTags?:TagEvidence[]};}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A single bounded projection of the authoritative content_asset_tags mapping; no graph store/cache. */
export async function tagGraph(tx:pg.PoolClient,userId:string,wid:string,map:string,input:GraphQuery){
 if(!['graph','tags','overview'].includes(map))throw new DomainError(404,'CONTENT_MAP_NOT_FOUND');
 const maxNodes=input.maxNodes??100,maxEdges=input.maxEdges??200;
 if(!Number.isInteger(maxNodes)||maxNodes<1||maxNodes>100||!Number.isInteger(maxEdges)||maxEdges<1||maxEdges>200)throw new DomainError(400,'GRAPH_BUDGET_INVALID');
 const contentCursor=String((await tx.query('SELECT next_cursor FROM workspace_content_state WHERE workspace_id=$1',[wid])).rows[0]?.next_cursor??0);
 let after:string|null=null;
 if(input.cursor){
  try{
   const c=JSON.parse(Buffer.from(input.cursor,'base64url').toString()) as Record<string,unknown>;
   if(c.wid!==wid||c.tag!==(input.tagId??null)||c.contentAssetId!==(input.contentAssetId??null)||typeof c.last!=='string'||!uuid.test(c.last))throw new Error();
   if(c.contentCursor!==contentCursor)throw new DomainError(409,'GRAPH_CURSOR_STALE');
   after=c.last;
  }catch(e){if(e instanceof DomainError)throw e;throw new DomainError(400,'GRAPH_CURSOR_INVALID');}
 }
 if(input.tagId && !(await tx.query('SELECT 1 FROM asset_tags WHERE tag_id=$1 AND workspace_id=$2',[input.tagId,wid])).rowCount)throw new DomainError(404,'TAG_NOT_FOUND');
 if(input.contentAssetId && !(await tx.query(
  `SELECT 1 FROM content_assets asset JOIN content_asset_workspaces w ON w.content_asset_id=asset.content_asset_id AND w.workspace_id=$2
   WHERE asset.content_asset_id=$1 AND asset.user_id=$3 AND asset.state='active'`,[input.contentAssetId,wid,userId],
 )).rowCount)throw new DomainError(404,'CONTENT_ASSET_NOT_FOUND');
 const contentAssetBudget=Math.max(1,Math.floor(maxNodes/2));
 const filter=`asset.user_id=$4 AND asset.state='active'
  AND EXISTS(SELECT 1 FROM content_asset_workspaces w WHERE w.content_asset_id=asset.content_asset_id AND w.workspace_id=$1)
  AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM content_asset_tags m WHERE m.content_asset_id=asset.content_asset_id AND m.tag_id=$2))
  AND ($3::uuid IS NULL OR asset.content_asset_id=$3 OR EXISTS(SELECT 1 FROM content_asset_tags a JOIN content_asset_tags b ON a.tag_id=b.tag_id WHERE a.content_asset_id=$3 AND b.content_asset_id=asset.content_asset_id))`;
 const values=[wid,input.tagId??null,input.contentAssetId??null,userId];
 const totalContentAssets=Number((await tx.query(`SELECT count(*) FROM content_assets asset WHERE ${filter}`,values)).rows[0].count);
 const page=await tx.query<{content_asset_id:string;title:string;content_asset_revision_id:string;source_kind:string;updated_at:Date}>(`SELECT asset.content_asset_id,asset.title,asset.content_asset_revision_id,asset.source_kind,asset.updated_at FROM content_assets asset WHERE ${filter} AND ($5::uuid IS NULL OR (asset.content_asset_id>$5 AND ($3::uuid IS NULL OR asset.content_asset_id<>$3))) ORDER BY (asset.content_asset_id=$3) DESC NULLS LAST,asset.content_asset_id LIMIT $6`,[...values,after,contentAssetBudget+1]);
 const contentAssets=page.rows.slice(0,contentAssetBudget),ids=contentAssets.map(asset=>asset.content_asset_id),hasMore=page.rows.length>contentAssetBudget;
 const tagBudget=maxNodes-contentAssets.length;
 // Counts are over all active authorized contentAssets, not just the returned page.
 const topicRows=await tx.query<{tag_id:string;display_name:string;count:number}>(`SELECT t.tag_id,t.display_name,
  (SELECT count(*)::int FROM content_asset_tags m JOIN content_assets asset ON asset.content_asset_id=m.content_asset_id AND asset.user_id=$4 AND asset.state='active'
   JOIN content_asset_workspaces w ON w.content_asset_id=asset.content_asset_id AND w.workspace_id=$1 WHERE m.tag_id=t.tag_id) count
  FROM asset_tags t WHERE t.workspace_id=$1 AND EXISTS(SELECT 1 FROM content_asset_tags m WHERE m.tag_id=t.tag_id AND m.content_asset_id=ANY($2::uuid[]))
  ORDER BY t.tag_id LIMIT $3`,[wid,ids,tagBudget+1,userId]);
 const tags=topicRows.rows.slice(0,tagBudget),tagIds=tags.map(t=>t.tag_id);
 const edges:TagEdge[]=[];
 // Only pairs inside this bounded page are derived, and never persisted.
 const pairs=await tx.query<{source:string;target:string;tags:TagEvidence[]}>(`SELECT a.content_asset_id source,b.content_asset_id target,
  jsonb_agg(jsonb_build_object('tagId',t.tag_id,'tagName',t.display_name) ORDER BY t.tag_id) tags
  FROM content_asset_tags a JOIN content_asset_tags b ON b.tag_id=a.tag_id AND a.content_asset_id<b.content_asset_id
  JOIN asset_tags t ON t.tag_id=a.tag_id AND t.workspace_id=$1
  WHERE a.content_asset_id=ANY($2::uuid[]) AND b.content_asset_id=ANY($2::uuid[]) GROUP BY a.content_asset_id,b.content_asset_id ORDER BY a.content_asset_id,b.content_asset_id LIMIT $3`,[wid,ids,maxEdges+1]);
 for(const p of pairs.rows.slice(0,maxEdges))edges.push({id:`co-tagged:${p.source}:${p.target}`,source:p.source,target:p.target,kind:'sharedTopic',relationType:'co_tagged',origin:'tag',label:'共同标签',directed:false,evidence:{sharedTags:p.tags}});
 const remaining=maxEdges-edges.length;
 const memberships=await tx.query<{content_asset_id:string;tag_id:string;display_name:string}>(`SELECT m.content_asset_id,m.tag_id,t.display_name FROM content_asset_tags m JOIN asset_tags t ON t.tag_id=m.tag_id AND t.workspace_id=$1 WHERE m.content_asset_id=ANY($2::uuid[]) AND m.tag_id=ANY($3::uuid[]) ORDER BY m.content_asset_id,m.tag_id LIMIT $4`,[wid,ids,tagIds,remaining+1]);
 for(const m of memberships.rows.slice(0,remaining))edges.push({id:`tagged:${m.content_asset_id}:${m.tag_id}`,source:m.content_asset_id,target:m.tag_id,kind:'membership',relationType:'tagged_with',origin:'tag',label:m.display_name,directed:false,evidence:{tagId:m.tag_id,tagName:m.display_name}});
 const nodes=[...contentAssets.map(asset=>({id:asset.content_asset_id,kind:'content_asset',entityType:'content_asset',contentId:asset.content_asset_id,label:asset.title,revisionId:asset.content_asset_revision_id,sourceKind:asset.source_kind})),...tags.map(t=>({id:t.tag_id,kind:'tag',entityType:'Topic',label:t.display_name,count:t.count}))];
 // Current App overview mapper requires relative unique logical paths and one
 // revisionId OR version. It currently ignores supplied edges; no fake paths
 // are invented to make the client infer arbitrary semantic relationships.
 const items=[...contentAssets.map(asset=>({ownerRef:{workspaceId:wid,kind:'content_asset',id:asset.content_asset_id},path:`content-assets/${asset.content_asset_id}.md`,title:asset.title,revisionId:asset.content_asset_revision_id})),...tags.map(t=>({ownerRef:{workspaceId:wid,kind:'tag',id:t.tag_id},path:`tags/${t.tag_id}`,title:t.display_name,version:Number(contentCursor)}))];
 const edgesTruncated=pairs.rows.length>maxEdges||memberships.rows.length>remaining;
 return {map,workspaceId:wid,graphId:`workspace:${wid}:${map}`,contentCursor,items,nodes,edges,totalContentAssets,hasMore,
  truncated:hasMore||topicRows.rows.length>tagBudget||edgesTruncated,edgesTruncated,
  nextCursor:hasMore?Buffer.from(JSON.stringify({wid,tag:input.tagId??null,contentAssetId:input.contentAssetId??null,last:input.contentAssetId&&contentAssets.length===1&&contentAssets[0]!.content_asset_id===input.contentAssetId?'00000000-0000-0000-0000-000000000000':contentAssets.at(-1)!.content_asset_id,contentCursor})).toString('base64url'):null};
}
