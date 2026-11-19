import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { beforeEach, expect, it, vi } from 'vitest';
import { digest } from '../../src/lib/crypto.js';
import type { IndexPoint } from '../../src/lib/search-index/types.js';
import { KnowledgeIndexJobs } from '../../src/modules/kb/jobs.js';
import { kbSnapshot } from '../../src/modules/kb/profile.js';
import { sourceContent, sourceState } from '../../src/modules/kb/repository.js';
import { splitKnowledgeContent, type KbDraft } from '../../src/modules/kb/split.js';
import type { KbBuild, KbSource } from '../../src/modules/kb/types.js';
import type { Attempt } from '../../src/modules/tasks/engine.js';
import { config } from '../helpers.js';

vi.mock('pg',async importOriginal=>{
 const actual=await importOriginal<typeof import('pg')>();
 return {...actual,default:{...actual.default,Client:class extends EventEmitter {
  async connect(){}
  async query(sql:string){if(!sql.startsWith('SELECT pg_advisory_lock'))throw new Error('UNEXPECTED_LOCK_QUERY');return {rows:[]};}
  async end(){}
 }}};
});
vi.mock('../../src/modules/kb/repository.js',async importOriginal=>({
 ...await importOriginal<typeof import('../../src/modules/kb/repository.js')>(),sourceContent:vi.fn(),sourceState:vi.fn(),
}));
vi.mock('../../src/modules/kb/split.js',()=>({splitKnowledgeContent:vi.fn()}));
beforeEach(()=>vi.clearAllMocks());

function fixture(mode:'note-hybrid'|'document-keyword',options:{count?:number;failBatch?:number;leaseLost?:boolean;planned?:boolean;changedHash?:boolean}={}){
 const settings=config(),snapshot=kbSnapshot(settings,mode,'markdown'),body='Repeated paragraph.\n';
 const drafts:KbDraft[]=Array.from({length:options.count??513},(_,ordinal)=>({ordinal,start:ordinal*body.length,end:(ordinal+1)*body.length,
  coreStart:ordinal*body.length,coreEnd:(ordinal+1)*body.length,sectionId:null,headingPath:[],content:body,embeddingText:body,
  contentHash:digest(body),inputHash:digest(body),charCount:body.length,tokenCount:body.length}));
 const source:KbSource={type:mode==='note-hybrid'?'note':'text',id:'source',revision:'revision',userId:'user',workspaceId:'workspace',content:body.repeat(drafts.length),format:'markdown'};
 const build:KbBuild={id:'build',source_type:source.type,source_id:source.id,source_revision:source.revision,user_id:source.userId,workspace_id:source.workspaceId,
  task_id:'task',content_hash:digest(source.content),config_hash:snapshot.configHash,snapshot,status:'pending',published:false,cleanup_status:'pending',chunk_count:drafts.length,
  planned:options.planned??false,toc_status:'pending',toc:null};
 // Expected IDs use the existing persisted identity, including occurrence across
 // batch boundaries; repeated content must not collapse distinct occurrences.
 const pointIds=drafts.map((draft,occurrence)=>digest(JSON.stringify([source.type,source.id,build.config_hash,draft.contentHash+draft.inputHash,occurrence])));
 const reusable=new Set([pointIds[0]!,pointIds[256]!]);
 const stored:Array<{ordinal:number;point_id:string;source_start:number;source_end:number;content_hash:string;index_status:string}>=options.planned
  ? [drafts.at(-1)!].map(draft=>({ordinal:draft.ordinal,point_id:pointIds[draft.ordinal]!,source_start:draft.start,source_end:draft.end,content_hash:options.changedHash?'changed':draft.contentHash,index_status:'pending'})):[];
 const inserts:unknown[][]=[],reuses:unknown[][]=[];
 const sql=vi.fn(async(query:string,values:unknown[]=[])=>{
  if(query.startsWith('SELECT * FROM kb_')&&query.includes('AND task_id=$4'))return {rows:[build],rowCount:1};
  if(query.startsWith('SELECT id FROM tasks'))return {rows:options.leaseLost?[]:[{id:build.task_id}],rowCount:options.leaseLost?0:1};
  if(query.startsWith('SELECT task_id FROM'))return {rows:[{task_id:build.task_id}],rowCount:1};
  if(query.startsWith('SELECT requested.point_id')){
   reuses.push(values);
   expect(query).toContain("c.index_status='ready'");expect(query).toContain("b.cleanup_status<>'ready'");
   expect(query).toContain('b.source_id=$2 AND b.user_id=$3 AND b.config_hash=$4');
   return {rows:(values[0] as string[]).filter(id=>reusable.has(id)).map(point_id=>({point_id})),rowCount:0};
  }
  if(query.startsWith('INSERT INTO kb_')){
   expect(query).toContain('ON CONFLICT(build_id,ordinal) DO NOTHING');inserts.push(values);
   if(inserts.length===options.failBatch)throw new Error('BATCH_WRITE_FAILED');
   const width=mode==='note-hybrid'?13:8;
   for(let offset=0;offset<values.length;offset+=width){
    const row=values.slice(offset,offset+width);
    stored.push({ordinal:Number(row[1]),point_id:String(row[2]),source_start:Number(row[3]),source_end:Number(row[4]),content_hash:String(row[5]),index_status:String(row[7])});
   }
   return {rows:[],rowCount:values.length/width};
  }
  if(query.startsWith('SELECT * FROM kb_')&&query.includes("index_status<>'ready'"))return {rows:stored.filter(row=>row.index_status!=='ready'),rowCount:stored.length};
  if(query.startsWith('UPDATE kb_')&&query.includes("SET index_status='ready'"))for(const row of stored)if((values[1] as string[]).includes(row.point_id))row.index_status='ready';
  if(query.startsWith('SELECT 1 FROM kb_')||query.startsWith('SELECT * FROM kb_')||query.startsWith('UPDATE kb_')||['BEGIN','COMMIT','ROLLBACK'].includes(query))return {rows:[],rowCount:0};
  throw new Error(`UNEXPECTED_SQL: ${query}`);
 });
 const pool={options:{},query:sql,connect:async()=>Object.assign(new EventEmitter(),{query:sql,release:vi.fn()})} as unknown as pg.Pool;
 const upsert=vi.fn<(points:readonly IndexPoint[])=>Promise<void>>(async()=>{}),close=vi.fn(async()=>{});
 const common={ensureReady:async()=>{},upsert,deletePoints:async()=>{},close,searchKeyword:async()=>[]};
 const index=mode==='note-hybrid'?{...common,kind:'hybrid' as const,search:async()=>[],hybridSearch:async()=>[]}:{...common,kind:'keyword' as const};
 vi.mocked(sourceContent).mockResolvedValue(source);vi.mocked(sourceState).mockResolvedValue({revision:source.revision,content:source.content,deleted:false,format:'markdown'});
 vi.mocked(splitKnowledgeContent).mockResolvedValue({chunks:drafts});
 const tokenizer={id:'fixture',model:'fixture',maxInputTokens:1000,count:async(text:string)=>text.length};
 const embed=vi.fn(async(texts:string[])=>texts.map(()=>[1,0]));
 const jobs=new KnowledgeIndexJobs(pool,settings,{index:()=>index,tokenizer:async()=>tokenizer,embedding:()=>({model:'fixture',dimensions:2,embed})});
 const attempt={task:{id:build.task_id,user_id:source.userId,workspace_id:source.workspaceId},owner:'owner',version:1,attempt:1} as Attempt;
 return {run:()=>jobs.executeBuild(build.id,attempt,mode),sql,inserts,reuses,stored,pointIds,reusable,upsert,embed,close,build};
}

