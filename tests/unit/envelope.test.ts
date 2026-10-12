import { describe,it,expect } from 'vitest';
import { success,failure,requestTrace } from '../../src/contracts/envelope.js';
describe('App envelope',()=>{
 it('uses success/data/traceId and error.retryable',()=>{
  expect(success({value:1},'trace_123')).toEqual({success:true,data:{value:1},traceId:'trace_123'});
  expect(failure('BAD_REQUEST','Invalid request','trace_123')).toEqual({success:false,error:{code:'BAD_REQUEST',message:'Invalid request',userMessageKey:'api.error.BAD_REQUEST',retryable:false},traceId:'trace_123'});
 });
 it('accepts safe App trace IDs and replaces unsafe or array input',()=>{
  expect(requestTrace({'x-trace-id':'trace_docs_fixture'})).toBe('trace_docs_fixture');
  for(const value of ['bad','/Users/private', ['trace_docs_fixture']]) expect(requestTrace({'x-trace-id':value})).toMatch(/^[a-f0-9-]{36}$/);
 });
});
