import type pg from 'pg';
import type {AppConfig} from '../../config/config.js';
import {DomainError,assertScope,transaction,type Scope} from '../identity/store.js';
import {snapshotForSource,kbEmbedding,kbTokenizer,knowledgeIndex,type IndexFactory} from '../kb/profile.js';
import {listPublishedBuilds,listPublishedChunks,readSourceBody,type KbBuildFilters,type KbChunkCursor,type KbPublishedBuild,type KbPublishedChunk} from '../kb/read.js';
import type {KbSourceType,KbSnapshot} from '../kb/types.js';
import type {HybridIndex,KeywordIndex,RecallFilter,SearchOptions} from '../../lib/search-index/types.js';
import {requireIndexKind} from '../../lib/search-index/factory.js';
import {digest} from '../../lib/crypto.js';
import type {EmbeddingClient} from '../../integrations/embedding.js';
import {HttpRerankAdapter,MockRerankAdapter,rerankWithinBudget,fuseRankedRecall,type RerankAdapter,type RagSearchCandidate} from './search.js';
import {SearchQueryTiming} from './query-timing.js';
import { assetKinds } from '../../contracts/asset-kind.js';
import {kbImages,renderKbImages,type KbImage} from '../../lib/kb-images.js';
export type RagQueryMode='keyword'|'dense'|'hybrid';
export interface RagQueryInput extends KbBuildFilters {query:string;mode?:RagQueryMode;sourceType?:'content_asset'|'file';topK?:number;assetMode?:'ids'|'links';}
export interface RagImageRequest{sourceType:KbSourceType;sourceId:string;workspaceId?:string;sourceRevision:string;resourceId:string;}
export interface RagImageLink{url:string;expiresAt:string;}
export const ragImageKey=(image:RagImageRequest)=>JSON.stringify([image.sourceType,image.sourceId,image.workspaceId,image.sourceRevision,image.resourceId]);
export interface RagQueryDependencies{embedding?:EmbeddingClient;index?:IndexFactory;rerank?:RerankAdapter;resolveImages?:(scope:Scope,images:RagImageRequest[])=>Promise<ReadonlyMap<string,RagImageLink>>;}
const sourcePageSize=128;
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
 async query(scope:Scope,input:RagQueryInput,timing=new SearchQueryTiming()):Promise<{mode:RagQueryMode;query:string;results:Array<Record<string,unknown>>}>{
  const query=input.query?.trim();if(!query||query.length>2000)throw new DomainError(400,'RAG_QUERY_INVALID');
  if(input.assetMode&&!['ids','links'].includes(input.assetMode))throw new DomainError(400,'RAG_ASSET_MODE_INVALID');
  const sourceType=input.sourceType??'content_asset';if(!['content_asset','file'].includes(sourceType))throw new DomainError(400,'RAG_SOURCE_TYPE_INVALID');
  const isContentAsset=sourceType==='content_asset';const mode=isContentAsset?input.mode??'hybrid':'keyword';
  if(isContentAsset&&!['dense','keyword','hybrid'].includes(mode))throw new DomainError(400,'RAG_QUERY_MODE_INVALID');
  const topK=Math.min(50,Math.max(1,input.topK??10));
  const filters=input.filters;
  const timeField=filters?.timeField??'updated_at';
  const from=filters?.from?Date.parse(filters.from):undefined,to=filters?.to?Date.parse(filters.to):undefined;
  if(isContentAsset&&(!['created_at','updated_at'].includes(timeField)||[from,to].some(n=>n!==undefined&&!Number.isFinite(n))||(from!==undefined&&to!==undefined&&from>to)))throw new DomainError(400,'SEARCH_DATE_INVALID');
  if(isContentAsset&&filters?.assetKinds?.some(kind=>!assetKinds.includes(kind)))throw new DomainError(400,'SEARCH_ASSET_KIND_INVALID');
  const buildLookup={sourceType,input,limit:sourcePageSize};
  let builds:KbPublishedBuild[]=[];
  if(isContentAsset){
   await transaction(this.pool,tx=>assertScope(tx,scope));
   if(!this.config.milvus.address&&!this.dependencies.index){
    if(!this.config.kb.contentAssetEnabled)return {mode,query,results:[]};
    throw new DomainError(503,'RAG_SEARCH_UNAVAILABLE');
   }
  }
  else{
   builds=await timing.measure('pg_scope',()=>listPublishedBuilds(this.pool,scope,buildLookup));
   if(!builds.length)return {mode,query,results:[]};
  }
  const selected=snapshotForSource(this.config,sourceType,'markdown');
  const validateBuilds=(page:KbPublishedBuild[])=>{
   if(page.some(b=>b.snapshot.target.connectionId!==selected.target.connectionId||b.snapshot.target.database!==selected.target.database||b.snapshot.target.collection!==selected.target.collection||b.snapshot.indexLayout!==selected.indexLayout))throw new DomainError(503,'KB_TARGET_CHANGED');
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
  type Candidate={hit:Hit;row:KbPublishedChunk;build:KbPublishedBuild};
  const best=new Map<string,Candidate>();
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
   if(isContentAsset){
    const filter:RecallFilter={
     ...(input.documentKey?{sourceIds:[input.documentKey]}:{}),
     ...(filters?.assetKinds?.length?{assetKinds:filters.assetKinds}:{}),
     ...(from!==undefined||to!==undefined?{time:{field:timeField,from,to}}:{}),
    };
    const options:SearchOptions={scope:{userId:scope.userId,accountWide:true},filter,limit};
    const recall=(kind:'keyword'|'dense',budget:number)=>timing.measure('index_search',()=>kind==='keyword'
     ?searchKeyword({...options,limit:budget}):requireIndexKind(index,'hybrid').search(vector!,{...options,limit:budget}));
    let denseBudget=denseLimit,keywordBudget=keywordLimit,budget=limit;
    while(true){
     const recalls=mode==='hybrid'?await Promise.all([recall('dense',denseBudget),recall('keyword',keywordBudget)])
      :[await recall(mode,budget)];
     const ids=[...new Set(recalls.flatMap(hits=>hits.filter(hit=>Number.isFinite(hit.score)).map(hit=>hit.chunkKey)))];
     if(!ids.length)break;
     const matches=await timing.measure('pg_hydrate',()=>listPublishedBuilds(this.pool,scope,{...buildLookup,match:{pointIds:ids,target:selected.target}}));
     const byId=new Map(matches.map(build=>[build.chunk!.point_id,build]));
     const currentRecalls=recalls.map(items=>items.filter(hit=>byId.has(hit.chunkKey)));
     const hits=mode==='hybrid'?fuseRankedRecall(currentRecalls,limit,this.config.milvus.rrfK):currentRecalls[0]!.slice(0,limit);
     best.clear();
     for(const hit of hits){
      const build=byId.get(hit.chunkKey),row=build?.chunk;
      if(build&&row&&Number.isFinite(hit.score)&&(hit.content===undefined||digest(hit.content)===row.content_hash))best.set(hit.chunkKey,{hit,row,build});
     }
     const hasMore=recalls.some((items,i)=>items.length>=(mode==='hybrid'?(i===0?denseBudget:keywordBudget):budget));
     if(best.size>=topK||!hasMore||budget>=1000)break;
     budget=Math.min(budget*2,1000);denseBudget=Math.min(denseBudget*2,1000);keywordBudget=Math.min(keywordBudget*2,1000);
    }
   }
   // Independent document collections retain workspace-scoped point pages.
   while(builds.length){
    validateBuilds(builds);
    const byBuild=new Map(builds.map(b=>[b.id,b]));
    const chunkLookup={sourceType,buildIds:builds.map(build=>build.id),limit:pointPageSize};
    let cursor:KbChunkCursor|undefined;
    while(true){
     const rows=await timing.measure('pg_scope',()=>listPublishedChunks(this.pool,scope,{...chunkLookup,cursor}));
     if(!rows.length)break;
     const byPoint=new Map(rows.map(row=>[row.point_id,row])),byWorkspace=new Map<string|undefined,KbPublishedChunk[]>();
     for(const row of rows){const workspaceId=byBuild.get(row.build_id)!.workspace_id;const group=byWorkspace.get(workspaceId)??[];group.push(row);byWorkspace.set(workspaceId,group);}
     for(const [workspaceId,group]of byWorkspace){
      // Published PostgreSQL chunks authorize these point IDs independently of stored index labels.
      const recallScope={userId:scope.userId,...(workspaceId?{workspaceId}:{}),pointIds:group.map(row=>row.point_id)};
      const hits=await timing.measure('index_search',()=>searchKeyword({scope:recallScope,limit}));
      for(const hit of hits){
       const row=byPoint.get(hit.chunkKey),build=row?byBuild.get(row.build_id):undefined;
       if(!row||!build||build.workspace_id!==workspaceId||!Number.isFinite(hit.score)||
        (hit.content===undefined?selected.indexLayout!=='sparse-v1':digest(hit.content)!==row.content_hash))continue;
       const previous=best.get(hit.chunkKey);
       if(!previous||previous.hit.score<hit.score)best.set(hit.chunkKey,{hit,row,build});
      }
      const ranked=[...best.values()].sort((a,b)=>b.hit.score-a.hit.score||a.hit.chunkKey.localeCompare(b.hit.chunkKey));
      for(const discarded of ranked.slice(limit))best.delete(discarded.hit.chunkKey);
     }
     if(rows.length<pointPageSize)break;
     const last=rows.at(-1)!;cursor={buildId:last.build_id,ordinal:last.ordinal};
    }
    if(builds.length<sourcePageSize)break;
    const last=builds.at(-1)!;builds=await timing.measure('pg_scope',()=>listPublishedBuilds(this.pool,scope,{...buildLookup,cursor:{createdAt:last.cursor_created_at,id:last.id}}));
   }
   // Source lookup, not a duplicate chunk-text column, is the authority.
   const shortlist=[...best.values()].sort((a,b)=>b.hit.score-a.hit.score||a.hit.chunkKey.localeCompare(b.hit.chunkKey));
   const loaded=new Map<string,string|null>();
   const hydrate=async(batch:Candidate[])=>timing.measure('pg_hydrate',async()=>{
    const missing=[...new Set(batch.map(({build})=>build.id).filter(id=>!loaded.has(id)))];
    if(missing.length){
     const bodies=new Map((await listPublishedBuilds(this.pool,scope,{...buildLookup,ids:missing,includeBody:true})).map(build=>[build.id,build]));
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
   let current=new Map<string,KbPublishedBuild>();
   const recheck=async()=>{
    const buildIds=[...new Set(ranked.map(c=>String(c.metadata!.buildId)))];
    current=new Map((buildIds.length?await timing.measure('pg_recheck',()=>listPublishedBuilds(this.pool,scope,{...buildLookup,ids:buildIds})):[]).map(b=>[b.id,b]));
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
