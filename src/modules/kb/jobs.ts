import {digest} from '../../lib/crypto.js';
import pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import type { Attempt } from '../tasks/execution.js';
import { DomainError,transaction } from '../identity/store.js';
import { indexChunks, type BoundVectorStoreAdapter } from '../../lib/rag-indexing/index.js';
import type { EmbeddingAdapter } from '../../lib/rag-indexing/index.js';
import { indexKeywordChunks } from '../../lib/search-index/keyword-indexing.js';
import { requireIndexKind } from '../../lib/search-index/factory.js';
import type { HybridIndex, KeywordIndex } from '../../lib/search-index/types.js';
import { splitKnowledgeContent,type KbDraft } from './split.js';
import { kbTokenizer,kbEmbedding,knowledgeIndex,type IndexFactory } from './profile.js';
import { createBuild,sourceContent,sourceState } from './repository.js';
import { tablesForSource,type KbBuild,type KbSource,type KbSnapshot,type KbSourceType } from './types.js';
import type { TokenCounter } from '../../lib/document-processing/types.js';
export class KbJobError extends Error{constructor(readonly code:string,readonly retryable=true){super(code);}}
export interface KbDependencies {index?:IndexFactory;embedding?:(snapshot:KbSnapshot)=>EmbeddingAdapter;tokenizer?:(snapshot:KbSnapshot)=>Promise<TokenCounter>;}
interface StoredChunk{ordinal:number;point_id:string;source_start:number;source_end:number;content_hash:string;index_status:string;}
const chunkWriteBatchSize=256;
export class KnowledgeIndexJobs {
 constructor(readonly pool:pg.Pool,readonly config:AppConfig,readonly dependencies:KbDependencies={}){}
 async close():Promise<void>{}
 private index(snapshot:KbSnapshot):HybridIndex|KeywordIndex{return this.dependencies.index?.(snapshot)??knowledgeIndex(this.config,snapshot,undefined,this.pool);}
 private async lease(tx:pg.PoolClient|pg.Client,attempt:Attempt){
  const r=await tx.query("SELECT id FROM tasks WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND state='running' AND lease_owner=$4 AND version=$5 AND attempt_no=$6 AND lease_until>clock_timestamp() FOR UPDATE",[attempt.task.id,attempt.task.workspace_id,attempt.task.user_id,attempt.owner,attempt.version,attempt.attempt]);
  if(!r.rowCount)throw new KbJobError('KB_LEASE_LOST');
 }
 private async lock<T>(type:KbSourceType,id:string,operation:()=>Promise<T>):Promise<T>{
  const client=new pg.Client(this.pool.options);client.on('error',()=>{});
  try{await client.connect();await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['kb:'+type+':'+id]);return await operation();}
  finally{await client.end().catch(()=>{});}
 }
 async indexSource(source:KbSource,attempt:Attempt,snapshot:KbSnapshot):Promise<{digest:string;bytes:number}>{
  const build=await transaction(this.pool,async tx=>{const s=await sourceState(tx,{source_type:source.type,source_id:source.id,user_id:source.userId,workspace_id:source.workspaceId},true);await this.lease(tx,attempt);
   if(s.deleted||s.revision!==source.revision)throw new KbJobError('KB_SOURCE_SUPERSEDED',false);
   return createBuild(tx,source,attempt.task.id,snapshot);});
  return this.executeBuild(build.id,attempt,source.type);
 }
 async executeBuild(id:string,attempt:Attempt,sourceType:KbSourceType){
  const {builds,chunks}=tablesForSource(sourceType);
  const build=(await this.pool.query<KbBuild>(`SELECT * FROM ${builds} WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND task_id=$4 AND source_type=$5`,[id,attempt.task.user_id,attempt.task.workspace_id,attempt.task.id,sourceType])).rows[0];
  if(!build)throw new KbJobError('KB_BUILD_NOT_FOUND',false);
  const {mode}=build.snapshot;
  return this.lock(build.source_type,build.source_id,async()=>{
   let source:KbSource;
   try{source=await sourceContent(this.pool,this.config,build);}catch(e){if(e instanceof DomainError)throw new KbJobError(e.code,false);throw e;}
   const index=this.index(build.snapshot);
   const check=async(tx:pg.PoolClient)=>{const state=await sourceState(tx,build,true);await this.lease(tx,attempt);const owner=(await tx.query(`SELECT task_id FROM ${builds} WHERE id=$1 FOR UPDATE`,[id])).rows[0];if(owner?.task_id!==attempt.task.id)throw new KbJobError('KB_SOURCE_SUPERSEDED',false);const newer=await tx.query(`SELECT 1 FROM ${builds} WHERE source_type=$1 AND source_id=$2 AND source_revision=$4 AND (created_at,id)>(SELECT created_at,id FROM ${builds} WHERE id=$3) LIMIT 1`,[build.source_type,build.source_id,id,build.source_revision]);if(state.deleted||state.revision!==build.source_revision||newer.rowCount)throw new KbJobError('KB_SOURCE_SUPERSEDED',false);};
   try{
    if(!build.published){
     const tokenizer=mode==='hybrid'?await(this.dependencies.tokenizer?.(build.snapshot)??kbTokenizer(build.snapshot)):undefined;
     let drafts:KbDraft[]|undefined;
     if(!build.planned){
      const plan=await splitKnowledgeContent(source.content,mode,{format:source.format,...(tokenizer?{tokenizer}:{})});
      drafts=plan.chunks;
      const occurrences=new Map<string,number>();
      await transaction(this.pool,async tx=>{await check(tx);
       for(let offset=0;offset<plan.chunks.length;offset+=chunkWriteBatchSize){
        const batch=plan.chunks.slice(offset,offset+chunkWriteBatchSize).map(draft=>{
         const k=draft.contentHash+draft.inputHash;const occurrence=occurrences.get(k)??0;occurrences.set(k,occurrence+1);
         return {draft,pointId:digest(JSON.stringify([source.type,source.id,build.snapshot.pointIdentityHash??build.config_hash,k,occurrence]))};
        });
        // EXISTS keeps both the lookup input and result bounded even when many
        // historical builds reference the same reusable point.
        const reusable=new Set((mode==='hybrid'||build.snapshot.indexLayout==='sparse-v1')?(await tx.query<{point_id:string}>(`SELECT requested.point_id FROM unnest($1::text[]) AS requested(point_id)
         WHERE EXISTS(SELECT 1 FROM ${chunks} c JOIN ${builds} b ON b.id=c.build_id
          WHERE c.point_id=requested.point_id AND c.index_status='ready' AND b.source_id=$2 AND b.user_id=$3 AND b.config_hash=$4 AND b.cleanup_status<>'ready')`,
         [batch.map(row=>row.pointId),source.id,source.userId,build.config_hash])).rows.map(row=>row.point_id):[]);
        const values:unknown[]=[];
        const records=batch.map(({draft,pointId})=>{
         const fields=[id,draft.ordinal,pointId,draft.start,draft.end,draft.contentHash,draft.charCount,reusable.has(pointId)?'ready':'pending',...(sourceType==='content_asset'?[draft.coreStart,draft.coreEnd,draft.sectionId,draft.inputHash,draft.tokenCount]:[])];
         const start=values.length;values.push(...fields);return '('+fields.map((_,i)=>'$'+(start+i+1)).join(',')+')';
        });
        await tx.query(`INSERT INTO ${chunks}(build_id,ordinal,point_id,source_start,source_end,content_hash,char_count,index_status${sourceType==='content_asset'?',core_start,core_end,section_id,input_hash,token_count':''}) VALUES ${records.join(',')} ON CONFLICT(build_id,ordinal) DO NOTHING`,values);
       }
       await tx.query(`UPDATE ${builds} SET planned=true,chunk_count=$2,status='indexing',toc=$3::jsonb,toc_status='ready',updated_at=now() WHERE id=$1`,[id,plan.chunks.length,JSON.stringify(plan.structure?.toc??[])]);
      });
     }
     const rows=(await this.pool.query<StoredChunk>(`SELECT * FROM ${chunks} WHERE build_id=$1 AND index_status<>'ready' ORDER BY ordinal`,[id])).rows;
     const embedder=mode==='hybrid'?(this.dependencies.embedding?.(build.snapshot)??kbEmbedding(this.config,build.snapshot)):undefined;
     if(mode==='hybrid'&&rows.length&&!drafts)drafts=(await splitKnowledgeContent(source.content,mode,{format:source.format,tokenizer:tokenizer!})).chunks;
     await transaction(this.pool,check);
     const writes=new Set<Promise<void>>();
     const write=(p:Promise<void>)=>{writes.add(p);void p.finally(()=>writes.delete(p)).catch(()=>{});return p;};
     let items:import('../../lib/rag-indexing/index.js').IndexItemResult[];
     try{
      if(mode==='hybrid'){
       const hybrid=requireIndexKind(index,'hybrid');
       const draftsByOrdinal=new Map(drafts?.map(draft=>[draft.ordinal,draft]));
       const records=rows.map(row=>{const draft=draftsByOrdinal.get(row.ordinal)!;if(draft.contentHash!==row.content_hash)throw new KbJobError('KB_PLAN_CHANGED',false);return {id:row.point_id,embeddingText:draft.embeddingText,metadata:{content:draft.content}};});
       const store:BoundVectorStoreAdapter={target:build.snapshot.target,upsert:async(vs,o)=>write(hybrid.upsert(vs.map(v=>({id:v.id,sourceId:source.id,sourceType:source.type,userId:source.userId,workspaceId:source.workspaceId,content:String(v.metadata.content),embedding:v.embedding})),o)),delete:async selector=>{if(!selector.ids)throw new Error('KB_POINT_IDS_REQUIRED');await index.deletePoints(selector.ids);}};
       items=(await indexChunks(records,{embeddingAdapter:embedder!,tokenizer:tokenizer!,vectorStoreAdapter:store,options:{...build.snapshot.indexing,maxEmbeddingTokens:tokenizer!.maxInputTokens}})).items;
      }else{
       const keyword=requireIndexKind(index,'keyword');
       const points=rows.map(row=>({id:row.point_id,sourceId:source.id,sourceType:source.type,userId:source.userId,workspaceId:source.workspaceId,content:source.content.slice(row.source_start,row.source_end)}));
       items=await indexKeywordChunks(points,{kind:'keyword',ensureReady:()=>keyword.ensureReady(),upsert:(rows,o)=>write(keyword.upsert(rows,o)),deletePoints:(ids,o)=>keyword.deletePoints(ids,o),searchKeyword:(q,o)=>keyword.searchKeyword(q,o),close:()=>keyword.close()},{...build.snapshot.indexing,maxContentChars:build.snapshot.rules.maxChars});
      }
     }finally{await Promise.allSettled([...writes]);}
     await transaction(this.pool,async tx=>{await check(tx);await tx.query(`UPDATE ${chunks} SET index_status='ready' WHERE build_id=$1 AND point_id=ANY($2::text[])`,[id,items.filter(r=>r.status==='indexed').map(r=>r.id)]);});
     if(items.some(r=>r.status==='failed'))throw new KbJobError('KB_INDEX_PARTIAL_FAILURE');
     await transaction(this.pool,async tx=>{await check(tx);
      const incomplete=await tx.query(`SELECT 1 FROM ${chunks} WHERE build_id=$1 AND index_status<>'ready' LIMIT 1`,[id]);if(incomplete.rowCount)throw new KbJobError('KB_INDEX_INCOMPLETE');
      await tx.query(`UPDATE ${builds} SET published=false,status='superseded',updated_at=now() WHERE source_type=$1 AND source_id=$2 AND published AND id<>$3`,[source.type,source.id,id]);
      await tx.query(`UPDATE ${builds} SET published=true,status='ready',cleanup_status='pending',error_code=NULL,updated_at=now() WHERE id=$1`,[id]);
     });
    }
    await this.cleanupLocked(build.source_type,build.source_id,attempt);
    return {digest:build.content_hash,bytes:Buffer.byteLength(source.content)};
   }catch(e){await this.pool.query(`UPDATE ${builds} SET status='failed',error_code=$2,updated_at=now() WHERE id=$1 AND NOT published AND task_id=$3`,[id,e instanceof KbJobError?e.code:'KB_INDEX_FAILED',attempt.task.id]);throw e;}
   finally{await index.close();}
  });
 }
 async cleanup(type:KbSourceType,id:string,attempt:Attempt){return this.lock(type,id,async()=>{await this.cleanupLocked(type,id,attempt);return {digest:digest(type+id),bytes:0};});}
 private async cleanupLocked(type:KbSourceType,id:string,attempt:Attempt){
  const {builds,chunks}=tablesForSource(type);
  const scope={source_type:type,source_id:id,user_id:attempt.task.user_id!,workspace_id:attempt.task.workspace_id!};
  const state=await transaction(this.pool,async tx=>{const s=await sourceState(tx,scope,true);await this.lease(tx,attempt);
   await tx.query(`UPDATE ${builds} SET published=false,status=$4 WHERE source_type=$1 AND source_id=$2 AND user_id=$3 AND (source_revision<>$5 OR $6)`,[type,id,scope.user_id,s.deleted?'deleted':'superseded',s.revision,s.deleted]);return s;});
  const retired=(await this.pool.query<KbBuild>(`SELECT * FROM ${builds} WHERE source_type=$1 AND source_id=$2 AND user_id=$3 AND workspace_id=$4 AND NOT published AND cleanup_status<>'ready' AND (source_revision<>$5 OR $6 OR status='superseded')`,[type,id,scope.user_id,scope.workspace_id,state.revision,state.deleted])).rows;
  for(const b of retired){
   const ids=(await this.pool.query<{point_id:string}>(`SELECT c.point_id FROM ${chunks} c WHERE c.build_id=$1 AND NOT EXISTS(SELECT 1 FROM ${chunks} live JOIN ${builds} lb ON lb.id=live.build_id WHERE live.point_id=c.point_id AND lb.id<>$1 AND lb.status IN ('pending','indexing','ready') AND lb.config_hash=$2 AND lb.source_revision=$3)`,[b.id,b.config_hash,state.revision])).rows.map(r=>r.point_id);
   const index=this.index(b.snapshot);try{await index.deletePoints(ids);await this.pool.query(`UPDATE ${builds} SET cleanup_status='ready' WHERE id=$1 AND task_id=$2`,[b.id,b.task_id]);}finally{await index.close();}
  }
 }
}
