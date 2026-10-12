import { randomBytes } from 'node:crypto';
import { mkdirSync,writeFileSync,unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { localProject,docker } from './docker-project.mjs';
const {env,project,compose}=localProject(),suffix=randomBytes(6).toString('hex');
const db=`huahuo_test_http_${suffix}`,api=`huahuo-p02-api-${suffix}`,admin=`huahuo-p02-admin-${suffix}`;
const files=[],containers=[];const image=env.BACKEND_IMAGE;
mkdirSync('.local',{recursive:true});
const envFile=(name,vars)=>{const path=resolve(`.local/p02-${name}-${suffix}.env`);writeFileSync(path,Object.entries(vars).map(([k,v])=>`${k}=${v}`).join('\n'),{mode:0o600});files.push(path);return path;};
const psql=sql=>compose(['exec','-T','postgres','psql','-U','huahuo_bootstrap','-d','postgres','-v','ON_ERROR_STOP=1'],{input:sql,stdio:['pipe','pipe','pipe']});
const dbUrl=role=>{const u=new URL(env[`DATABASE_${role}_URL`]);u.pathname='/'+db;return u.toString();};
let created=false;
try{
 psql(`CREATE DATABASE ${db} OWNER huahuo_migrator; REVOKE ALL ON DATABASE ${db} FROM PUBLIC; GRANT CONNECT ON DATABASE ${db} TO huahuo_migrator,huahuo_api,huahuo_admin;`);created=true;
 const common={APP_ENV:'test',DATABASE_SSL_MODE:'disable',REDIS_CACHE_URL:'redis://redis:6379/14',REDIS_QUEUE_URL:'redis://redis:6379/15',LOG_LEVEL:'silent',HOST:'0.0.0.0',PORT:'3000'};
 const migration=envFile('migration',{APP_ENV:'test',DATABASE_URL:dbUrl('MIGRATION'),SERVICE_ROLE:'migrate'});
 docker(['run','--rm','--network',`${project}_backend`,'--env-file',migration,image,'node','dist/entrypoints/migrate.js'],{stdio:'inherit'});
 const apiEnv=envFile('api',{...common,SERVICE_ROLE:'api-server',DATABASE_URL:dbUrl('API'),APP_TOKEN_SECRET:randomBytes(32).toString('hex'),APP_PUBLIC_BASE_URL:'http://api.test',SMS_PROVIDER:'mock',ALLOW_MOCK_PROVIDERS:'true',SHOW_TEST_OTP:'true'});
 const adminEnv=envFile('admin',{...common,SERVICE_ROLE:'admin',DATABASE_URL:dbUrl('ADMIN'),ADMIN_SESSION_SECRET:randomBytes(32).toString('hex'),ADMIN_PUBLIC_BASE_URL:'http://admin.test'});
 for(const [name,file,role] of [[api,apiEnv,'api-server'],[admin,adminEnv,'admin']]){
  docker(['run','--detach','--name',name,'--label','huahuo.test=p02','--network',`${project}_backend`,'--env-file',file,image,'node',`dist/entrypoints/${role}.js`]);containers.push(name);
 }
 const password=randomBytes(24).toString('hex');
 const output=docker(['exec','-i',admin,'node','dist/entrypoints/admin-bootstrap.js'],{input:JSON.stringify({username:'e2eadmin',password}),stdio:['pipe','pipe','pipe']});
 const account=JSON.parse(output);if(!account.adminId)throw new Error('BOOTSTRAP_FAILED');
 const client=envFile('client',{TEST_API_URL:`http://${api}:3000`,TEST_ADMIN_URL:`http://${admin}:3000`,TEST_ADMIN_PASSWORD:password});
 docker(['run','--rm','--network',`${project}_backend`,'--env-file',client,'-v',`${resolve('.')}:/app`,'huahuo-server-tooling:p01','node','tests/e2e/p02-http.mjs'],{stdio:'inherit'});
 docker(['exec','-i',admin,'node','dist/entrypoints/admin-revoke-sessions.js'],{input:JSON.stringify({username:'e2eadmin',reason:'P02 HTTP CLI validation'}),stdio:['pipe','pipe','pipe']});
 writeFileSync('docs/p02-http.local.json',JSON.stringify({recordedAt:new Date().toISOString(),exitCode:0,checks:['two-user HTTP','profile persistence','refresh reuse','admin cookie/CSRF/logout','bootstrap and revoke CLI'],sms:'mock',testDatabase:'isolated temporary database; removed after test'},null,2)+'\n');
}finally{
 for(const name of containers){docker(['stop','--time','10',name],{stdio:['ignore','pipe','pipe']});docker(['rm',name],{stdio:['ignore','pipe','pipe']});}
 if(created)psql(`DROP DATABASE ${db} WITH (FORCE);`);
 for(const file of files)unlinkSync(file);
}
