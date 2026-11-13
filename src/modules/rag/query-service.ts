import type pg from 'pg';
import type {AppConfig} from '../../config/config.js';
import {DomainError,assertScope,transaction,type Scope} from '../identity/store.js';
import {kbSnapshot,kbEmbedding,kbTokenizer,knowledgeIndex,type IndexFactory} from '../kb/profile.js';
import {sourceContent} from '../kb/repository.js';
import {tablesFor,type KbBuild,type KbSourceType,type HybridIndex} from '../kb/types.js';
import {digest} from '../kb/split.js';
import type {EmbeddingClient} from './adapters/embedding.js';
import {HttpRerankAdapter,MockRerankAdapter,rerankWithinBudget,type RerankAdapter,type RagSearchCandidate} from './search.js';
import {NoteQueryTiming} from './query-timing.js';
export type RagQueryMode='keyword'|'dense'|'hybrid';
export interface RagQueryInput{query:string;mode?:RagQueryMode;sourceType?:KbSourceType;topK?:number;documentKey?:string;workspaceId?:string;filters?:{folderIds?:string[];tagIds?:string[];sourceKinds?:string[];from?:string;to?:string;};}
export interface RagQueryDependencies{embedding?:EmbeddingClient;index?:IndexFactory;rerank?:RerankAdapter;resolveAssets?:(content:string,id:string,scope:Scope)=>Promise<string>;resolveTextAssets?:(content:string,id:string,scope:Scope)=>Promise<string>;}
interface ChunkRow{build_id:string;point_id:string;ordinal:number;source_start:number;source_end:number;content_hash:string;chunk_count:number;}
export class RagQueryService {
 private indexes=new Map<string,HybridIndex>();private fallbackTotal=0;
 private readonly rerank:RerankAdapter|undefined;
 constructor(private readonly pool:pg.Pool,private readonly config:AppConfig,private readonly dependencies:RagQueryDependencies={}){
  this.rerank=dependencies.rerank??(config.rag.rerankProvider==='mock'?new MockRerankAdapter():config.rag.rerankProvider==='http'?new HttpRerankAdapter({baseUrl:config.rag.rerankBaseUrl!,apiKey:config.rag.rerankApiKey,model:config.rag.rerankModel,timeoutMs:config.rag.rerankTimeoutMs}):undefined);
 }
 async close(){for(const index of this.indexes.values())await index.close();this.indexes.clear();}
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
  const targetKey=JSON.stringify(selected.target);
  let index=this.indexes.get(targetKey);if(!index){index=this.dependencies.index?.(selected)??knowledgeIndex(this.config,selected);this.indexes.set(targetKey,index);}
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
   if(note&&mode!=='keyword'&&this.rerank&&candidates.length){const result=await timing.measure('rerank',()=>rerankWithinBudget(this.rerank!,query,candidates,this.config.rag.noteRerankBudgetMs));ranked=result.candidates;if(result.fallback){timing.fallback=result.fallback;this.fallbackTotal++;}timing.fallbackTotal=this.fallbackTotal;}
   const current=new Map((await timing.measure('pg_recheck',()=>this.eligible(scope,input,sourceType))).map(b=>[b.id,b]));
   const results=[];
   for(const c of ranked.filter(c=>current.has(String(c.metadata!.buildId))).slice(0,topK)){
    const renderer=sourceType==='text'?this.dependencies.resolveTextAssets:sourceType==='file'?this.dependencies.resolveAssets:undefined;
    const content=renderer?await renderer(c.content,c.parentId!,scope):c.content;
    results.push({...c,chunkId:c.chunkKey,sourceType,sourceRevision:c.metadata!.sourceRevision,sourceStart:c.metadata!.sourceStart,sourceEnd:c.metadata!.sourceEnd,part:note?'raw':null,revisionId:note?current.get(String(c.metadata!.buildId))!.note_revision_id:c.metadata!.sourceRevision,...(note?{partRevisionId:c.metadata!.sourceRevision}:{}),content,evidence:{child:content},context:null});
   }
   return {mode,query,results};
  }catch(e){if(e instanceof DomainError)throw e;throw new DomainError(503,'RAG_SEARCH_UNAVAILABLE');}
 }
}
