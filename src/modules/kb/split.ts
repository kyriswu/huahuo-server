import { createHash } from 'node:crypto';
import { analyzeDocumentStructure } from '../../lib/document-processing/structure.js';
import type { DocumentStructure, TokenCounter } from '../../lib/document-processing/types.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export interface KbDraft {
  ordinal: number; start: number; end: number; coreStart: number; coreEnd: number;
  sectionId: string | null; headingPath: string[]; content: string; embeddingText: string;
  contentHash: string; inputHash: string; charCount: number; tokenCount: number;
}
function boundaries(text: string, start: number, end: number,limit=Number.POSITIVE_INFINITY): number[] {
  const result = [start]; let at = start;
  for (const char of text.slice(start,Math.min(end,start+limit*2))) { if(result.length>limit)break;at += char.length; result.push(at); }
  return result;
}
function paragraphs(content: string, start: number, end: number) {
  const ranges: Array<{sourceStart:number;sourceEnd:number;sectionId:null;headingPath:string[]}> = [];
  let at=start;
  for(const match of content.slice(start,end).matchAll(/(?:\r?\n)[\t ]*(?:\r?\n)+/gu)){
    const next=start+match.index+match[0].length;
    ranges.push({sourceStart:at,sourceEnd:next,sectionId:null,headingPath:[]});at=next;
  }
  if(at<end)ranges.push({sourceStart:at,sourceEnd:end,sectionId:null,headingPath:[]});
  return ranges;
}
function cut(content: string, start: number, limit: number, end: number): number {
  if(limit>=end)return end;
  const window=content.slice(start,limit);
  const paragraph=[...window.matchAll(/\r?\n[\t ]*\r?\n/gu)].at(-1);
  if(paragraph)return start+paragraph.index+paragraph[0].length;
  const sentence=[...window.matchAll(/[。！？；]|[.!?;](?:\s|$)|\n/gu)].at(-1);
  return sentence ? start+sentence.index+sentence[0].length : limit;
}
/** Embedding carries stable asset identifiers and OCR, never a signed URL. */
export function embeddingText(content: string, headings: string[]): string {
  return (headings.length ? headings.join(' > ')+'\n\n' : '') + content
    .replace(/data:[^\s)]+/giu,'')
    .replace(/https?:\/\/[^\s)]+/giu,'');
}
/** Both modes preserve original UTF-16 positions. Keyword never receives a tokenizer. */
export async function splitKnowledgeContent(content: string, mode: 'note-hybrid'|'document-keyword', options: {
  format?:'text'|'markdown'; structure?:DocumentStructure; tokenizer?:TokenCounter;
} = {}): Promise<{chunks:KbDraft[];structure?:DocumentStructure}> {
  const max=mode==='note-hybrid'?500:2000;
  const structure=mode==='note-hybrid' ? options.structure ?? await analyzeDocumentStructure(content,{format:options.format??'markdown'}) : undefined;
  const ranges=structure?.toc.length ? structure.ranges : paragraphs(content,0,content.length);
  const chunks:KbDraft[]=[];
  if(mode==='note-hybrid'&&!options.tokenizer)throw new Error('KB_TOKENIZER_REQUIRED');
  for(const range of ranges){
    let cursor=range.sourceStart;
    while(cursor<range.sourceEnd){
      const previous=chunks.at(-1);
      let start=cursor;
      if(mode==='note-hybrid'&&previous&&previous.coreEnd===cursor&&previous.coreStart>=range.sourceStart){
        const overlap=boundaries(content,previous.coreStart,cursor);
        start=overlap[Math.max(0,overlap.length-1-50)]!;
      }
      const points=boundaries(content,start,range.sourceEnd,max);
      let end=cut(content,cursor,points[Math.min(max,points.length-1)]!,range.sourceEnd);
      if(end<=cursor){start=cursor;const core=boundaries(content,cursor,range.sourceEnd,max);end=core[Math.min(max,core.length-1)]!;}
      let raw=content.slice(start,end);
      let input=mode==='note-hybrid'?embeddingText(raw,range.headingPath):raw;
      let tokens=mode==='note-hybrid'?await options.tokenizer!.count(input):0;
      // Shrink generated context first; if necessary split the source without dropping a codepoint.
      if(mode==='note-hybrid'&&tokens>8192){input=embeddingText(raw,[]);tokens=await options.tokenizer!.count(input);}
      while(mode==='note-hybrid'&&tokens>Math.min(8192,options.tokenizer!.maxInputTokens)){
        const core=boundaries(content,cursor,end);
        if(core.length<=2)throw new Error('KB_MODEL_INPUT_TOO_LONG');
        end=core[Math.max(1,Math.floor((core.length-1)/2))]!;
        start=cursor;raw=content.slice(start,end);input=embeddingText(raw,[]);tokens=await options.tokenizer!.count(input);
      }
      if(raw.trim())chunks.push({ordinal:chunks.length,start,end,coreStart:cursor,coreEnd:end,
        sectionId:range.sectionId,headingPath:range.headingPath,content:raw,embeddingText:input,
        contentHash:digest(raw),inputHash:digest(input),charCount:Array.from(raw).length,tokenCount:tokens});
      cursor=end;
    }
  }
  return {chunks,...(structure?{structure}:{})};
}
