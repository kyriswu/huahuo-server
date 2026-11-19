import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { expect, it, vi } from 'vitest';
import { digest } from '../../src/lib/crypto.js';
import type { HybridIndex, RecallHit, SearchOptions } from '../../src/lib/search-index/types.js';
import { snapshotForSource } from '../../src/modules/kb/profile.js';
import { RagQueryService } from '../../src/modules/rag/query-service.js';
import { fuseRankedRecall, type RerankAdapter } from '../../src/modules/rag/search.js';
import { config } from '../helpers.js';

it('fuses global branch ranks without enumerating PostgreSQL points before recall', async () => {
 const settings=config();
 Object.assign(settings.milvus,{denseCandidates:3,bm25Candidates:4,hybridCandidates:4,rrfK:60});
 settings.rag.rerankProvider='disabled';
 const scope={userId:randomUUID(),sessionId:randomUUID(),traceId:randomUUID()};
 const buildId=randomUUID(),sourceId=randomUUID(),revision=randomUUID();
 const snapshot=snapshotForSource(settings,'content_asset','markdown');
 let content='';
 const rows=Array.from({length:300},(_,ordinal)=>{
  const point=ordinal===0?'A':ordinal===1?'B':ordinal===256?'C':`filler-${ordinal}`;
  const body=`chunk ${point}\n`,start=content.length;content+=body;
  return {build_id:buildId,point_id:point,ordinal,source_start:start,source_end:content.length,content_hash:digest(body),chunk_count:300};
 });
 const build={id:buildId,source_type:'content_asset',source_id:sourceId,source_revision:revision,user_id:scope.userId,
  content_hash:digest(content),snapshot,published:true,status:'ready',chunk_count:300,content_asset_revision_id:randomUUID(),cursor_created_at:'2026-01-01 00:00:00.000000+00'};
 const sql=vi.fn(async(query:string,values:unknown[]=[])=>{
  if(query.includes('FROM user_sessions'))return {rows:[{id:scope.sessionId}],rowCount:1};
  if(query.includes('AS chunk'))return {rows:rows.filter(row=>(values[7] as string[]).includes(row.point_id)).map(chunk=>({...build,chunk}))};
  if(query.includes('SELECT b.*'))return {rows:[query.includes('AS source_body')?{...build,source_body:content}:build],rowCount:1};
  if(['BEGIN','COMMIT','ROLLBACK'].includes(query))return {rows:[],rowCount:0};
  throw new Error(`UNEXPECTED_SQL: ${query}`);
 });
 const pool={connect:async()=>Object.assign(new EventEmitter(),{query:sql,release:vi.fn()})} as unknown as pg.Pool;
 const denseScores:Record<string,number>={A:100,B:90,C:10},keywordScores:Record<string,number>={B:100,C:90,A:80};
 const recall=(scores:Record<string,number>,options:SearchOptions):RecallHit[]=>rows.filter(row=>options.scope.accountWide||options.scope.pointIds.includes(row.point_id))
  .map(row=>({chunkKey:row.point_id,content:content.slice(row.source_start,row.source_end),score:scores[row.point_id]??0}))
  .sort((a,b)=>b.score-a.score||a.chunkKey.localeCompare(b.chunkKey)).slice(0,options.limit);
 const search=vi.fn(async(_vector:readonly number[],options:SearchOptions)=>recall(denseScores,options));
 const searchKeyword=vi.fn(async(_query:string,options:SearchOptions)=>recall(keywordScores,options));
 const hybridSearch=vi.fn(async(_vector:readonly number[],_query:string,options:SearchOptions)=>fuseRankedRecall([
  recall(denseScores,{...options,limit:3}),recall(keywordScores,{...options,limit:4}),
 ],options.limit,60));
 const index:HybridIndex={kind:'hybrid',ensureReady:vi.fn(async()=>{}),upsert:vi.fn(async()=>{}),deletePoints:vi.fn(async()=>{}),close:vi.fn(async()=>{}),search,searchKeyword,hybridSearch};
 // C wins if each window assigns its own rank 1 before the windows are merged.
 const local=([rows.slice(0,256),rows.slice(256)]).flatMap(window=>{
  const options={scope:{userId:scope.userId,pointIds:window.map(row=>row.point_id)},limit:4};
  return fuseRankedRecall([recall(denseScores,{...options,limit:3}),recall(keywordScores,options)],4,60);
 }).sort((a,b)=>b.score-a.score||a.chunkKey.localeCompare(b.chunkKey));
 expect(local[0]!.chunkKey).toBe('C');
 const service=new RagQueryService(pool,settings,{index:()=>index,embedding:{model:snapshot.embedding!.model,dimensions:1024,embed:async()=>[Array<number>(1024).fill(0)]}});
 try{
  const result=await service.query(scope,{query:'needle',mode:'hybrid',topK:1});
  expect(result.results).toHaveLength(1);expect(result.results[0]!.chunkKey).toBe('B');
  expect(result.results[0]!.rrfScore).toBeCloseTo(1/62+1/61);
  const expectedScope={userId:scope.userId,accountWide:true};
  expect(search.mock.calls.map(call=>call[1])).toEqual([{scope:expectedScope,filter:{},limit:3}]);
  expect(searchKeyword.mock.calls.map(call=>call[1])).toEqual([{scope:expectedScope,filter:{},limit:4}]);
  expect(sql.mock.calls.some(([statement])=>statement.includes('SELECT c.*'))).toBe(false);
  expect(sql.mock.invocationCallOrder[sql.mock.calls.findIndex(([statement])=>statement.includes('AS chunk'))]).toBeGreaterThan(search.mock.invocationCallOrder[0]!);
  expect(hybridSearch).not.toHaveBeenCalled();
 }finally{await service.close();}
});

