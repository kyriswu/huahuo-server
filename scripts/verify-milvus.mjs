import {loadConfig} from '../dist/config/config.js';
import {snapshotForSource,knowledgeIndex} from '../dist/modules/kb/profile.js';
// Schema verification never invokes a model and never deletes/recreates collections.
const config=loadConfig('api-server');
for(const sourceType of ['file','content_asset']){
 const snapshot=snapshotForSource(config,sourceType,'markdown');
 const {mode}=snapshot;const index=knowledgeIndex(config,snapshot);
 try{await index.ensureReady();console.log(JSON.stringify({sourceType,mode,database:snapshot.target.database,collection:snapshot.target.collection,bm25:true,denseDimensions:mode==='hybrid'?1024:null,denseStorage:mode==='hybrid'?'Float16Vector':null,modelCalls:0}));}
 finally{await index.close();}
}
