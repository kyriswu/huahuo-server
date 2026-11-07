import { describe, expect, it, vi } from 'vitest';
import { createDocumentProcessingTools, type IndexToolInput } from '../../src/tools/document-processing.js';
import type { IndexDependencies } from '../../src/lib/rag-indexing/index.js';
import type { TokenCounter } from '../../src/lib/document-processing/types.js';

const tokenizer:TokenCounter={id:'test-only-character-counter',model:'test-model',maxInputTokens:1000,count:text=>[...text].length};
function setup(){
 const binding:IndexDependencies={tokenizer,embeddingAdapter:{model:'test-model',dimensions:2,embed:vi.fn<IndexDependencies['embeddingAdapter']['embed']>(async texts=>texts.map(()=>[1,0.5]))},vectorStoreAdapter:{target:{connectionId:'registered',database:'test',collection:'test-chunks'},upsert:vi.fn(async()=>undefined),delete:vi.fn(async()=>undefined)},options:{batchSize:2,concurrency:1,maxRetries:0}};
 return{binding,tools:createDocumentProcessingTools({tokenizer,indexTargets:new Map([['test-only',binding]])})};
}

describe('thin typed document tools',()=>{
 it('can analyze structure independently without database or vector bindings',async()=>{
  const tools=createDocumentProcessingTools({tokenizer,indexTargets:new Map()});
  const result=await tools.analyzeStructure.execute({content:'# 文档\n\n正文\n\n```md\n# 伪标题\n```\n',format:'markdown'});
  expect(result.toc).toHaveLength(1);expect(result.toc[0]?.title).toBe('文档');
  expect(result.sections[0]?.sectionId).toBe(result.toc[0]?.sectionId);
 });
 it('can split raw text independently without invoking structure or requiring a business identity',async()=>{
  const tools=createDocumentProcessingTools({tokenizer,indexTargets:new Map()});const content='  重复😀段落\r\n重复😀段落  ';
  const chunks=await tools.splitChunks.execute({content,format:'text',options:{targetTokens:10,maxEmbeddingTokens:30,overlapTokens:2,respectSections:false}});
  expect(chunks.length).toBeGreaterThan(1);expect(chunks.every(chunk=>chunk.content===content.slice(chunk.source_start,chunk.source_end))).toBe(true);
  expect(chunks.every(chunk=>!('parent_id'in chunk)&&!('pageContent'in chunk))).toBe(true);
 });
 it('indexes another tool prepared chunks through a registered binding',async()=>{
  const{tools,binding}=setup();const result=await tools.indexChunks.execute({targetId:'test-only',records:[{id:'external-tool-stable-id',embeddingText:'prepared text',metadata:{custom_scope:'anything-legal'}}]});
  expect(result.successCount).toBe(1);expect(binding.embeddingAdapter.embed).toHaveBeenCalledWith(['prepared text'],expect.any(Object));
  expect(binding.vectorStoreAdapter.upsert).toHaveBeenCalledWith([expect.objectContaining({id:'external-tool-stable-id',metadata:{custom_scope:'anything-legal'}})],expect.any(Object));
 });
 it('rejects unknown targets and arbitrary connection credentials from callers',async()=>{
  const{tools,binding}=setup();
  await expect(tools.indexChunks.execute({targetId:'unknown',records:[]})).rejects.toMatchObject({code:'TOOL_TARGET_UNAVAILABLE'});
  await expect(tools.indexChunks.execute({targetId:'test-only',records:[],connection:'https://caller-supplied',apiKey:'not-allowed'}as unknown as IndexToolInput)).rejects.toMatchObject({code:'TOOL_INPUT_INVALID'});
  expect(binding.embeddingAdapter.embed).not.toHaveBeenCalled();
 });
 it('refuses a binding whose target was mutated after registration',async()=>{
  const{tools,binding}=setup();Object.assign(binding.vectorStoreAdapter.target,{collection:'another-business'});
  await expect(tools.indexChunks.execute({targetId:'test-only',records:[]})).rejects.toMatchObject({code:'TOOL_TARGET_UNAVAILABLE'});
 });
});
