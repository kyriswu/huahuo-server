import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
export function docker(args, options={}) { return execFileSync('docker', args, { encoding:'utf8', maxBuffer:4*1024*1024, ...options }); }
export function localProject() {
 const endpoint=docker(['context','inspect','--format','{{.Endpoints.docker.Host}}']).trim();
 if(!endpoint.startsWith('unix://') || (!process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://'))) throw new Error('LOCAL_DOCKER_REQUIRED');
 const env=Object.fromEntries(readFileSync('.env.compose.local','utf8').split('\n').filter(l=>l && !l.startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)];}));
 const project=env.COMPOSE_PROJECT_NAME;
 if(project!=='huahuo-server-dev') throw new Error('REVIEW_NONDEFAULT_PROJECT_BEFORE_TESTS');
 const compose=(args,options={})=>docker(['compose','--env-file','.env.compose.local',...args],options);
 const ids=compose(['ps','-aq']).trim().split('\n').filter(Boolean);
 if(!ids.length)throw new Error('PROJECT_NOT_STARTED');
 for(const id of ids){
  const c=JSON.parse(docker(['inspect',id]))[0];
  if(c.Config.Labels['com.docker.compose.project']!==project || realpathSync(c.Config.Labels['com.docker.compose.project.working_dir'])!==realpathSync(resolve('.')))throw new Error('RESOURCE_OWNERSHIP_MISMATCH');
 }
 return {env,project,compose};
}
