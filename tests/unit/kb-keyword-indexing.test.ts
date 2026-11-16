import {describe,it,expect,vi} from 'vitest';
import {indexKeywordChunks} from '../../src/lib/search-index/keyword-indexing.js';
import type {KeywordIndex,KeywordPoint} from '../../src/lib/search-index/types.js';
import {mockKnowledgeIndex} from '../support/kb-index.js';
const records=Array.from({length:5},(_,i)=>({id:String(i),sourceId:'doc',sourceType:'file' as const,userId:'u',workspaceId:'w',content:'数据库 '+i}));
describe('standalone model-free keyword indexing',()=>{
 it('bounds write concurrency and preserves partial successes',async()=>{
  const index=mockKnowledgeIndex().keyword;let active=0,peak=0;
  index.upsert=vi.fn(async rows=>{active++;peak=Math.max(peak,active);try{await new Promise(r=>setTimeout(r,2));if(rows[0]!.id==='2')throw Object.assign(new Error('failure'),{retryable:false});}finally{active--;}});
  const result=await indexKeywordChunks(records,index,{batchSize:1,concurrency:2,maxRetries:0});expect(peak).toBe(2);expect(result.filter(r=>r.status==='indexed')).toHaveLength(4);expect(result[2]!.status).toBe('failed');
 });
 it('aborts a timed-out batch and does not schedule more work',async()=>{
  const index=mockKnowledgeIndex().keyword;const spy=vi.fn<KeywordIndex['upsert']>(async(rows,options)=>{void rows;return new Promise<void>((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));});
  index.upsert=spy;
  const result=await indexKeywordChunks(records,index,{batchSize:1,concurrency:1,timeoutMs:10,maxRetries:0});expect(result.every(r=>r.status==='failed')).toBe(true);expect(spy).toHaveBeenCalledTimes(1);
 });
 it('rejects fake vectors, over-limit text, and duplicate point IDs before writing',async()=>{
  const index=mockKnowledgeIndex().keyword;for(const input of [[{...records[0]!,embedding:[1]}],[{...records[0]!,content:'x'.repeat(2001)}],[records[0]!,records[0]!]])await expect(indexKeywordChunks(input as readonly KeywordPoint[],index,{maxContentChars:2000})).rejects.toThrow();expect(index.points.size).toBe(0);
 });
});
