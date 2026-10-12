import { loadConfig } from '../config/config.js';
import { poolFor } from '../plugins/dependencies.js';
import { AdminService } from '../modules/admin/service.js';
export async function adminCli(action:'bootstrap'|'revoke'){
 const config=loadConfig('admin'),pool=poolFor(config);
 try {
  let input='';for await(const chunk of process.stdin){input+=String(chunk);if(input.length>4096)throw new Error('CLI_INPUT_TOO_LARGE');}
  const data=JSON.parse(input) as {username?:unknown;password?:unknown;reason?:unknown};
  if(typeof data.username!=='string')throw new Error('USERNAME_REQUIRED');
  const service=new AdminService(pool,config.adminSessionSecret!);
  if(action==='bootstrap'){
   if(typeof data.password!=='string')throw new Error('PASSWORD_REQUIRED');
   console.log(JSON.stringify(await service.bootstrap(data.username,data.password)));
  }else{
   if(typeof data.reason!=='string'||!data.reason.trim()||data.reason.length>500)throw new Error('REASON_REQUIRED');
   console.log(JSON.stringify(await service.revokeCli(data.username,data.reason)));
  }
 }catch{console.error('ADMIN_CLI_FAILED: verify input and bootstrap/account state; no credentials printed.');process.exitCode=1;}
 finally{await pool.end();}
}