it.each(['rerank','topK','refill'] as const)('hydrates only the ranked bodies needed for %s', async strategy => {
 const settings=config();
 settings.kb.indexLayout='sparse-v1';
 const scope={userId:randomUUID(),sessionId:randomUUID(),traceId:randomUUID()};
 const snapshot=snapshotForSource(settings,'content_asset','markdown');
 const fixtures=['first','second','superseded'].map((pointId,index)=>{
  const content=pointId+' candidate',source='🚀'+content;
  const build={id:randomUUID(),source_type:'content_asset',source_id:randomUUID(),source_revision:randomUUID(),
   user_id:scope.userId,content_hash:digest(source),snapshot,published:true,status:'ready',
   chunk_count:1,content_asset_revision_id:randomUUID()};
  const row={build_id:build.id,point_id:pointId,ordinal:0,source_start:'🚀'.length,source_end:source.length,content_hash:digest(content),chunk_count:1};
  return {build,row,source,hit:{chunkKey:pointId,score:3-index}};
 });
 const sql=vi.fn(async(query:string,values:unknown[]=[])=>{
  if(query.includes('FROM user_sessions'))return {rows:[{id:scope.sessionId}],rowCount:1};
  if(query.includes('AS chunk'))return {rows:fixtures.map(f=>({...f.build,chunk:f.row}))};
  if(query.includes('SELECT b.*')){
   const ids=values[5] as string[]|null;
   const selected=ids?fixtures.filter(f=>ids.includes(f.build.id)):fixtures;
   if(query.includes('AS source_body')){
    // The database may return a different order, and a revision can disappear after recall.
    return {rows:selected.filter(f=>f.row.point_id!=='superseded').reverse().map(f=>({...f.build,source_body:f.source}))};
   }
   return {rows:selected.filter(f=>!(ids&&strategy==='refill'&&f.row.point_id==='first')).map(f=>f.build)};
  }
  if(['BEGIN','COMMIT','ROLLBACK'].includes(query))return {rows:[],rowCount:0};
  throw new Error(`UNEXPECTED_SQL: ${query}`);
 });
 const pool={connect:async()=>Object.assign(new EventEmitter(),{query:sql,release:vi.fn()})} as unknown as pg.Pool;
 const recall=(options:SearchOptions)=>fixtures.filter(f=>options.scope.accountWide||options.scope.pointIds.includes(f.row.point_id)).map(f=>f.hit);
 const index:HybridIndex={kind:'hybrid',ensureReady:async()=>{},upsert:async()=>{},deletePoints:async()=>{},close:async()=>{},
  search:async(_vector,options)=>recall(options),searchKeyword:async(_query,options)=>recall(options),hybridSearch:async()=>[]};
 const rerank=vi.fn<RerankAdapter['rerank']>(async(_query,candidates)=>candidates.map((candidate,i)=>({...candidate,rerankScore:i})));
 const service=new RagQueryService(pool,settings,{index:()=>index,...(strategy==='rerank'?{rerank:{rerank}}:{}),
  embedding:{model:snapshot.embedding!.model,dimensions:1024,embed:async()=>[Array<number>(1024).fill(0)]}});
 try{
  const result=await service.query(scope,{query:'candidate',mode:'hybrid',topK:1});
  const bodyQueries=sql.mock.calls.filter(([query])=>query.includes('AS source_body'));
  if(strategy==='rerank'){
   expect(rerank.mock.calls[0]?.[1].map(c=>c.chunkKey)).toEqual(['first','second']);
   expect(bodyQueries.map(call=>call[1]?.[5])).toEqual([fixtures.map(f=>f.build.id)]);
  }else{
   expect(rerank).not.toHaveBeenCalled();
   expect(bodyQueries.map(call=>call[1]?.[5])).toEqual(
    (strategy==='refill'?fixtures.slice(0,2):fixtures.slice(0,1)).map(f=>[f.build.id]),
   );
  }
  const expected=strategy==='topK'?'first':'second';
  expect(result.results).toHaveLength(1);
  expect(result.results[0]).toMatchObject({chunkKey:expected,content:expected+' candidate',sourceStart:'🚀'.length});
 }finally{await service.close();}
});
