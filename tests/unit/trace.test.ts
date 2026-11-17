import {describe,it,expect} from 'vitest';
import {setTimeout as pause} from 'node:timers/promises';
import {buildBase} from '../../src/apps/base.js';
import {currentTraceId,withTraceId,traceHeaders} from '../../src/lib/trace.js';
import {requestTrace} from '../../src/contracts/envelope.js';
import {config,dependencies} from '../helpers.js';

describe('one request trace',()=>{
 it('isolates concurrent HTTP requests across async work and preserves outgoing authentication',async()=>{
  const app=await buildBase({config:config(),dependencies:dependencies()});
  app.get('/trace',async req=>{await pause(req.id==='trace-first'?15:1);return {traceId:currentTraceId(),headers:Object.fromEntries(traceHeaders({authorization:'Bearer fixture'}))};});
  try{
   const results=await Promise.all(['trace-first','trace-second'].map(traceId=>app.inject({url:'/trace',headers:{'x-trace-id':traceId}})));
   results.forEach((response,index)=>{const traceId=['trace-first','trace-second'][index];expect(response.headers['x-trace-id']).toBe(traceId);expect(response.json()).toMatchObject({traceId,headers:{authorization:'Bearer fixture','x-trace-id':traceId}});expect(response.json().headers.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);});
   expect(currentTraceId()).toBeUndefined();
  }finally{await app.close();}
 });
 it('accepts callback correlation only on the callback route and rejects invalid values',()=>{
  expect(requestTrace({'x-trace-id':'callback-new'},'/internal/v1/document-parser/callbacks/id/token?traceId=original-trace')).toBe('original-trace');
  expect(requestTrace({'x-trace-id':'normal-request'},'/api/v1/notes?traceId=other-trace')).toBe('normal-request');
  expect(requestTrace({'x-trace-id':'fallback-trace'},'/internal/v1/document-parser/callbacks/id/token?traceId=bad%0Avalue')).toBe('fallback-trace');
  expect(requestTrace({'x-trace-id':'invalid\r\nheader'})).toMatch(/^[a-f0-9-]{36}$/);
  expect(requestTrace({'x-request-id':'obsolete-request-id'})).not.toBe('obsolete-request-id');
  expect(()=>withTraceId('',()=>undefined)).toThrow('TRACE_ID_INVALID');
 });
 it('keeps the original trace through nested asynchronous work',async()=>{
  await withTraceId('original-trace',async()=>{await pause(1);expect(traceHeaders().get('x-trace-id')).toBe('original-trace');});
  expect(currentTraceId()).toBeUndefined();
 });
});
