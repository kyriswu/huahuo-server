import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { EmbeddingAdapter } from '../../lib/rag-indexing/index.js';
import type { StoragePort } from '../storage/port.js';

/** Business stage artifact, outside PG. Keys contain only identity/text hashes.
 * A Worker restart can retry vector writes without paying for Embedding again. */
export function cachedEmbedding(adapter:EmbeddingAdapter,storage:StoragePort,scope:string):EmbeddingAdapter{
  return {model:adapter.model,dimensions:adapter.dimensions,async embed(texts,options){
    options?.signal?.throwIfAborted();
    const digest=createHash('sha256').update(JSON.stringify([scope,adapter.model,adapter.dimensions,texts])).digest('hex');
    const key=`rag/index-artifacts/${digest}.json`;
    let cachePresent=false;
    try{
      const stream=await storage.read(key);cachePresent=true;
      const parts:Buffer[]=[];let bytes=0;for await(const part of stream){const chunk=Buffer.from(part);bytes+=chunk.length;if(bytes>32*1024*1024)throw new Error('EMBEDDING_CACHE_TOO_LARGE');parts.push(chunk);}
      const cached:unknown=JSON.parse(Buffer.concat(parts).toString('utf8'));
      if(Array.isArray(cached)&&cached.length===texts.length&&cached.every(v=>Array.isArray(v)&&v.length===adapter.dimensions&&v.every(n=>typeof n==='number'&&Number.isFinite(n))&&v.some(n=>n!==0)))return cached as number[][];
      throw new Error('EMBEDDING_CACHE_INVALID');
    }catch{
      // This key is an application-owned stage artifact, never a source object.
      if(cachePresent)await storage.remove(key);
    }
    options?.signal?.throwIfAborted();
    const vectors=await adapter.embed(texts,options);
    if(vectors.length!==texts.length||vectors.some(v=>v.length!==adapter.dimensions||v.some(n=>!Number.isFinite(n))||v.every(n=>n===0)))throw new Error('EMBEDDING_RESPONSE_INVALID');
    const body=Buffer.from(JSON.stringify(vectors));
    try{await storage.put(key,Readable.from([body]),'application/json',32*1024*1024);}catch(error){
      // Local immutable-object publication races are safe only if the cache exists.
      try{await storage.stat(key,'application/json');}catch{throw error;}
    }
    return vectors;
  }};
}
