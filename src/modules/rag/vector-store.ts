import { createHash } from 'node:crypto';
import type { AppConfig } from '../../config/config.js';
import type { BoundVectorStoreAdapter, VectorTarget, VectorRecord, VectorDeleteSelector } from '../../lib/rag-indexing/index.js';
import { MilvusRepository } from './adapters/milvus.js';

export function vectorConnectionId(config: AppConfig): string {
  return 'primary-'+createHash('sha256').update(`${config.milvus.address ?? config.rag.providerMode}:${config.milvus.tls}`).digest('hex').slice(0,16);
}
function required(metadata: Readonly<Record<string,unknown>>, key: string): string {
  const value=metadata[key]; if(typeof value!=='string'||!value)throw new Error(`VECTOR_METADATA_REQUIRED:${key}`);return value;
}
export function createBusinessVectorStore(config: AppConfig, target: VectorTarget): BoundVectorStoreAdapter & {close():Promise<void>} {
  if(target.connectionId!==vectorConnectionId(config)||!target.database||!target.collection||target.partition)throw new Error('VECTOR_TARGET_UNAVAILABLE');
  const binding=Object.freeze({...target});
  // Explicit Mock mode never constructs a live client or consumes credentials.
  const repository=config.rag.providerMode==='mock'?undefined:new MilvusRepository({...config.milvus,database:target.database,collection:target.collection});
  if(config.rag.providerMode==='disabled')throw new Error('VECTOR_INDEXING_DISABLED');
  return {
    target:binding,
    async upsert(rows:readonly VectorRecord[],options){
      options?.signal?.throwIfAborted();
      const records=rows.map(row=>{
        const metadata = row.metadata;
        const parentId = required(metadata, 'parent_id');
        const sourceType = required(metadata, 'source_type');
        const content = required(metadata, 'content');
        const isNote = sourceType === 'note';
        const sourceRevision = isNote ? '' : required(metadata, 'source_revision');
        return {
          chunk: {
            id: row.id, chunkKey: row.id, parentId, sourceType, sourceRevision,
            ordinal: isNote ? 0 : Number(metadata.ordinal ?? 0), content, embeddingText: row.embeddingText,
            contentHash: createHash('sha256').update(content).digest('hex'),
            embeddingTextHash: createHash('sha256').update(row.embeddingText).digest('hex'),
            headingPath: [], tokenCount: 0, metadata: {},
          },
          embedding: row.embedding,
          documentId: isNote || typeof metadata.document_id !== 'string' ? parentId : metadata.document_id,
          documentVersion: isNote || typeof metadata.document_version !== 'string' ? sourceRevision : metadata.document_version,
          state: 'ready' as const,
          model: typeof metadata.embedding_model === 'string' ? metadata.embedding_model : config.rag.embeddingModel,
          dimensions: row.embedding.length,
          userId: required(metadata, 'user_id'), workspaceId: required(metadata, 'workspace_id'),
          embeddingProfile: required(metadata, 'embedding_profile'),
          indexBuildId: isNote ? '' : required(metadata, 'index_build_id'),
        };
      });
      await repository?.upsert(records);
    },
    async delete(selector:VectorDeleteSelector,options){options?.signal?.throwIfAborted();await repository?.deleteVectors(selector);},
    async close(){await repository?.close();},
  };
}
