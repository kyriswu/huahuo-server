import { randomBytes } from 'node:crypto';
import { mkdirSync,writeFileSync,unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { localProject,docker } from './docker-project.mjs';
const {env,project,compose}=localProject(),suffix=randomBytes(6).toString('hex');
const db=`huahuo_test_p03_${suffix}`,containers=[];const image='huahuo-server:p03',files=[];
const psql=sql=>compose(['exec','-T','postgres','psql','-U','huahuo_bootstrap','-d','postgres','-v','ON_ERROR_STOP=1'],{input:sql,stdio:['pipe','pipe','pipe']});
const dbUrl=role=>{const u=new URL(env[`DATABASE_${role}_URL`]);u.pathname='/'+db;return u.toString();};
const envFile=(name,vars)=>{mkdirSync('.local',{recursive:true});const p=resolve(`.local/p03-${name}-${suffix}.env`);writeFileSync(p,Object.entries(vars).map(([k,v])=>`${k}=${v}`).join('\n'),{mode:0o600});files.push(p);return p;};
let created=false;try{
 psql(`CREATE DATABASE ${db} OWNER huahuo_migrator; REVOKE ALL ON DATABASE ${db} FROM PUBLIC; GRANT CONNECT ON DATABASE ${db} TO huahuo_migrator,huahuo_api,huahuo_worker,huahuo_scheduler;`);created=true;
 const base={APP_ENV:'test',DATABASE_SSL_MODE:'disable',REDIS_CACHE_URL:'redis://redis:6379/14',REDIS_QUEUE_URL:'redis://redis:6379/15',REDIS_KEY_PREFIX:`p03-${suffix}`,HOST:'0.0.0.0',PORT:'3000',TASK_LEASE_MS:'3000',TASK_REDELIVERY_MS:'1000',SCHEDULER_INTERVAL_MS:'100',USER_AGREEMENT_VERSION:'2026-08-20',PRIVACY_POLICY_VERSION:'2026-08-20'};
 const migration=envFile('migration',{APP_ENV:'test',DATABASE_URL:dbUrl('MIGRATION'),SERVICE_ROLE:'migrate'});docker(['run','--rm','--network',`${project}_backend`,'--env-file',migration,image,'node','dist/entrypoints/migrate.js'],{stdio:'inherit'});
 const apiEnv=envFile('api',{...base,SERVICE_ROLE:'api-server',DATABASE_URL:dbUrl('API'),APP_TOKEN_SECRET:randomBytes(32).toString('hex'),APP_PUBLIC_BASE_URL:'http://api.test',SMS_PROVIDER:'mock',ALLOW_MOCK_PROVIDERS:'true',SHOW_TEST_OTP:'true',ENABLE_DEMO_TASKS:'true'});
 const workerEnv=envFile('worker',{...base,SERVICE_ROLE:'worker',DATABASE_URL:dbUrl('WORKER'),WORKER_QUEUES:'content'});
 const schedulerEnv=envFile('scheduler',{...base,SERVICE_ROLE:'scheduler',DATABASE_URL:dbUrl('SCHEDULER')});
 for(const [name,file,role] of [['p03-api-'+suffix,apiEnv,'api-server'],['p03-worker-'+suffix,workerEnv,'worker'],['p03-scheduler-'+suffix,schedulerEnv,'scheduler']]){docker(['run','-d','--name',name,'--label','huahuo.test=p03','--network',`${project}_backend`,'--env-file',file,image,'node',`dist/entrypoints/${role}.js`]);containers.push(name);}
 const apiName=`p03-api-${suffix}`;
 docker(['exec',apiName,'node','-e',"for(let i=0;i<40;i++){try{const r=await fetch('http://127.0.0.1:3000/health/ready');if(r.status===200)process.exit(0)}catch{continue}await new Promise(r=>setTimeout(r,250))}process.exit(1)"],{stdio:'inherit'});
 const client=envFile('client',{TEST_API_URL:`http://${apiName}:3000`});docker(['run','--rm','--network',`${project}_backend`,'--env-file',client,'-v',`${resolve('.')}:/app`,'huahuo-server-tooling:p01','node','tests/e2e/p03-http.mjs'],{stdio:'inherit'});
 writeFileSync('docs/p03-http.local.json',JSON.stringify({recordedAt:new Date().toISOString(),exitCode:0,testDatabase:'isolated temporary database; removed after test',queues:['content'],sms:'mock'},null,2)+'\n');
}finally{for(const name of containers){docker(['stop','--time','10',name],{stdio:['ignore','pipe','pipe']});docker(['rm',name],{stdio:['ignore','pipe','pipe']});}if(created)psql(`DROP DATABASE ${db} WITH (FORCE);`);for(const f of files)try{unlinkSync(f);}catch{void 0}}
