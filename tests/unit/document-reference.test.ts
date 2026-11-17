import {describe,expect,it} from 'vitest';
import {decodeDocumentReference,encodeDocumentReference,type DocumentParseState} from '../../src/modules/ingestion/document-reference.js';

describe('durable document submission identity',()=>{
 const intent:DocumentParseState={phase:'intent',requestId:'task:parse:1',fingerprint:'a'.repeat(64),startedAt:123};
 it('preserves the admission identity and source snapshot when a receipt binds the job',()=>{
  expect(decodeDocumentReference(encodeDocumentReference(intent))).toEqual(intent);
  const bound={...intent,phase:'job' as const,jobId:'remote-job_1'};
  expect(decodeDocumentReference(encodeDocumentReference(bound))).toEqual(bound);
 });
 it.each([
  {...intent,phase:'job'},
  {...intent,phase:'cancelling'},
  {...intent,requestId:''},
  {...intent,fingerprint:'wrong'},
  {...intent,jobId:'../bad'},
 ])('rejects incomplete or malformed submission receipts',state=>{
  expect(()=>decodeDocumentReference(encodeDocumentReference(state as DocumentParseState))).toThrow('DOCUMENT_EXTRACTION_STATE_INVALID');
 });
 it('rejects phase disagreement and malformed payloads while ignoring other providers',()=>{
  expect(()=>decodeDocumentReference(encodeDocumentReference(intent).replace('xberg-intent:','xberg-job:'))).toThrow('DOCUMENT_EXTRACTION_STATE_INVALID');
  expect(()=>decodeDocumentReference('xberg-intent:bad')).toThrow('DOCUMENT_EXTRACTION_STATE_INVALID');
  expect(decodeDocumentReference('node-start:other')).toBeUndefined();expect(decodeDocumentReference(null)).toBeUndefined();
 });
});
