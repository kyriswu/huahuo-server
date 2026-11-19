import type pg from 'pg';
import type {AppConfig} from '../../config/config.js';
import {DomainError,assertScope,transaction,type Scope} from '../identity/store.js';
import {snapshotForSource,kbEmbedding,kbTokenizer,knowledgeIndex,type IndexFactory} from '../kb/profile.js';
import {readSourceBody} from '../kb/repository.js';
import {tablesForSource,type KbBuild,type KbSourceType,type KbSnapshot} from '../kb/types.js';
import type {HybridIndex,KeywordIndex} from '../../lib/search-index/types.js';
import {requireIndexKind} from '../../lib/search-index/factory.js';
import {digest} from '../../lib/crypto.js';
import type {EmbeddingClient} from './adapters/embedding.js';
import {HttpRerankAdapter,MockRerankAdapter,rerankWithinBudget,fuseRankedRecall,type RerankAdapter,type RagSearchCandidate} from './search.js';
import {SearchQueryTiming} from './query-timing.js';
import { CONTENT_ASSET_EMBEDDING_MODEL, CONTENT_ASSET_EMBEDDING_PROFILE } from './model-profile.js';
import {kbImages,renderKbImages,type KbImage} from '../../lib/kb-images.js';
export type RagQueryMode='keyword'|'dense'|'hybrid';
export interface RagQueryInput{query:string;mode?:RagQueryMode;sourceType?:'content_asset'|'file';topK?:number;documentKey?:string;assetMode?:'ids'|'links';filters?:{folderIds?:string[];tagIds?:string[];sourceKinds?:string[];from?:string;to?:string;};}
export interface RagImageRequest{sourceType:KbSourceType;sourceId:string;workspaceId?:string;sourceRevision:string;resourceId:string;}
export interface RagImageLink{url:string;expiresAt:string;}
export const ragImageKey=(image:RagImageRequest)=>JSON.stringify([image.sourceType,image.sourceId,image.workspaceId,image.sourceRevision,image.resourceId]);
export interface RagQueryDependencies{embedding?:EmbeddingClient;index?:IndexFactory;rerank?:RerankAdapter;resolveImages?:(scope:Scope,images:RagImageRequest[])=>Promise<ReadonlyMap<string,RagImageLink>>;}
interface EligibleBuild extends KbBuild {cursor_created_at:string;source_body?:string|null;source_uri?:string|null;}
const sourcePageSize=128;
interface ChunkRow{build_id:string;point_id:string;ordinal:number;source_start:number;source_end:number;content_hash:string;chunk_count:number;}
export class RagQueryService {
 private indexes=new Map<string,{target:string;index:HybridIndex|KeywordIndex;active:number;revision:number;retired:boolean}>();
 constructor(private readonly pool:pg.Pool,private readonly config:AppConfig,private readonly dependencies:RagQueryDependencies={}){}
 private reranker():RerankAdapter|undefined{
  const config=this.config;
  return this.dependencies.rerank??(config.rag.rerankProvider==='mock'?new MockRerankAdapter():config.rag.rerankProvider==='http'?new HttpRerankAdapter({baseUrl:config.rag.rerankBaseUrl!,apiKey:config.rag.rerankApiKey,model:config.rag.rerankModel,timeoutMs:config.rag.rerankTimeoutMs}):undefined);
 }
 private acquireIndex(snapshot:KbSnapshot){
  const target=JSON.stringify(snapshot.target),tuning=this.config.milvus;
  const key=JSON.stringify([target,tuning.searchConcurrency,tuning.denseCandidates,tuning.bm25Candidates,tuning.hybridCandidates,tuning.rrfK]);
  let entry=this.indexes.get(key);
  if(!entry){entry={target,index:this.dependencies.index?.(snapshot)??knowledgeIndex(this.config,snapshot,undefined,this.pool),active:0,revision:this.config.runtimeRevision,retired:false};this.indexes.set(key,entry);}
  entry.revision=Math.max(entry.revision,this.config.runtimeRevision);entry.active++;
  const latest=Math.max(...[...this.indexes.values()].filter(e=>e.target===target).map(e=>e.revision));
  for(const other of this.indexes.values())if(other.target===target)other.retired=other.revision<latest||(other.revision===latest&&other!==entry);
  const acquired=entry;
  return {index:entry.index,release:async()=>{
   acquired.active--;
   const closing:Promise<void>[]=[];
   for(const [cacheKey,old]of this.indexes)if(old.retired&&!old.active){this.indexes.delete(cacheKey);closing.push(old.index.close());}
   await Promise.all(closing);
  }};
 }
 async close(){await Promise.all([...this.indexes.values()].map(entry=>entry.index.close()));this.indexes.clear();}
 private async eligible(scope:Scope,input:RagQueryInput,type:'content_asset'|'file',
  {cursor,ids,includeBody=false}:{cursor?:{createdAt:string;id:string};ids?:string[];includeBody?:boolean}={}){
  const {builds}=tablesForSource(type);
  return transaction(this.pool,async tx=>{await assertScope(tx,scope);
   const values:unknown[]=[scope.userId,type==='content_asset'?['content_asset']:['file','text'],input.documentKey??null,cursor?.createdAt??null,cursor?.id??null,ids??null,ids?.length??sourcePageSize];
   let sourceJoin=type==='content_asset'?`JOIN content_assets asset ON asset.content_asset_id=b.source_id AND asset.user_id=b.user_id AND asset.state='active' AND asset.processing_status='ready'
     JOIN content_asset_parts p ON p.content_asset_id=asset.content_asset_id AND p.part='raw' AND p.part_revision_id::text=b.source_revision`
    :`LEFT JOIN rag_ingestion_versions v ON b.source_type='file' AND v.id=b.source_id AND v.user_id=b.user_id AND v.workspace_id=b.workspace_id AND v.content_hash=b.source_revision AND v.active AND v.deleted_at IS NULL AND v.status='SUCCEEDED'
      LEFT JOIN text_ingestion_jobs j ON b.source_type='text' AND j.id=b.source_id AND j.created_by=b.user_id AND j.workspace_id=b.workspace_id AND j.content_hash=b.source_revision AND j.ingest_status='success'`;
   if(type==='content_asset'){
    if(input.filters?.folderIds?.length)sourceJoin+=` AND asset.folder_id=ANY($${values.push(input.filters.folderIds)}::uuid[])
      AND EXISTS(SELECT 1 FROM asset_folders f WHERE f.folder_id=asset.folder_id AND f.user_id=asset.user_id AND f.state='active')`;
    if(input.filters?.sourceKinds?.length)sourceJoin+=` AND asset.source_kind=ANY($${values.push(input.filters.sourceKinds)}::text[])`;
    if(input.filters?.tagIds?.length)sourceJoin+=` AND EXISTS(SELECT 1 FROM content_asset_tags membership JOIN asset_tags at ON at.tag_id=membership.tag_id AND at.user_id=b.user_id WHERE membership.content_asset_id=asset.content_asset_id AND membership.tag_id=ANY($${values.push(input.filters.tagIds)}::uuid[]))`;
    if(input.filters?.from)sourceJoin+=` AND asset.updated_at >= $${values.push(input.filters.from)}::timestamptz`;
    if(input.filters?.to)sourceJoin+=` AND asset.updated_at <= $${values.push(input.filters.to)}::timestamptz`;
   }
   const bodyProjection=type==='content_asset'?',p.content_markdown AS source_body':',j.raw_content AS source_body,v.canonical_content_uri AS source_uri';
   return (await tx.query<EligibleBuild>(`SELECT b.*,to_char(b.created_at,'YYYY-MM-DD HH24:MI:SS.USOF') AS cursor_created_at${type==='content_asset'?',asset.content_asset_revision_id::text AS content_asset_revision_id':''}${includeBody?bodyProjection:''} FROM ${builds} b ${type==='file'?`JOIN workspaces w ON w.id=b.workspace_id AND w.user_id=b.user_id AND w.state='ready'`:''}
     ${sourceJoin} WHERE b.user_id=$1 AND b.source_type=ANY($2::text[]) AND ($3::text IS NULL OR b.source_id::text=$3)
     AND ($4::timestamptz IS NULL OR (b.created_at,b.id)<($4::timestamptz,$5::uuid))
     AND ($6::uuid[] IS NULL OR b.id=ANY($6::uuid[])) ${type==='file'?'AND (v.id IS NOT NULL OR j.id IS NOT NULL)':''}
     AND b.published AND b.status='ready' ORDER BY b.created_at DESC,b.id DESC LIMIT $7`,values)).rows;
  });
 }
 private async chunkPage(scope:Scope,sourceType:KbSourceType,builds:EligibleBuild[],size:number,cursor?:{buildId:string;ordinal:number}){
  return transaction(this.pool,async tx=>{await assertScope(tx,scope);const tables=tablesForSource(sourceType);
   return (await tx.query<ChunkRow>(`SELECT c.*,b.chunk_count FROM ${tables.chunks} c JOIN ${tables.builds} b ON b.id=c.build_id
    WHERE c.build_id=ANY($1::uuid[]) AND b.user_id=$2 AND b.published AND b.status='ready' AND c.index_status='ready'
    AND ($3::uuid IS NULL OR (c.build_id,c.ordinal)>($3::uuid,$4::integer))
    ORDER BY c.build_id,c.ordinal LIMIT $5`,[builds.map(b=>b.id),scope.userId,cursor?.buildId??null,cursor?.ordinal??null,size])).rows;
  });
 }
 async query(scope:Scope,input:RagQueryInput,timing=new SearchQueryTiming()):Promise<{mode:RagQueryMode;query:string;results:Array<Record<string,unknown>>}>{
  const query=input.query?.trim();if(!query||query.length>2000)throw new DomainError(400,'RAG_QUERY_INVALID');
  if(input.assetMode&&!['ids','links'].includes(input.assetMode))throw new DomainError(400,'RAG_ASSET_MODE_INVALID');
  const sourceType=input.sourceType??'content_asset';if(!['content_asset','file'].includes(sourceType))throw new DomainError(400,'RAG_SOURCE_TYPE_INVALID');
  const isContentAsset=sourceType==='content_asset';const mode=isContentAsset?input.mode??'hybrid':'keyword';
  if(isContentAsset&&!['dense','keyword','hybrid'].includes(mode))throw new DomainError(400,'RAG_QUERY_MODE_INVALID');
  const topK=Math.min(50,Math.max(1,input.topK??10));
  let builds=await timing.measure('pg_scope',()=>this.eligible(scope,input,sourceType));
  if(!builds.length)return {mode,query,results:[]};
  const selected=snapshotForSource(this.config,sourceType,'markdown');
  const validateBuilds=(page:EligibleBuild[])=>{
   if(page.some(b=>b.snapshot.target.connectionId!==selected.target.connectionId||b.snapshot.target.database!==selected.target.database||b.snapshot.target.collection!==selected.target.collection||b.snapshot.indexLayout!==selected.indexLayout))throw new DomainError(503,'KB_TARGET_CHANGED');
    if(isContentAsset&&page.some(b=>b.snapshot.embedding?.model!==CONTENT_ASSET_EMBEDDING_MODEL||b.snapshot.embedding.dimensions!==1024||b.snapshot.embedding.profile!==CONTENT_ASSET_EMBEDDING_PROFILE))throw new DomainError(503,'KB_PROFILE_CHANGED');
  };
  validateBuilds(builds);
  const lease=this.acquireIndex(selected),index=lease.index;
  const rerank=isContentAsset&&mode!=='keyword'?this.reranker():undefined;
  const reserve=selected.indexLayout==='sparse-v1'&&!rerank?Math.min(topK,10):0;
  const limit=Math.max(topK+reserve,mode==='keyword'?this.config.milvus.bm25Candidates:mode==='dense'?this.config.milvus.denseCandidates:this.config.milvus.hybridCandidates);
  const denseLimit=Math.max(topK+reserve,this.config.milvus.denseCandidates),keywordLimit=Math.max(topK+reserve,this.config.milvus.bm25Candidates);
  // ID-only responses let sparse collections amortize filter and RPC overhead.
  const pointPageSize=Math.max(selected.indexLayout==='sparse-v1'?512:256,limit,denseLimit,keywordLimit);
  type Hit=Awaited<ReturnType<KeywordIndex['searchKeyword']>>[number];
  type Candidate={hit:Hit;row:ChunkRow;build:EligibleBuild};
  const best=new Map<string,Candidate>(),denseBest=new Map<string,Candidate>(),keywordBest=new Map<string,Candidate>();
  try{
   await timing.measure('index_ready',()=>index.ensureReady());
   const embedQuery=async()=>{
    const tokenizer=await kbTokenizer(selected);if(await tokenizer.count(query)>tokenizer.maxInputTokens)throw new DomainError(400,'RAG_QUERY_TOO_LONG');
    const embedder=this.dependencies.embedding??kbEmbedding(this.config,selected);
    const vector=(await timing.measure('embedding',()=>embedder.embed([query],{textType:'query',onAttempt:a=>timing.embeddingAttempts.push(a)})))[0];
    if(!vector||vector.length!==1024)throw new DomainError(503,'KB_EMBEDDING_DIMENSION');
    return vector;
   };
   const prepareKeyword=mode!=='dense'?index.prepareKeywordSearch:undefined;
   const [embedding,keyword]=await Promise.allSettled([
    mode==='keyword'?undefined:embedQuery(),
    prepareKeyword?timing.measure('index_search',()=>index.prepareKeywordSearch!(query))
     :(options:Parameters<KeywordIndex['searchKeyword']>[1])=>index.searchKeyword(query,options),
   ]);
   if(embedding.status==='rejected')throw embedding.reason;
   if(keyword.status==='rejected')throw keyword.reason;
   const vector=embedding.value,searchKeyword=keyword.value;
   // Every source and current published point is visited with bounded SQL/recall
   // pages. Never search unversioned source IDs: stale/unpublished points can
   // otherwise consume the candidate budget before the authoritative recheck.
   while(builds.length){
    validateBuilds(builds);
    const byBuild=new Map(builds.map(b=>[b.id,b]));
    let cursor:{buildId:string;ordinal:number}|undefined;
    while(true){
     const rows=await timing.measure('pg_scope',()=>this.chunkPage(scope,sourceType,builds,pointPageSize,cursor));
     if(!rows.length)break;
     const byPoint=new Map(rows.map(row=>[row.point_id,row])),byWorkspace=new Map<string|undefined,ChunkRow[]>();
     for(const row of rows){const workspaceId=byBuild.get(row.build_id)!.workspace_id;const group=byWorkspace.get(workspaceId)??[];group.push(row);byWorkspace.set(workspaceId,group);}
     for(const [workspaceId,group]of byWorkspace){
      // Published PostgreSQL chunks authorize these point IDs independently of stored index labels.
      const recallScope={userId:scope.userId,...(workspaceId?{workspaceId}:{}),pointIds:group.map(row=>row.point_id)};
      const allowed=new Set(recallScope.pointIds);
      const collect=async(target:Map<string,Candidate>,budget:number,kind:'dense'|'keyword')=>{
       const options={scope:recallScope,limit:budget};
       const hits=await timing.measure('index_search',()=>kind==='keyword'?searchKeyword(options):requireIndexKind(index,'hybrid').search(vector!,options));
       for(const hit of hits){const row=byPoint.get(hit.chunkKey);if(!row||!allowed.has(hit.chunkKey)||!Number.isFinite(hit.score)||(hit.content===undefined?selected.indexLayout!=='sparse-v1':digest(hit.content)!==row.content_hash))continue;
        const previous=target.get(hit.chunkKey);if(!previous||previous.hit.score<hit.score)target.set(hit.chunkKey,{hit,row,build:byBuild.get(row.build_id)!});
       }
       const ranked=[...target.values()].sort((a,b)=>b.hit.score-a.hit.score||a.hit.chunkKey.localeCompare(b.hit.chunkKey));
       for(const discarded of ranked.slice(budget))target.delete(discarded.hit.chunkKey);
      };
      if(mode==='hybrid'){
       const results=await Promise.allSettled([collect(denseBest,denseLimit,'dense'),collect(keywordBest,keywordLimit,'keyword')]);
       for(const result of results)if(result.status==='rejected')throw result.reason;
      }else await collect(best,limit,mode==='dense'?'dense':'keyword');
     }
     if(rows.length<pointPageSize)break;
     const last=rows.at(-1)!;cursor={buildId:last.build_id,ordinal:last.ordinal};
    }
    if(builds.length<sourcePageSize)break;
    const last=builds.at(-1)!;builds=await timing.measure('pg_scope',()=>this.eligible(scope,input,sourceType,{cursor:{createdAt:last.cursor_created_at,id:last.id}}));
   }
   if(mode==='hybrid'){
    const fused=fuseRankedRecall([[...denseBest.values()].map(c=>c.hit),[...keywordBest.values()].map(c=>c.hit)],limit,this.config.milvus.rrfK);
    for(const hit of fused){const candidate=denseBest.get(hit.chunkKey)??keywordBest.get(hit.chunkKey)!;best.set(hit.chunkKey,{...candidate,hit});}
   }
   // Source lookup, not a duplicate chunk-text column, is the authority.
   const shortlist=[...best.values()].sort((a,b)=>b.hit.score-a.hit.score||a.hit.chunkKey.localeCompare(b.hit.chunkKey));
   const loaded=new Map<string,string|null>();
   const hydrate=async(batch:Candidate[])=>timing.measure('pg_hydrate',async()=>{
    const missing=[...new Set(batch.map(({build})=>build.id).filter(id=>!loaded.has(id)))];
    if(missing.length){
     const bodies=new Map((await this.eligible(scope,input,sourceType,{ids:missing,includeBody:true})).map(build=>[build.id,build]));
     for(const id of missing){
      const body=bodies.get(id);
      let source:string|null=null;
      if(body&&(body.source_body!=null||body.source_uri)){
       try{source=await readSourceBody(this.config,body.content_hash,{content:body.source_body,uri:body.source_uri});}
       catch(error){
        const reason=error as {message?:string;code?:string;name?:string};
        if(reason?.message!=='KB_BODY_CHANGED'&&reason?.code!=='ENOENT'&&reason?.name!=='NoSuchKey')throw error;
       }
      }
      loaded.set(id,source);
     }
    }
    const hydrated:RagSearchCandidate[]=[];
    for(const {hit:h,row,build:b} of batch){
     const source=loaded.get(b.id);
     if(source==null||row.source_start<0||row.source_end>source.length||row.source_start>=row.source_end)continue;
     const content=source.slice(row.source_start,row.source_end);
     if(digest(content)!==row.content_hash||(h.content!==undefined&&content!==h.content))continue;
     hydrated.push({chunkKey:row.point_id,documentKey:b.source_id,parentId:b.source_id,content,chunkIndex:row.ordinal,chunkCount:b.chunk_count,denseScore:mode==='dense'?h.score:0,keywordScore:mode==='keyword'?h.score:0,rrfScore:mode==='hybrid'?h.score:0,metadata:{buildId:b.id,sourceRevision:b.source_revision,contentAssetRevisionId:b.content_asset_revision_id,sourceStart:row.source_start,sourceEnd:row.source_end,part:isContentAsset?'raw':null}});
    }
    return hydrated;
   });
   let ranked:RagSearchCandidate[]=[];
   let current=new Map<string,EligibleBuild>();
   const recheck=async()=>{
    const buildIds=[...new Set(ranked.map(c=>String(c.metadata!.buildId)))];
    current=new Map((buildIds.length?await timing.measure('pg_recheck',()=>this.eligible(scope,input,sourceType,{ids:buildIds})):[]).map(b=>[b.id,b]));
    ranked=ranked.filter(c=>current.get(String(c.metadata!.buildId))?.source_revision===c.metadata!.sourceRevision);
   };
   if(rerank&&shortlist.length){
    ranked=await hydrate(shortlist);
    if(ranked.length){
     const result=await timing.measure('rerank',()=>rerankWithinBudget(rerank,query,ranked,this.config.rag.contentAssetRerankBudgetMs));
     ranked=result.candidates;
     if(result.fallback)timing.fallback=result.fallback;
    }
    await recheck();
   }else{
    let offset=0;
    while(offset<shortlist.length&&ranked.length<topK){
     const count=topK-ranked.length;
     ranked.push(...await hydrate(shortlist.slice(offset,offset+count)));
     offset+=count;
     await recheck();
    }
   }
   // Only final, rechecked topK chunks can request images. UUIDs stay in the
   // evidence; expiring URLs are a separate view, never rerank input or offsets.
   const parsed=new Map<string,KbImage[]>(),requests=new Map<string,RagImageRequest>();
   const selectedChunks=ranked.slice(0,topK).map(c=>{
    const build=current.get(String(c.metadata!.buildId))!;
    let all=parsed.get(build.id);
    if(!all){all=kbImages(loaded.get(build.id)!);parsed.set(build.id,all);}
    const start=Number(c.metadata!.sourceStart),end=Number(c.metadata!.sourceEnd);
    const images=all.filter(image=>image.nodeStart<end&&image.nodeEnd>start).map(image=>{
     const request={sourceType:build.source_type,sourceId:build.source_id,...(build.workspace_id?{workspaceId:build.workspace_id}:{}),sourceRevision:build.source_revision,resourceId:image.resourceId};
     requests.set(ragImageKey(request),request);return {image,request};
    });
    return {c,build,start,end,images};
   });
   const links=input.assetMode==='links'&&requests.size&&this.dependencies.resolveImages?await this.dependencies.resolveImages(scope,[...requests.values()]):new Map<string,RagImageLink>();
   const results=selectedChunks.map(({c,build,start,end,images})=>{
    const replacements=new Map(images.flatMap(({image,request})=>{const link=links.get(ragImageKey(request));return link?[[image.resourceId,link.url] as const]:[];}));
    const localImages=images.map(({image})=>image).filter(image=>image.nodeStart>=start&&image.nodeEnd<=end).map(image=>({...image,nodeStart:image.nodeStart-start,nodeEnd:image.nodeEnd-start,contentStart:image.contentStart-start,contentEnd:image.contentEnd-start}));
    return {...c,chunkId:c.chunkKey,sourceType:build.source_type,sourceRevision:c.metadata!.sourceRevision,sourceStart:start,sourceEnd:end,part:isContentAsset?'raw':null,revisionId:isContentAsset?build.content_asset_revision_id:c.metadata!.sourceRevision,...(isContentAsset?{partRevisionId:c.metadata!.sourceRevision}:{}),
     images:images.map(({image,request})=>({resourceId:request.resourceId,alt:image.alt,sourceStart:image.nodeStart,sourceEnd:image.nodeEnd,...links.get(ragImageKey(request))})),
     ...(input.assetMode==='links'?{displayMarkdown:renderKbImages(c.content,localImages,replacements)}:{}),evidence:{child:c.content},context:null};
   });
   return {mode,query,results};
  }catch(e){if(e instanceof DomainError)throw e;throw new DomainError(503,'RAG_SEARCH_UNAVAILABLE',false,{cause:e});}
  finally{await lease.release();}
 }
}
