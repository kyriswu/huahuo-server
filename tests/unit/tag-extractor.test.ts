import { describe, it, expect } from 'vitest';
import { extractBoundedTags, validateTagLabels, tagExtractorFor, type TagExtractor } from '../../src/modules/assets/tag-extractor.js';
import { loadConfig } from '../../src/config/config.js';
const input={noteId:'material',noteRevisionId:'revision',title:'title',rawText:'body'};
describe('tag provider boundary',()=>{
 it('normalizes only literal labels, validates types/count/Unicode/controls',()=>{
  expect(validateTagLabels([' ＡＩ ','ai','内容创作'])).toEqual(['AI','内容创作']);
  expect(validateTagLabels([])).toEqual([]);
  expect(validateTagLabels(['😀'.repeat(24)])).toHaveLength(1);
  for(const invalid of [null,{},['ok',1],[''],['x'.repeat(25)],Array(6).fill('same'),['bad\nlabel'],['İ'.repeat(24)]])expect(()=>validateTagLabels(invalid)).toThrow();
 });
 it('defaults to unavailable and never replaces missing live providers with fixtures',async()=>{
  expect(loadConfig('worker',{...process.env,DATABASE_URL:'postgres://x:y@localhost/x',REDIS_CACHE_URL:'redis://localhost:6379',REDIS_QUEUE_URL:'redis://localhost:6379',APP_TOKEN_SECRET:'x'.repeat(32),TAG_EXTRACTOR_PROVIDER:undefined}).tagExtractorProvider).toBe('disabled');
  for(const name of ['disabled','llm','dify'] as const)await expect(tagExtractorFor(name).extract(input)).rejects.toThrow('TAG_PROVIDER_UNAVAILABLE');
  expect(()=>loadConfig('worker',{...process.env,DATABASE_URL:'postgres://x:y@localhost/x',REDIS_CACHE_URL:'redis://localhost:6379',REDIS_QUEUE_URL:'redis://localhost:6379',APP_TOKEN_SECRET:'x'.repeat(32),APP_ENV:'production',TAG_EXTRACTOR_PROVIDER:'deterministic',ALLOW_MOCK_PROVIDERS:'true'})).toThrow();
 });
 it('reads every bounded segment, merges repeated labels and enforces total call budget',async()=>{
  const seen:string[]=[];
  const provider:TagExtractor={provider:'segment-fixture',async extract(x){seen.push(x.rawText);return {provider:this.provider,labels:[x.segment!.index===0?'开头':'末尾','共同']};}};
  const result=await extractBoundedTags(provider,{...input,rawText:'a'.repeat(16_000)+'ending'});
  expect(seen).toEqual(['a'.repeat(16_000),'ending']);expect(result.labels).toEqual(['共同','开头','末尾']);
  await expect(extractBoundedTags(provider,{...input,rawText:'a'.repeat(512_001)})).rejects.toThrow('BUDGET');expect(seen).toHaveLength(2);
 });
 it('rejects a malformed later segment instead of committing a partial set',async()=>{
  const provider:TagExtractor={provider:'bad-fixture',async extract(x){return {provider:this.provider,labels:x.segment!.index===0?['valid']:{bad:true}};}};
  await expect(extractBoundedTags(provider,{...input,rawText:'a'.repeat(16_001)})).rejects.toThrow('TAG_OUTPUT');
 });
});
