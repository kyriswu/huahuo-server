import {extractionConfig} from '../support/extraction-config.js';
import {describe,it,expect,vi} from 'vitest';
import {DocumentExtractionClient,validateExtractionResponse,type ExtractionFile} from '../../src/integrations/document-extraction.js';
import {assertCompleteExtractionConfig,createDocumentExtractionConfig,type EnabledDocumentExtractionConfig} from '../../src/config/document-extraction.js';
import {sampleContext,sampleExtraction,sampleImage} from '../support/document-extraction.js';
const ctx={baseUrl:'http://172.18.102.101:8000',headers:{Authorization:'Bearer test-token'},signal:new AbortController().signal};
const files:ExtractionFile[]=[{...sampleContext,url:'https://files.example/document.pdf?Expires=4102444800&Signature=fixture',fileName:'document.pdf',mimeType:'application/pdf'}];
const hooks=()=>({beforeSubmit:vi.fn(async()=>undefined),submitted:vi.fn<(jobId:string)=>Promise<void>>(async()=>undefined)});
function configuration(mode:'sync'|'async'='sync'):EnabledDocumentExtractionConfig{
 const c=extractionConfig(mode);if(!c.enabled)throw new Error('TEST_CONFIG_REQUIRED');return {...c,pollMs:1};
}
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
describe('document extraction protocol; fetch is mocked, no private-network calls',()=>{
 it.each(['![image](asset://'+sampleImage+')','<img src="asset://'+sampleImage+'">'])('rejects noncanonical image markup in a parser result: %s',markup=>{
  const result=sampleExtraction();result.results[0]!.content+='\n\n'+markup;
  expect(()=>validateExtractionResponse(result,[sampleContext])).toThrow('DOCUMENT_EXTRACTION_RESPONSE_INVALID');
 });
 it('ignores examples and opaque OCR CDATA while validating canonical image ownership',()=>{
  const result=sampleExtraction(),doc=result.results[0]!;
  doc.content+='\n\n```md\n![example](https://external.test/a.png)\n<KBIMAGE uuid="not-a-resource" />\n```\n<!-- <img src="https://external.test/a.png"> -->\n';
  doc.content=doc.content.replace('<![CDATA[]]>','<![CDATA[![OCR](https://external.test/a.png) <KBIMAGE uuid="not-a-resource" />]]>');
  expect(validateExtractionResponse(result,[sampleContext])).toBe(result);
 });
 it('loads exactly the complete GPU/native-first configuration supplied by the user',()=>{
  const p=configuration().parameters!;
  expect(p).toMatchObject({output_format:'markdown',use_cache:false,force_ocr:false,ocr:{language:['chi_sim'],paddle_ocr_settings:{model_version:'pp-ocrv5',model_tier:'server',rec_batch_num:6}},extraction_timeout_secs:3000,
   acceleration:{provider:'cuda',device_id:0},images:{target_dpi:150,max_images_per_page:16,include_data_base64:false,output_format:{type:'jpeg',quality:85}},native_first:{min_native_body_chars:80,min_image_dimension:32}});
  expect(()=>assertCompleteExtractionConfig({images:{target_dpi:150}})).toThrow('INVALID_CONFIG:');
  expect(()=>assertCompleteExtractionConfig({...p,images:{...(p.images as object),include_data_base64:true}})).toThrow('INVALID_CONFIG:');
 });
 it('sends only URL inputs and ordered contexts as JSON without downloading source files',async()=>{
  const c=configuration(),body=sampleExtraction();const fetch=vi.fn<typeof globalThis.fetch>(async()=>json(body)),h=hooks();
  const result=await new DocumentExtractionClient(c,fetch).extract(files,ctx,h);
  const [url,request]=fetch.mock.calls[0]!;expect(String(url)).toBe(ctx.baseUrl+'/extract');expect(request?.redirect).toBe('error');
  expect(new Headers(request?.headers).get('authorization')).toBe('Bearer test-token');
  expect(new Headers(request?.headers).get('content-type')).toBe('application/json');
  expect(JSON.parse(String(request?.body))).toEqual({inputs:[{kind:'uri',uri:files[0]!.url,mime_type:'application/pdf'}],config:c.parameters,file_contexts:[sampleContext]});
  expect(fetch).toHaveBeenCalledTimes(1);expect(result).toEqual(body);expect(h.beforeSubmit).toHaveBeenCalledTimes(1);expect(h.submitted).not.toHaveBeenCalled();
 });
 it('omits config when using the parser service defaults',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>(async()=>json(sampleExtraction()));
  await new DocumentExtractionClient(createDocumentExtractionConfig('sync',null),fetch).extract(files,ctx,hooks());
  const body=JSON.parse(String(fetch.mock.calls[0]![1]!.body));
  expect(body).not.toHaveProperty('config');expect(body.file_contexts).toEqual([sampleContext]);
 });
 it.each(['file:///etc/passwd','http://user:password@files.example/a','https://files.example/a#fragment','invalid-url'])('rejects unsafe input URL %s before submission',async url=>{
  const fetch=vi.fn<typeof globalThis.fetch>(),h=hooks();
  await expect(new DocumentExtractionClient(configuration(),fetch).extract([{...files[0]!,url}],ctx,h)).rejects.toMatchObject({code:'DOCUMENT_EXTRACTION_INPUT_INVALID',outcome:'settled'});
  expect(fetch).not.toHaveBeenCalled();expect(h.beforeSubmit).not.toHaveBeenCalled();
 });
 it('rejects an empty or excessive URL batch before submission',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>(),client=new DocumentExtractionClient(configuration(),fetch);
  for(const batch of [[],Array.from({length:17},()=>files[0]!)])await expect(client.extract(batch,ctx,hooks())).rejects.toMatchObject({code:'DOCUMENT_EXTRACTION_INPUT_INVALID'});
  expect(fetch).not.toHaveBeenCalled();
 });
 it('preserves complete content, tables, pages, KB blocks and pre-adapter offset metadata without rewriting',()=>{
  const raw=sampleExtraction();const validated=validateExtractionResponse(raw,[sampleContext]);expect(validated).toBe(raw);
  expect(validated.results[0]!.content).toContain('3000000.00');expect(validated.results[0]!.content).toContain('<KBFORMULA');
 });
 it('keeps reliable table HTML and ignores literal KB tag examples in Markdown code',()=>{
  const raw=sampleExtraction(),doc=raw.results[0]!;
  doc.content+='\n<table><tr><td colspan="2">merged</td></tr></table>\n\n```xml\n<KBIMAGE uuid="not-a-resource">example</KBIMAGE>\n```\n';
  expect(validateExtractionResponse(raw,[sampleContext]).results[0]!.content).toBe(doc.content);
 });
 it.each(['data','base64','data_base64','local_path','path'])('rejects image %s even in otherwise successful output',async key=>{
  const raw=sampleExtraction();(raw.results[0]!.images as Array<Record<string,unknown>>)[0]![key]='forbidden';
  expect(()=>validateExtractionResponse(raw,[sampleContext])).toThrow('DOCUMENT_EXTRACTION_RESPONSE_INVALID');
 });
 it('rejects image UUIDs without confirmed uploaded-resource receipts',()=>{
  const raw=sampleExtraction();(raw.results[0]!.kb as {uploaded_resources:unknown[]}).uploaded_resources=[];
  expect(()=>validateExtractionResponse(raw,[sampleContext])).toThrow('DOCUMENT_EXTRACTION_RESPONSE_INVALID');
 });
 it('preserves repeated image receipts across pages when ownership and stored object match',()=>{
  const raw=sampleExtraction(),receipts=(raw.results[0]!.kb as {uploaded_resources:Record<string,unknown>[]}).uploaded_resources;
  receipts.push({...receipts[0],page_number:2,reused:true,upload_ms:0});
  expect(validateExtractionResponse(raw,[sampleContext])).toBe(raw);
  expect(receipts).toHaveLength(2);
 });
 it.each(['bucket','object_key','sha256','bytes','mime_type','etag','source_resource_id','parse_run_id'])('rejects repeated image receipts with conflicting %s',key=>{
  const raw=sampleExtraction(),receipts=(raw.results[0]!.kb as {uploaded_resources:Record<string,unknown>[]}).uploaded_resources;
  const changes:Record<string,unknown>={bucket:'other-bucket',object_key:'other/image.jpg',sha256:'a'.repeat(64),bytes:123,mime_type:'image/png',etag:'other-etag',source_resource_id:crypto.randomUUID(),parse_run_id:crypto.randomUUID()};
  receipts.push({...receipts[0],[key]:changes[key]});
  expect(()=>validateExtractionResponse(raw,[sampleContext])).toThrow('DOCUMENT_EXTRACTION_RESPONSE_INVALID');
 });
 it('retains input indexes on partial multi-file failure and never shifts later file contexts',async()=>{
  const second={source_resource_id:'11111111-1111-4111-8111-111111111111',parse_run_id:'22222222-2222-4222-8222-222222222222'};
  const third={source_resource_id:'33333333-3333-4333-8333-333333333333',parse_run_id:'44444444-4444-4444-8444-444444444444'};
  const body={summary:{inputs:3,results:2,errors:1},results:[sampleExtraction(sampleContext).results[0],sampleExtraction(third,2).results[0]],errors:[{index:1,error:'unreadable'}]};
  expect(validateExtractionResponse(body,[sampleContext,second,third])).toEqual(body);
  expect(()=>validateExtractionResponse(body,[sampleContext,third,second])).toThrow('DOCUMENT_EXTRACTION_RESPONSE_INVALID');
 });
 it('keeps independent image OCR null-context behavior in a mixed URL request',async()=>{
  const image:ExtractionFile={url:'https://files.example/image.png',fileName:'image.png',mimeType:'image/png'};
  const raw={summary:{inputs:2,results:2,errors:0},results:[sampleExtraction().results[0],{input_index:1,content:'image OCR',mime_type:'image/png'}],errors:[]};
  const fetch=vi.fn<typeof globalThis.fetch>(async()=>json(raw));await new DocumentExtractionClient(configuration(),fetch).extract([...files,image],ctx,hooks());
  const body=JSON.parse(String(fetch.mock.calls[0]![1]!.body));expect(body.file_contexts).toEqual([sampleContext,null]);expect(body.inputs).toHaveLength(2);
 });
 it('submits an async job once, persists its ID before querying, and unwraps result.results content',async()=>{
  const order:string[]=[],h=hooks();h.submitted.mockImplementation(async id=>{order.push('saved:'+id);});
  const fetch=vi.fn<typeof globalThis.fetch>(async(url,init)=>{
   if(init?.method==='POST'){order.push('POST');return json({job_id:'job-1'},202);}
   if(String(url).endsWith('/result')){order.push('GET-result');return json({job_id:'job-1',state:'completed',result:sampleExtraction()});}
   order.push('GET-status');return json({job_id:'job-1',state:'completed',result_state:'available'});
  });
  const result=await new DocumentExtractionClient(configuration('async'),fetch).extract(files,ctx,h);
  expect(order).toEqual(['POST','saved:job-1','GET-status','GET-result']);expect(result.results[0]!.content).toContain(sampleImage);expect(String(fetch.mock.calls[1]![0])).toMatch(/\/jobs\/job-1$/);
 });
 it('returns control after the async acceptance and sends the callback URL without a status GET',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>(async()=>json({job_id:'detached-job'},202)),h=hooks();
  await expect(new DocumentExtractionClient(configuration('async'),fetch).extract(files,ctx,{...h,singleStep:true,callbackUrl:'http://api.test/callback/test'})).rejects.toMatchObject({phase:'external'});
  expect(fetch).toHaveBeenCalledTimes(1);expect(h.submitted).toHaveBeenCalledExactlyOnceWith('detached-job');
  expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).callback_url).toBe('http://api.test/callback/test');
 });
 it('waits for a queued job to run and complete without resubmitting',async()=>{
  const states=['queued','running','completed'];
  const fetch=vi.fn<typeof globalThis.fetch>(async(url,init)=>{
   if(init?.method==='POST')return json({job_id:'job-1'},202);
   if(String(url).endsWith('/result'))return json({job_id:'job-1',state:'completed',result:sampleExtraction()});
   return json({job_id:'job-1',state:states.shift()});
  });
  const h=hooks();await new DocumentExtractionClient(configuration('async'),fetch).extract(files,ctx,h);
  expect(fetch.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
  expect(h.submitted).toHaveBeenCalledExactlyOnceWith('job-1');
  expect(states).toHaveLength(0);
 });
 it('defers an existing queued job without submitting it again',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>(async()=>json({job_id:'existing-job',state:'queued'}));
  await expect(new DocumentExtractionClient(configuration('async'),fetch).extract(files,ctx,{...hooks(),singleStep:true},'existing-job')).rejects.toMatchObject({phase:'external'});
  expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0]![1]!.method).toBe('GET');
 });
 it('still rejects an unrecognized remote job state without resubmitting',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>(async()=>json({job_id:'existing-job',state:'unexpected'}));
  await expect(new DocumentExtractionClient(configuration('async'),fetch).extract(files,ctx,hooks(),'existing-job')).rejects.toMatchObject({code:'DOCUMENT_EXTRACTION_JOB_STATE_UNKNOWN'});
  expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0]![1]!.method).toBe('GET');
 });
 it('bounds a compensation check to one pending status GET',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>(async()=>json({job_id:'existing-job',state:'running'}));
  await expect(new DocumentExtractionClient(configuration('async'),fetch).extract(files,ctx,{...hooks(),singleStep:true},'existing-job')).rejects.toMatchObject({phase:'external'});
  expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0]![1]!.method).toBe('GET');
 });
 it('resumes a persisted async job using GET only',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>(async url=>json(String(url).endsWith('/result')?{job_id:'existing-job',state:'completed',result:sampleExtraction()}:{job_id:'existing-job',state:'completed',result_state:'available'})),h=hooks();
  await new DocumentExtractionClient(configuration('async'),fetch).extract(files,ctx,h,'existing-job');expect(h.beforeSubmit).not.toHaveBeenCalled();expect(h.submitted).not.toHaveBeenCalled();expect(fetch.mock.calls.every(([,i])=>i?.method==='GET')).toBe(true);
 });
 it.each([404,500])('treats async job HTTP %s as unknown without resubmitting',async status=>{
  const fetch=vi.fn<typeof globalThis.fetch>(async()=>json({},status));
  await expect(new DocumentExtractionClient(configuration('async'),fetch).extract(files,ctx,hooks(),'existing-job')).rejects.toMatchObject({outcome:'unknown'});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('sends cancellation once and waits for a terminal GET instead of treating DELETE acceptance as completion',async()=>{
  let reads=0;const methods:string[]=[];
  const fetch=vi.fn<typeof globalThis.fetch>(async(_url,init)=>{methods.push(init?.method??'GET');return json({job_id:'job-1',state:init?.method==='DELETE'?'cancelled':++reads===1?'running':'cancelled'});});
  await expect(new DocumentExtractionClient(configuration('async'),fetch).extract(files,ctx,{...hooks(),cancellation:async()=>'send'},'job-1')).rejects.toMatchObject({code:'DOCUMENT_EXTRACTION_CANCELLED',terminalState:'cancelled',outcome:'settled'});
  expect(methods).toEqual(['DELETE','GET','GET','POST']);
 });
 it.each(['queued','pending','running'])('waits after a 202 %s result response without submitting another extraction',async state=>{
  let results=0;const fetch=vi.fn<typeof globalThis.fetch>(async url=>{
   if(String(url).endsWith('/result'))return ++results===1?json({job_id:'job-1',state},202):json({job_id:'job-1',state:'completed',result:sampleExtraction()});
   return json({job_id:'job-1',state:'completed',result_state:'available'});
  });
  await new DocumentExtractionClient(configuration('async'),fetch).extract(files,ctx,hooks(),'job-1');
  expect(results).toBe(2);expect(fetch.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
 });
 it.each([true,false])('fails a consumed result without automatic reparse (reported by status=%s)',async statusReports=>{
  const fetch=vi.fn<typeof globalThis.fetch>(async url=>String(url).endsWith('/result')?json({},410):json({job_id:'job-1',state:'completed',result_state:statusReports?'consumed':'available'}));
  await expect(new DocumentExtractionClient(configuration('async'),fetch).extract(files,ctx,hooks(),'job-1')).rejects.toMatchObject({code:'DOCUMENT_EXTRACTION_RESULT_CONSUMED',outcome:'settled',retryable:false});
  expect(fetch).toHaveBeenCalledTimes(statusReports?1:2);expect(fetch.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
 });
 it('keeps result transport loss unknown and never resubmits or acknowledges unseen output',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>(async url=>{if(String(url).endsWith('/result'))throw Error('connection lost');return json({job_id:'job-1',state:'completed',result_state:'available'});});
  await expect(new DocumentExtractionClient(configuration('async'),fetch).extract(files,ctx,hooks(),'job-1')).rejects.toMatchObject({outcome:'unknown'});
  expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
 });
 it('rejects another job in a full result envelope before publishing its content',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>(async url=>json(String(url).endsWith('/result')?{job_id:'other-job',state:'completed',result:sampleExtraction()}:{job_id:'job-1',state:'completed'}));
  await expect(new DocumentExtractionClient(configuration('async'),fetch).extract(files,ctx,hooks(),'job-1')).rejects.toMatchObject({code:'DOCUMENT_EXTRACTION_JOB_MISMATCH',outcome:'unknown'});
 });
 it('acknowledges a known failed job to release its unconsumed record',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>(async()=>json({job_id:'job-1',state:'failed'}));
  await expect(new DocumentExtractionClient(configuration('async'),fetch).extract(files,ctx,hooks(),'job-1')).rejects.toMatchObject({code:'DOCUMENT_EXTRACTION_FAILED',outcome:'settled'});
  expect(fetch.mock.calls.map(([url,init])=>[String(url),init?.method])).toEqual([[ctx.baseUrl+'/jobs/job-1','GET'],[ctx.baseUrl+'/jobs/job-1/ack','POST']]);
 });
 it('rejects a nil document context before any HTTP call',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>();await expect(new DocumentExtractionClient(configuration(),fetch).extract([{...files[0]!,parse_run_id:'00000000-0000-0000-0000-000000000000'}],ctx,hooks())).rejects.toMatchObject({outcome:'settled'});expect(fetch).not.toHaveBeenCalled();
 });
});
