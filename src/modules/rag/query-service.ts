import type pg from 'pg';
import type {AppConfig} from '../../config/config.js';
import {DomainError,assertScope,transaction,type Scope} from '../identity/store.js';
import {kbSnapshot,kbEmbedding,kbTokenizer,knowledgeIndex,type IndexFactory} from '../kb/profile.js';
import {sourceContent} from '../kb/repository.js';
import {tablesFor,type KbBuild,type KbSourceType,type KbSnapshot,type HybridIndex} from '../kb/types.js';
import {digest} from '../kb/split.js';
import type {EmbeddingClient} from './adapters/embedding.js';
import {HttpRerankAdapter,MockRerankAdapter,rerankWithinBudget,type RerankAdapter,type RagSearchCandidate} from './search.js';
import {NoteQueryTiming} from './query-timing.js';
import {imageResourceId,markdownImages,rewriteImageUrls,type MarkdownImage} from '../../lib/markdown-images.js';
export type RagQueryMode='keyword'|'dense'|'hybrid';
export interface RagQueryInput{query:string;mode?:RagQueryMode;sourceType?:KbSourceType;topK?:number;documentKey?:string;workspaceId?:string;assetMode?:'ids'|'links';filters?:{folderIds?:string[];tagIds?:string[];sourceKinds?:string[];from?:string;to?:string;};}
export interface RagImageRequest{sourceType:KbSourceType;sourceId:string;workspaceId:string;sourceRevision:string;resourceId:string;}
export interface RagImageLink{url:string;expiresAt:string;}
export const ragImageKey=(image:RagImageRequest)=>JSON.stringify([image.sourceType,image.sourceId,image.workspaceId,image.sourceRevision,image.resourceId]);
export interface RagQueryDependencies{embedding?:EmbeddingClient;index?:IndexFactory;rerank?:RerankAdapter;resolveImages?:(scope:Scope,images:RagImageRequest[])=>Promise<ReadonlyMap<string,RagImageLink>>;}
interface ChunkRow{build_id:string;point_id:string;ordinal:number;source_start:number;source_end:number;content_hash:string;chunk_count:number;}
export class RagQueryService {
 private indexes=new Map<string,{target:string;index:HybridIndex;active:number;revision:number;retired:boolean}>();private fallbackTotal=0;
 constructor(private readonly pool:pg.Pool,private readonly config:AppConfig,private readonly dependencies:RagQueryDependencies={}){}
 private reranker():RerankAdapter|undefined{
  const config=this.config;
  return this.dependencies.rerank??(config.rag.rerankProvider==='mock'?new MockRerankAdapter():config.rag.rerankProvider==='http'?new HttpRerankAdapter({baseUrl:config.rag.rerankBaseUrl!,apiKey:config.rag.rerankApiKey,model:config.rag.rerankModel,timeoutMs:config.rag.rerankTimeoutMs}):undefined);
 }
 private acquireIndex(snapshot:KbSnapshot){
  const target=JSON.stringify(snapshot.target),tuning=this.config.milvus;
  const key=JSON.stringify([target,tuning.searchConcurrency,tuning.denseCandidates,tuning.bm25Candidates,tuning.hybridCandidates,tuning.rrfK]);
  let entry=this.indexes.get(key);
  if(!entry){entry={target,index:this.dependencies.index?.(snapshot)??knowledgeIndex(this.config,snapshot),active:0,revision:this.config.runtimeRevision,retired:false};this.indexes.set(key,entry);}
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
 private async eligible(scope:Scope,input:RagQueryInput,type:KbSourceType){
  const {builds}=tablesFor(type==='note'?'note-hybrid':'document-keyword');
  return transaction(this.pool,async tx=>{await assertScope(tx,scope);
   const values:unknown[]=[scope.userId,type,input.documentKey??null,input.workspaceId??null];
   let sourceJoin=type==='note'?`JOIN notes n ON n.note_id=b.source_id AND n.workspace_id=b.workspace_id AND n.state='active' AND n.processing_status='ready'
     JOIN LATERAL(SELECT part_revision_id FROM note_part_revisions WHERE note_id=n.note_id AND part='raw' ORDER BY revision DESC LIMIT 1)p ON p.part_revision_id::text=b.source_revision`
    :type==='file'?`JOIN rag_ingestion_versions v ON v.id=b.source_id AND v.user_id=b.user_id AND v.workspace_id=b.workspace_id AND v.content_hash=b.source_revision AND v.active AND v.deleted_at IS NULL AND v.status='SUCCEEDED'`
    :`JOIN text_ingestion_jobs j ON j.id=b.source_id AND j.created_by=b.user_id AND j.workspace_id=b.workspace_id AND j.content_hash=b.source_revision AND j.ingest_status='success'`;
   if(type==='note'){
    for(const [ids,condition] of [[input.filters?.folderIds,'n.folder_id'],[input.filters?.sourceKinds,'n.source_kind']] as const)if(ids?.length)sourceJoin+=` AND ${condition}=ANY($${values.push(ids)}::${condition==='n.folder_id'?'uuid':'text'}[])`;
    if(input.filters?.tagIds?.length)sourceJoin+=` AND EXISTS(SELECT 1 FROM note_tags nt JOIN asset_tags at ON at.tag_id=nt.tag_id AND at.workspace_id=b.workspace_id WHERE nt.note_id=n.note_id AND nt.tag_id=ANY($${values.push(input.filters.tagIds)}::uuid[]))`;
    if(input.filters?.from)sourceJoin+=` AND n.updated_at >= $${values.push(input.filters.from)}::timestamptz`;
    if(input.filters?.to)sourceJoin+=` AND n.updated_at <= $${values.push(input.filters.to)}::timestamptz`;
   }
   const result=await tx.query<KbBuild>(`SELECT b.*${type==='note'?',n.note_revision_id::text AS note_revision_id':''} FROM ${builds} b JOIN workspaces w ON w.id=b.workspace_id AND w.user_id=b.user_id AND w.state='ready'
     ${sourceJoin} WHERE b.user_id=$1 AND b.source_type=$2 AND ($3::text IS NULL OR b.source_id::text=$3)
     AND ($4::uuid IS NULL OR b.workspace_id=$4) AND b.published AND b.status='ready' ORDER BY b.created_at DESC LIMIT 200`,values);
   return result.rows;
  });
 }
 async query(scope:Scope,input:RagQueryInput,timing=new NoteQueryTiming()):Promise<{mode:RagQueryMode;query:string;results:Array<Record<string,unknown>>}>{
  const query=input.query?.trim();if(!query||query.length>2000)throw new DomainError(400,'RAG_QUERY_INVALID');
  if(input.assetMode&&!['ids','links'].includes(input.assetMode))throw new DomainError(400,'RAG_ASSET_MODE_INVALID');
  const sourceType=input.sourceType??'note';if(!['note','file','text'].includes(sourceType))throw new DomainError(400,'RAG_SOURCE_TYPE_INVALID');
  const note=sourceType==='note';const mode=note?input.mode??'hybrid':'keyword';
  if(note&&!['dense','keyword','hybrid'].includes(mode))throw new DomainError(400,'RAG_QUERY_MODE_INVALID');
  const topK=Math.min(50,Math.max(1,input.topK??10));
  const builds=await timing.measure('pg_scope',()=>this.eligible(scope,input,sourceType));
  if(!builds.length)return {mode,query,results:[]};
  const selected=kbSnapshot(this.config,note?'note-hybrid':'document-keyword','markdown');
  if(builds.some(b=>b.snapshot.target.connectionId!==selected.target.connectionId||b.snapshot.target.database!==selected.target.database||b.snapshot.target.collection!==selected.target.collection))throw new DomainError(503,'KB_TARGET_CHANGED');
  if(note&&builds.some(b=>b.snapshot.embedding?.model!=='BAAI/bge-m3'||b.snapshot.embedding.dimensions!==1024||b.snapshot.embedding.profile!=='bge-m3-1024'))throw new DomainError(503,'KB_PROFILE_CHANGED');
  const rows=await transaction(this.pool,async tx=>{await assertScope(tx,scope);const {chunks}=tablesFor(selected.mode);return (await tx.query<ChunkRow>(`SELECT c.*,b.chunk_count FROM ${chunks} c JOIN ${tablesFor(selected.mode).builds} b ON b.id=c.build_id WHERE c.build_id=ANY($1::uuid[]) AND b.published AND b.status='ready' AND c.index_status='ready'`,[builds.map(b=>b.id)])).rows;});
  if(!rows.length)return {mode,query,results:[]};
  const lease=this.acquireIndex(selected),index=lease.index;
  const limit=Math.max(topK,mode==='keyword'?this.config.milvus.bm25Candidates:this.config.milvus.hybridCandidates);
  try{
   await timing.measure('milvus_ready',()=>index.ensureReady());
   const byWorkspace=new Map<string,ChunkRow[]>();const byBuild=new Map(builds.map(b=>[b.id,b]));
   for(const row of rows){const b=byBuild.get(row.build_id)!;const group=byWorkspace.get(b.workspace_id)??[];group.push(row);byWorkspace.set(b.workspace_id,group);}
   let vector:number[]|undefined;
   if(mode!=='keyword'){
    const tokenizer=await kbTokenizer(selected);if(await tokenizer.count(query)>8192)throw new DomainError(400,'RAG_QUERY_TOO_LONG');
    const embedder=this.dependencies.embedding??kbEmbedding(this.config,selected);
    vector=(await timing.measure('embedding',()=>embedder.embed([query],{onAttempt:a=>timing.embeddingAttempts.push(a)})))[0];
    if(!vector||vector.length!==1024)throw new DomainError(503,'KB_EMBEDDING_DIMENSION');
   }
   const hits=[];
   for(const [workspaceId,group] of byWorkspace){const options={scope:{userId:scope.userId,workspaceId,pointIds:group.map(c=>c.point_id)},limit};
    hits.push(...await timing.measure('milvus_search',()=>mode==='keyword'?index!.searchKeyword(query,options):mode==='dense'?index!.search(vector!,options):index!.hybridSearch(vector!,query,options)));
   }
   const best=new Map<string,(typeof hits)[number]>();for(const h of hits)if(!best.has(h.chunkKey)||best.get(h.chunkKey)!.score<h.score)best.set(h.chunkKey,h);
   // Source lookup, not a duplicate chunk-text column, is the authority.
   const loaded=new Map<string,Awaited<ReturnType<typeof sourceContent>>>();
   const candidates:RagSearchCandidate[]=[];
   await timing.measure('pg_hydrate',async()=>{
    for(const h of [...best.values()].sort((a,b)=>b.score-a.score).slice(0,limit)){
     const row=rows.find(r=>r.point_id===h.chunkKey);if(!row)continue;const b=byBuild.get(row.build_id)!;
     try{let source=loaded.get(b.id);if(!source){source=await sourceContent(this.pool,this.config,b);loaded.set(b.id,source);}
      const content=source.content.slice(row.source_start,row.source_end);if(digest(content)!==row.content_hash||content!==h.content)continue;
      candidates.push({chunkKey:row.point_id,documentKey:b.source_id,parentId:b.source_id,content,chunkIndex:row.ordinal,chunkCount:b.chunk_count,denseScore:mode==='dense'?h.score:0,keywordScore:mode==='keyword'?h.score:0,rrfScore:mode==='hybrid'?h.score:0,metadata:{buildId:b.id,sourceRevision:b.source_revision,noteRevisionId:b.note_revision_id,sourceStart:row.source_start,sourceEnd:row.source_end,part:note?'raw':null}});
     }catch(e){if(!(e instanceof DomainError))throw e;}
    }
   });
   let ranked=candidates;
   const rerank=note&&mode!=='keyword'?this.reranker():undefined;
   if(rerank&&candidates.length){const result=await timing.measure('rerank',()=>rerankWithinBudget(rerank,query,candidates,this.config.rag.noteRerankBudgetMs));ranked=result.candidates;if(result.fallback){timing.fallback=result.fallback;this.fallbackTotal++;}timing.fallbackTotal=this.fallbackTotal;}
   const current=new Map((await timing.measure('pg_recheck',()=>this.eligible(scope,input,sourceType))).map(b=>[b.id,b]));
   // Only final, rechecked topK chunks can request images. UUIDs stay in the
   // evidence; expiring URLs are a separate view, never rerank input or offsets.
   const parsed=new Map<string,MarkdownImage[]>(),requests=new Map<string,RagImageRequest>();
   const selectedChunks=ranked.filter(c=>current.has(String(c.metadata!.buildId))).slice(0,topK).map(c=>{
    const build=current.get(String(c.metadata!.buildId))!;
    let all=parsed.get(build.id);
    if(!all){try{all=markdownImages(loaded.get(build.id)!.content);}catch{all=[];}parsed.set(build.id,all);}
    const start=Number(c.metadata!.sourceStart),end=Number(c.metadata!.sourceEnd);
    const images=all.filter(image=>image.nodeStart<end&&image.nodeEnd>start&&imageResourceId(image.url)).map(image=>{
     const request={sourceType,sourceId:build.source_id,workspaceId:build.workspace_id,sourceRevision:build.source_revision,resourceId:imageResourceId(image.url)!};
     requests.set(ragImageKey(request),request);return {image,request};
    });
    return {c,build,start,end,images};
   });
   const links=input.assetMode==='links'&&requests.size&&this.dependencies.resolveImages?await this.dependencies.resolveImages(scope,[...requests.values()]):new Map<string,RagImageLink>();
   const results=selectedChunks.map(({c,build,start,end,images})=>{
    const replacements=new Map(images.flatMap(({image,request})=>{const link=links.get(ragImageKey(request));return link?[[image.url,link.url] as const]:[];}));
    const localImages=images.map(({image})=>image).filter(image=>image.start>=start&&image.end<=end).map(image=>({...image,start:image.start-start,end:image.end-start}));
    return {...c,chunkId:c.chunkKey,sourceType,sourceRevision:c.metadata!.sourceRevision,sourceStart:start,sourceEnd:end,part:note?'raw':null,revisionId:note?build.note_revision_id:c.metadata!.sourceRevision,...(note?{partRevisionId:c.metadata!.sourceRevision}:{}),
     images:images.map(({image,request})=>({resourceId:request.resourceId,alt:image.alt,sourceStart:image.nodeStart,sourceEnd:image.nodeEnd,...links.get(ragImageKey(request))})),
     ...(input.assetMode==='links'?{displayMarkdown:rewriteImageUrls(c.content,localImages,replacements)}:{}),evidence:{child:c.content},context:null};
   });
   return {mode,query,results};
  }catch(e){if(e instanceof DomainError)throw e;throw new DomainError(503,'RAG_SEARCH_UNAVAILABLE',false,{cause:e});}
  finally{await lease.release();}
 }
}
