import {loadConfig} from '../config/config.js';
import {poolFor} from '../plugins/dependencies.js';
import {ProcessingNodes} from '../modules/processing-nodes/service.js';

// Read-only DB/Redis inventory. Configuration changes use the authenticated Admin API.
async function main(){
 if(process.argv[2]&&process.argv[2]!=='status'||process.argv.length>3)throw Error('USAGE');
 const config=loadConfig('scheduler'),pool=poolFor(config),nodes=new ProcessingNodes(pool,config);
 try{
  const items=[];
  for(const node of await nodes.list())items.push({...node,state:await (await nodes.runtime(node)).machine.state.status()??null});
  process.stdout.write(JSON.stringify({enabled:config.processingNodes.enabled,nodes:items})+'\n');
 }finally{await nodes.close();await pool.end();}
}
main().catch(()=>{process.stderr.write('PROCESSING_NODE_STATUS_FAILED\n');process.exitCode=1;});
