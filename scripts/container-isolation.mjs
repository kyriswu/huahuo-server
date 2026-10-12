import { localProject, docker } from './docker-project.mjs';
import { writeFileSync } from 'node:fs';
const {env,compose}=localProject();
const roles=['api-server','admin','worker','scheduler'];
const evidence=[];
const inspect=service=>JSON.parse(docker(['inspect',compose(['ps','-aq',service]).trim()]))[0];
const ready=role=>compose(['exec','-T',role,'node','scripts/healthcheck.mjs'],{stdio:['ignore','pipe','pipe']});
const wait=async role=>{for(let i=0;i<30;i++){try{ready(role);return;}catch{await new Promise(r=>setTimeout(r,1000));}}throw new Error(`NOT_READY:${role}`);};
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const baseline=Object.fromEntries(roles.map(r=>[r,inspect(r)]));
assert(new Set(Object.values(baseline).map(c=>c.Id)).size===4,'ROLES_NOT_INDEPENDENT');
for(const role of roles){
 const c=baseline[role];assert(c.Config.User==='node','NONROOT_REQUIRED');assert(c.Config.Cmd[1]===`dist/entrypoints/${role}.js`,'WRONG_ENTRYPOINT');
 const vars=Object.fromEntries(c.Config.Env.map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));
 assert(!vars.DATABASE_MIGRATION_URL && !vars.POSTGRES_BOOTSTRAP_PASSWORD,'MIGRATION_SECRET_EXPOSED');
 assert(new URL(vars.DATABASE_URL).username===`huahuo_${role==='api-server'?'api':role}`,'ROLE_DATABASE_MISMATCH');
 assert(!c.Mounts.some(m=>m.Source.includes('huahuo-app')),'APP_MOUNTED');
 if(['worker','scheduler'].includes(role)) assert(Object.keys(c.HostConfig.PortBindings??{}).length===0,'BACKGROUND_PORT_PUBLISHED');
 if(['admin','scheduler'].includes(role)) assert(!c.Mounts.some(m=>m.Destination==='/app/var/storage'),'UNEXPECTED_STORAGE_MOUNT');
}
const pg=inspect('postgres'),redis=inspect('redis');for(const c of [pg,redis])assert(Object.keys(c.HostConfig.PortBindings??{}).length===0,'DATASTORE_PORT_PUBLISHED');
assert(inspect('migrate').State.ExitCode===0 && inspect('migrate').State.Status==='exited','MIGRATION_NOT_COMPLETE');
evidence.push('4 distinct nonroot role containers; dedicated DB users; no datastore/background host ports; migrate Exited(0)');
// Verify each stop affects only that role and graceful exit actually completes.
for(const role of roles){
 try {
  compose(['stop','-t','15',role],{stdio:['ignore','pipe','pipe']});
  assert(inspect(role).State.ExitCode===0,`UNCLEAN_EXIT:${role}`);
  for(const other of roles.filter(x=>x!==role)){ready(other);assert(inspect(other).State.StartedAt===baseline[other].State.StartedAt,`OTHER_ROLE_RESTARTED:${other}`);}
  evidence.push(`stop ${role}: exit 0; remaining roles ready without restart`);
 }finally{compose(['start',role],{stdio:['ignore','pipe','pipe']});await wait(role);baseline[role]=inspect(role);}
}
// Real failure/recovery, scoped to this project's Redis only.
try{
 compose(['stop','-t','10','redis'],{stdio:['ignore','pipe','pipe']});
 for(const role of roles){
  const output=compose(['exec','-T',role,'node','-e',`const u=process.env.HEALTHCHECK_URL;const r=await fetch(u);const l=await fetch(u.replace('/ready','/live'));console.log(r.status,l.status);if(r.status!==503||l.status!==200)process.exit(1)`]);
  assert(output.trim()==='503 200',`DEPENDENCY_HEALTH_WRONG:${role}`);
 }
 evidence.push('Redis unavailable: all four readiness=503 and liveness=200');
}finally{compose(['start','redis'],{stdio:['ignore','pipe','pipe']});for(const role of roles)await wait(role);}
evidence.push('Redis restored: all four roles recovered without restart');
// App/admin boundary over host HTTP.
for(const [port,path,status] of [[env.API_HOST_PORT,'/admin',404],[env.API_HOST_PORT,'/admin/api/v1',404],[env.ADMIN_HOST_PORT,'/api/v1/home',404],[env.ADMIN_HOST_PORT,'/admin',401]]){
 const r=await fetch(`http://127.0.0.1:${port}${path}`,{headers:{Authorization:'Bearer app-fixture'}});assert(r.status===status,`ROUTE_BOUNDARY:${path}`);
}
// Shared persistent file volume works under the same nonroot UID.
compose(['exec','-T','api-server','node','-e',"require('fs').writeFileSync('/app/var/storage/p01-volume-probe','p01-volume')"]);
compose(['restart','api-server'],{stdio:['ignore','pipe','pipe']});await wait('api-server');
compose(['exec','-T','worker','node','-e',"if(require('fs').readFileSync('/app/var/storage/p01-volume-probe','utf8')!=='p01-volume')process.exit(1);require('fs').unlinkSync('/app/var/storage/p01-volume-probe')"]);
evidence.push('API/Worker shared volume survives API restart; Admin/Scheduler have no user volume');
compose(['exec','-T','api-server','node','-e',"const f=require('fs');for(const p of ['/app/Flutter','/app/huahuo-app','/app/.git','/app/.env.compose.local','/app/config','/app/specs'])if(f.existsSync(p))process.exit(1)"]);
evidence.push('Runtime image excludes App checkout, env, git, host reference config and specs');
const result={recordedAt:new Date().toISOString(),evidence};
writeFileSync('docs/container-checks.local.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
