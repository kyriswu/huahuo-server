import {loadConfig} from '../dist/config/config.js';
import {poolFor} from '../dist/plugins/dependencies.js';
import {sourceState} from '../dist/modules/kb/repository.js';
import {tablesForSource} from '../dist/modules/kb/types.js';
import {snapshotForSource} from '../dist/modules/kb/profile.js';
import {createMilvusClient} from '../dist/integrations/search-index/milvus.js';
const c=loadConfig('api-server'),pool=poolFor(c),client=createMilvusClient(c.milvus);
try{
 await client.connectPromise;
 for(const sourceType of ['content_asset','file']){
  const {builds,chunks}=tablesForSource(sourceType);
  const {mode,assetMetadata,target:{collection}}=snapshotForSource(c,sourceType,'markdown');
  const versions=(await pool.query(`SELECT * FROM ${builds} WHERE published AND status='ready' AND snapshot #>> '{target,collection}'=$1`,[collection])).rows;const ids=[];
  for(const build of versions){const state=await sourceState(pool,build);if(state.deleted||state.revision!==build.source_revision)continue;ids.push(...(await pool.query(`SELECT point_id FROM ${chunks} WHERE build_id=$1 AND index_status='ready'`,[build.id])).rows.map(r=>r.point_id));}
  const pg=new Set(ids),found=new Set();
  const key=assetMetadata?'chunk_id':'id',ready='index_status == "ready"';
  for(let offset=0;offset<ids.length;offset+=256){const r=await client.query({collection_name:collection,filter:`${assetMetadata?'':ready+' && '}${key} in [${ids.slice(offset,offset+256).map(JSON.stringify).join(',')}]`,output_fields:[key],consistency_level:'Strong'});if(String(r.status?.error_code)!=='Success')throw new Error('MILVUS_QUERY_FAILED');for(const row of r.data)found.add(String(row[key]));}
  const logical=await client.query({collection_name:collection,...(assetMetadata?{}:{filter:ready}),output_fields:['count(*)'],consistency_level:'Strong'});
  if(String(logical.status?.error_code)!=='Success')throw new Error('MILVUS_QUERY_FAILED');
  const count=Number(logical.data[0]?.['count(*)']);
  const stats=await client.getCollectionStatistics({collection_name:collection});
  console.log(JSON.stringify({sourceType,mode,collection,postgres_ready_unique_count:pg.size,milvus_ready_unique_count:count,missing_in_milvus_count:[...pg].filter(id=>!found.has(id)).length,unpublished_or_stale_in_milvus_count:count-found.size,milvus_physical_count:stats.data?.row_count??stats.stats?.find(p=>p.key==='row_count')?.value??null}));
 }
}finally{await client.closeConnection();await pool.end();}