it('batches repeated Note chunks across boundaries while reusing only returned owned points',async()=>{
 const f=fixture('note-hybrid');await f.run();
 expect(f.reuses.map(values=>(values[0] as string[]).length)).toEqual([256,256,1]);
 expect(f.reuses.every(values=>values.slice(1).join('|')===`source|user|${f.build.config_hash}`)).toBe(true);
 expect(f.inserts.map(values=>values.length/13)).toEqual([256,256,1]);
 expect(f.stored.map(row=>row.point_id)).toEqual(f.pointIds);expect(new Set(f.pointIds).size).toBe(513);
 const written=f.upsert.mock.calls.flatMap(([points])=>points.map(point=>point.id));
 expect(new Set(written)).toEqual(new Set(f.pointIds.filter(id=>!f.reusable.has(id))));
 expect(f.sql.mock.calls.some(([query])=>query.includes("SET published=true,status='ready'"))).toBe(true);
});

it('batches keyword metadata without reuse lookups or embedding calls',async()=>{
 const f=fixture('document-keyword');await f.run();
 expect(f.reuses).toEqual([]);expect(f.inserts.map(values=>values.length/8)).toEqual([256,256,1]);
 expect(f.stored.map(row=>row.point_id)).toEqual(f.pointIds);
 expect(f.upsert.mock.calls.flatMap(([points])=>points)).toHaveLength(513);expect(f.embed).not.toHaveBeenCalled();
});

it('does not publish a partially inserted plan when a later batch fails',async()=>{
 const f=fixture('note-hybrid',{failBatch:2});await expect(f.run()).rejects.toThrow('BATCH_WRITE_FAILED');
 expect(f.sql.mock.calls.some(([query])=>query==='ROLLBACK')).toBe(true);
 expect(f.sql.mock.calls.some(([query])=>query.includes('SET planned=true')||query.includes('SET published=true'))).toBe(false);
 expect(f.upsert).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledTimes(1);
});

it('checks the lease before any batch metadata writes',async()=>{
 const f=fixture('note-hybrid',{leaseLost:true});await expect(f.run()).rejects.toMatchObject({code:'KB_LEASE_LOST'});
 expect(f.reuses).toEqual([]);expect(f.inserts).toEqual([]);expect(f.upsert).not.toHaveBeenCalled();
});

it('resumes the persisted pending ordinal and still rejects a changed plan before vector writes',async()=>{
 const f=fixture('note-hybrid',{planned:true});await f.run();
 expect(f.inserts).toEqual([]);expect(f.upsert.mock.calls.flatMap(([points])=>points.map(point=>point.id))).toEqual([f.pointIds[512]]);
 const changed=fixture('note-hybrid',{planned:true,changedHash:true});await expect(changed.run()).rejects.toMatchObject({code:'KB_PLAN_CHANGED'});
 expect(changed.upsert).not.toHaveBeenCalled();
});
