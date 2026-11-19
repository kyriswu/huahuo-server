import {loadConfig} from '../dist/config/config.js';
import {kbSnapshot,knowledgeIndex} from '../dist/modules/kb/profile.js';
// Schema verification never invokes a model and never deletes/recreates collections.
const config=loadConfig('api-server');
for(const mode of ['document-keyword','content-asset-hybrid']){
 const snapshot=kbSnapshot(config,mode,'markdown');const index=knowledgeIndex(config,snapshot);
 try{await index.ensureReady();console.log(JSON.stringify({mode,database:snapshot.target.database,collection:snapshot.target.collection,bm25:true,denseDimensions:mode==='content-asset-hybrid'?1024:null,denseStorage:mode==='content-asset-hybrid'?'Float16Vector':null,modelCalls:0}));}
 finally{await index.close();}
}
