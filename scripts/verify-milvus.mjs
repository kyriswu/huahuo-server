import {loadConfig} from '../dist/config/config.js';
import {poolFor} from '../dist/plugins/dependencies.js';
import {snapshotForSource,knowledgeIndex} from '../dist/modules/kb/profile.js';

const config=loadConfig('api-server');
const pool=poolFor(config);
try {
 const sources=process.argv.includes('--asset-only')?['content_asset']:['file','content_asset'];
 for(const sourceType of sources){
  const snapshot=snapshotForSource(config,sourceType,'markdown');
  const {mode,indexLayout}=snapshot;
  const index=knowledgeIndex(config,snapshot,undefined,pool);
  try{
   await index.ensureReady();
   console.log(JSON.stringify({
    sourceType,mode,database:snapshot.target.database,collection:snapshot.target.collection,
    sparseMetric:indexLayout==='sparse-v1'?'IP':'BM25',storesBody:indexLayout!=='sparse-v1',
    denseDimensions:mode==='hybrid'?1024:null,denseStorage:mode==='hybrid'?'Float16Vector':null,modelCalls:0,
   }));
  }finally{await index.close();}
 }
}finally{await pool.end();}
