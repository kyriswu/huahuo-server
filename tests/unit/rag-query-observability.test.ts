import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { SearchQueryTiming } from '../../src/modules/rag/query-timing.js';
import { createRagQueryRoute } from '../../src/modules/rag/query-routes.js';
import type { RagQueryService, RagQueryInput } from '../../src/modules/rag/query-service.js';
import { ApplicationMetrics } from '../../src/plugins/metrics.js';
import { buildBase } from '../../src/apps/base.js';
import { DomainError, type Scope } from '../../src/modules/identity/store.js';
import { config, dependencies } from '../helpers.js';

const samples=(body:string,name:string)=>body.split('\n').filter(line=>line.startsWith(name+'{'));
const total=(body:string,name:string,labels:string[])=>samples(body,name).filter(line=>labels.every(label=>line.includes(label))).reduce((sum,line)=>sum+Number(line.split(' ').at(-1)),0);

describe('RAG duration and count semantics',()=>{
 it('keeps embedding attempt counts out of Server-Timing duration fields and counts fallback once per request',async()=>{
  const metrics=new ApplicationMetrics(config());
  for(let query=0;query<2;query++){
   const timing=new SearchQueryTiming();
   await timing.measure('embedding',async()=>{await new Promise(resolve=>setTimeout(resolve,2));});
   timing.embeddingAttempts.push({attempt:0,durationMs:10,succeeded:false,status:503},{attempt:1,durationMs:20,succeeded:true,status:200});
   timing.fallback='timeout';
   const snapshot=timing.snapshot();expect(snapshot.embeddingAttemptCount).toBe(2);expect(snapshot.rerankFallbackCount).toBe(1);expect(snapshot).not.toHaveProperty('rerankFallbackTotal');
   expect(timing.serverTiming()).toContain('embedding;dur=');expect(timing.serverTiming()).toContain('embedding_attempts;desc="2"');
   expect(timing.serverTiming()).not.toMatch(/(?:embedding_attempts|rerank_fallback);dur=/);
   timing.record(metrics,'content_asset',200);
  }
  const body=await metrics.registry.metrics();
  expect(total(body,'rag_operations_total',['operation="content_asset_query"','outcome="success"'])).toBe(2);
  expect(total(body,'rag_operations_total',['operation="embedding_attempt"','outcome="success"'])).toBe(2);
  expect(total(body,'rag_operations_total',['operation="embedding_attempt"','outcome="failure"'])).toBe(2);
  expect(total(body,'rag_fallbacks_total',['reason="timeout"'])).toBe(2);
  expect(total(body,'rag_stage_duration_seconds_count',['stage="embedding"'])).toBe(2);
  expect(total(body,'rag_operation_duration_seconds_sum',['operation="embedding_attempt"'])).toBeCloseTo(0.06);
 });
 it('retains stage duration on failures and never lets diagnostic failure replace a query result',async()=>{
  const timing=new SearchQueryTiming(),failure=Error('private provider text');
  expect(timing.serverTiming()).toBe('embedding_attempts;desc="0", rerank_fallback;desc="0"');
  await expect(timing.measure('index_search',async()=>{throw failure;})).rejects.toBe(failure);
  expect(timing.snapshot().stages.index_search).toBeGreaterThanOrEqual(0);
  expect(()=>timing.record({recordRagOperation:()=>{throw Error('METRICS_UNAVAILABLE');},recordRagStage:vi.fn(),recordRagFallback:vi.fn()},'content_asset',503)).not.toThrow();
 });
});

it('defaults sourceType to content_asset and emits safe metrics/logs for successes and failures',async()=>{
 const lines:string[]=[],stream=new Writable({write(chunk,_encoding,done){lines.push(String(chunk));done();}});
 const app=await buildBase({config:{...config(),logLevel:'info'},dependencies:dependencies(),loggerStream:stream});
 const query=vi.fn(async(_scope:Scope,input:RagQueryInput,timing?:SearchQueryTiming)=>{
  await timing!.measure('pg_scope',async()=>undefined);
  if(input.query==='failing-private-query')throw new DomainError(503,'RAG_SEARCH_UNAVAILABLE');
  timing!.embeddingAttempts.push({attempt:0,durationMs:3,succeeded:true,status:200});
  timing!.fallback='error';
  return {mode:input.mode??'hybrid',query:input.query,results:[]};
 });
 const {route,handler}=createRagQueryRoute({query} as unknown as RagQueryService,async request=>{
  request.authScope={userId:'private-user-id',sessionId:'private-session-id',traceId:request.id};
 });
 app.post('/api/v1/rag/query',route,handler);
 const base=await app.listen({host:'127.0.0.1',port:0});
 try{
  for(const payload of [{query:'private-default-query'},{query:'private-explicit-query',sourceType:'content_asset'},{query:'failing-private-query'}]){
   const response=await fetch(base+'/api/v1/rag/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
   expect(response.status).toBe(payload.query.startsWith('failing')?503:200);
   expect(response.headers.get('server-timing')).toContain('auth;dur=');
   expect(response.headers.get('server-timing')).toContain('embedding_attempts;desc=');
   await response.text();
  }
  const body=await app.metrics.registry.metrics();
  expect(total(body,'rag_operations_total',['operation="content_asset_query"','outcome="success"'])).toBe(2);
  expect(total(body,'rag_operations_total',['operation="content_asset_query"','outcome="failure"'])).toBe(1);
  expect(total(body,'rag_fallbacks_total',['reason="error"'])).toBe(2);
  const logs=lines.flatMap(line=>line.trim().split('\n').filter(Boolean).map(value=>JSON.parse(value) as Record<string,unknown>));
  const rag=logs.filter(log=>log.event==='rag.query.finished');expect(rag).toHaveLength(3);
  expect(rag.every(log=>log.sourceType==='content_asset'&&typeof log.trace_id==='string'&&typeof log.span_id==='string')).toBe(true);
  expect(rag.map(log=>log.rerankFallbackCount)).toEqual([1,1,0]);
  expect(JSON.stringify(rag)).not.toMatch(/private-default-query|private-explicit-query|failing-private-query|private-user-id|private-session-id|rerankFallbackTotal/);
  expect(body).not.toMatch(/private-|query="|taskId|trace_id=|span_id=/);
 }finally{await app.close();}
});
