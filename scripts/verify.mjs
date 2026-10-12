import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { docker, localProject } from './docker-project.mjs';
const {compose}=localProject();
const steps=[];
function run(name,fn){const started=Date.now();fn();steps.push({name,exitCode:0,durationMs:Date.now()-started});}
for(const command of ['typecheck','lint','build','test:unit','test:contract'])run(`pnpm ${command}`,()=>docker(['run','--rm','-v',`${resolve('.')}:/app`,'huahuo-server-tooling:p01','pnpm',command],{stdio:'inherit'}));
run('pnpm test:integration',()=>execFileSync(process.execPath,['scripts/integration.mjs'],{stdio:'inherit'}));
run('local compose config',()=>compose(['config','--quiet']));
run('cloud compose config',()=>{
 docker(['compose','--env-file','.env.compose.cloud.example','config','--quiet']);
 const model=JSON.parse(docker(['compose','--env-file','.env.compose.cloud.example','config','--format','json']));
 if(model.services.postgres)throw new Error('CLOUD_MODE_HAS_LOCAL_POSTGRES');
 for(const service of Object.values(model.services))if(service.depends_on?.postgres)throw new Error('CLOUD_MODE_DEPENDS_ON_POSTGRES');
});
writeFileSync('docs/verification.local.json',JSON.stringify({recordedAt:new Date().toISOString(),steps},null,2)+'\n');
console.log('Verification passed; real integration checks were executed.');
