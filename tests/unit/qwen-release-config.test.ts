import { describe, expect, it } from 'vitest';
// @ts-expect-error reviewed release tooling uses portable JavaScript
import { verifyQwenConfiguration } from '../../scripts/release/changes/20261116-gateway-qwen37/verify-config.mjs';

const base={SERVICE_ROLE:'api-server',APP_ENV:'test',RAG_EMBEDDING_MODEL:'qwen3.7-text-embedding-flash',RAG_EMBEDDING_DIMENSIONS:'1024',
  RAG_EMBEDDING_PROFILE:'qwen3.7-text-embedding-flash-1024-fp16',RAG_RERANK_MODEL:'qwen3.7-text-rerank',RAG_PROVIDER_MODE:'live',RAG_RERANK_PROVIDER:'http',
  RAG_EMBEDDING_API_KEY:'sk-fixture',RAG_RERANK_API_KEY:'sk-fixture'};
const publicUrl='https://ws-fixture.cn-beijing.maas.aliyuncs.com/api/v1';
const privateUrl='https://ws-fixture-vpc-endpoint.cn-beijing.maas.aliyuncs.com/api/v1';
const withUrl=(url:string)=>({...base,RAG_EMBEDDING_BASE_URL:url,RAG_RERANK_BASE_URL:url});
describe('Qwen release target assertions, no network or model calls',()=>{
  it('uses explicit execution location even when local APP_ENV is test',()=>{
    expect(()=>verifyQwenConfiguration(withUrl(publicUrl),'public')).not.toThrow();
    expect(()=>verifyQwenConfiguration(withUrl(publicUrl))).toThrow('QWEN_ENDPOINT_TARGET_MISMATCH');
    expect(()=>verifyQwenConfiguration(withUrl(privateUrl))).not.toThrow();
    expect(()=>verifyQwenConfiguration(withUrl(privateUrl),'public')).toThrow('QWEN_ENDPOINT_TARGET_MISMATCH');
  });
  it.each([
    {RAG_EMBEDDING_MODEL:'retired-model'},
    {RAG_EMBEDDING_PROFILE:'retired-profile'},
    {RAG_EMBEDDING_DIMENSIONS:'2048'},
    {RAG_RERANK_MODEL:'retired-reranker'},
    {RAG_EMBEDDING_API_KEY:''},
    {RAG_RERANK_API_KEY:'sk-other-fixture'},
    {RAG_EMBEDDING_BASE_URL:privateUrl.replace('cn-beijing','ap-southeast-1')},
    {RAG_EMBEDDING_BASE_URL:privateUrl+'?token=fixture'},
    {RAG_EMBEDDING_BASE_URL:privateUrl.replace('https:','http:')},
  ])('rejects a wrong model, region, network or credential pair (%j)',patch=>{
    expect(()=>verifyQwenConfiguration({...withUrl(privateUrl),...patch})).toThrow();
  });
  it('does not demand unused model secrets from the migration role',()=>{
    expect(()=>verifyQwenConfiguration({SERVICE_ROLE:'migrate'})).not.toThrow();
  });
});
