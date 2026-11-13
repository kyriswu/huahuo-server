import {describe,it,expect} from 'vitest';
import {splitKnowledgeContent} from '../../src/modules/kb/split.js';
import {kbSnapshot,kbTokenizer} from '../../src/modules/kb/profile.js';
import {config} from '../helpers.js';
const tokenizer=await kbTokenizer(kbSnapshot(config(),'note-hybrid','markdown'));
describe('knowledge base character rules and pinned real BGE tokenizer',()=>{
 it('loads official pinned XLM-R tokenizer and counts actual tokens',async()=>{
  expect(tokenizer.model).toBe('BAAI/bge-m3');expect(tokenizer.maxInputTokens).toBe(8192);
  expect(tokenizer.id).toContain('21106b6d7dab2952');
  expect(await tokenizer.count('Hello world')).toBe(4);
 });
 it.each(['note-hybrid','document-keyword'] as const)('prefers Chinese sentence boundaries without requiring a following space in %s',async mode=>{
  const max=mode==='note-hybrid'?500:2000;
  const body='甲'.repeat(max-30)+'。'+'乙'.repeat(100);
  const {chunks}=await splitKnowledgeContent(body,mode,{tokenizer});
  expect(chunks[0]!.end).toBe(max-29);
  expect(chunks[0]!.content.endsWith('。')).toBe(true);
  expect(chunks.map(c=>body.slice(c.coreStart,c.coreEnd)).join('')).toBe(body);
 });
 it.each(['中文句子。'.repeat(180),'hello world! '.repeat(200),'😀中文🧑‍💻'.repeat(200),'x'.repeat(8000),'同一段。\n\n'.repeat(500),'```ts\n'+('const a=1;\n'.repeat(180))+'```','|a|b|\n|-|-|\n'+('|1|2|\n'.repeat(500))])('covers the original with exact offsets and caps in both modes',async content=>{
  for(const mode of ['note-hybrid','document-keyword'] as const){
   const {chunks}=await splitKnowledgeContent(content,mode,{tokenizer});
   expect(chunks.length).toBeGreaterThan(0);let previous=0;
   for(const c of chunks){expect(content.slice(c.start,c.end)).toBe(c.content);expect(c.charCount).toBeLessThanOrEqual(mode==='note-hybrid'?500:2000);expect(c.coreStart).toBe(previous);expect(c.coreEnd).toBeGreaterThan(c.coreStart);expect(c.tokenCount).toBeLessThanOrEqual(8192);previous=c.coreEnd;}
   expect(chunks.map(c=>content.slice(c.coreStart,c.coreEnd)).join('')).toBe(content);
   if(mode==='document-keyword')expect(chunks.every(c=>c.start===c.coreStart&&c.tokenCount===0)).toBe(true);
  }
 });
 it('respects nested headings without duplicate cores and keeps short sections intact',async()=>{
  const body='# A\nintro\n\n## B\n'+('b'.repeat(1700))+'\n\n###### C\nshort\n';
  const {chunks,structure}=await splitKnowledgeContent(body,'note-hybrid',{tokenizer});
  expect(structure!.toc[0]!.children[0]!.children[0]!.level).toBe(6);
  expect(chunks.map(c=>body.slice(c.coreStart,c.coreEnd)).join('')).toBe(body);
  expect(chunks.find(c=>c.content.includes('short'))!.content).toBe('###### C\nshort\n');
  expect(chunks.some(c=>c.start<c.coreStart)).toBe(true);
 });
 it('does not treat fenced OCR as headings and retains stable image references',async()=>{
  const body='```\n# fake\n```\n\n![img](asset://images/abc.png)\n图片文字：数据库 OCR';
  const {chunks,structure}=await splitKnowledgeContent(body,'note-hybrid',{tokenizer});
  expect(structure!.toc).toEqual([]);expect(chunks.at(-1)!.embeddingText).toContain('asset://images/abc.png');
 });
 it('never calls an injected model tokenizer in document keyword mode',async()=>{
  const broken={...tokenizer,count(){throw new Error('TOKENIZER_CALLED');}};
  const {chunks}=await splitKnowledgeContent('保留 空格\n\nnext','document-keyword',{tokenizer:broken});
  expect(chunks.map(c=>c.content).join('')).toBe('保留 空格\n\nnext');
 });
 it('empty input produces no index records',async()=>{expect((await splitKnowledgeContent(' \n\t','document-keyword')).chunks).toEqual([]);});
});
