import { describe, expect, it } from 'vitest';
import { DataType, FunctionType } from '@zilliz/milvus2-sdk-node';
import {
  BM25_FUNCTION,
  buildMilvusSchema,
  detectChunkLanguage,
  MILVUS_OUTPUT_FIELDS,
  MULTI_ANALYZER_PARAMS,
} from '../../src/modules/rag/adapters/milvus-schema.js';

describe('RAG language routing', () => {
  it.each([
    ['PostgreSQL 是一个关系型数据库，支持 MVCC 和 B-tree 索引。', 'zh'],
    ['PostgreSQL is a relational database supporting MVCC and B-tree indexes.', 'en'],
    ['PostgreSQL 数据库支持 MVCC，使用 B-tree Index 优化查询性能。', 'mixed'],
    ['数据库索引和多版本并发控制', 'zh'],
    ['MVCC B-tree', 'en'],
    ['', 'unknown'],
    ['1234 + 5678 🚀', 'unknown'],
    ['данные хранятся в базе', 'unknown'],
  ])('routes %j to %s', (text, expected) => {
    expect(detectChunkLanguage(text)).toBe(expected);
  });

  it('does not let stable image references and URLs change the prose language', () => {
    expect(detectChunkLanguage('中文内容 asset://images/abc123.jpg https://example.com/long/english/path')).toBe('zh');
    expect(detectChunkLanguage('asset://images/abc123.jpg')).toBe('unknown');
  });
});

describe('Milvus v2 schema contract', () => {
  it('uses one text field and a native BM25 function with configurable dense dimensions', () => {
    const fields = buildMilvusSchema(4096);
    const field = (name: string) => fields.find(value => value.name === name);
    expect(field('id')).toMatchObject({ is_primary_key: true, autoID: false, max_length: 256 });
    expect(field('parent_id')).toMatchObject({ default_value: '' });
    expect(field('dense_vector')).toMatchObject({ data_type: DataType.FloatVector, dim: 4096 });
    expect(buildMilvusSchema(1024).find(value => value.name === 'dense_vector')?.dim).toBe(1024);
    expect(field('text')).toMatchObject({ max_length: 65535, enable_analyzer: true, multi_analyzer_params: MULTI_ANALYZER_PARAMS });
    expect(field('sparse_vector')).toMatchObject({ data_type: DataType.SparseFloatVector, is_function_output: true });
    expect(BM25_FUNCTION).toMatchObject({ type: FunctionType.BM25, input_field_names: ['text'], output_field_names: ['sparse_vector'] });
    expect(MILVUS_OUTPUT_FIELDS).not.toContain('sparse_vector');
    expect(MILVUS_OUTPUT_FIELDS).not.toContain('dense_vector');
  });

  it('keeps analyzer settings independent across collection creation attempts', () => {
    const first = buildMilvusSchema(4096).find(field => field.name === 'text');
    const second = buildMilvusSchema(4096).find(field => field.name === 'text');
    expect(first?.multi_analyzer_params).toEqual(second?.multi_analyzer_params);
    expect(first?.multi_analyzer_params).not.toBe(second?.multi_analyzer_params);
    expect(MULTI_ANALYZER_PARAMS.analyzers.zh).toEqual(MULTI_ANALYZER_PARAMS.analyzers.mixed);
    expect(MULTI_ANALYZER_PARAMS.alias.unknown).toBe('default');
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid dense dimension %s', dimensions => {
    expect(() => buildMilvusSchema(dimensions)).toThrow('MILVUS_INVALID_DIMENSIONS');
  });
});
