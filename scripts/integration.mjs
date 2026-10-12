import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { localProject, docker } from './docker-project.mjs';
const {env,project,compose}=localProject();
const name=`huahuo_test_${randomBytes(8).toString('hex')}`;
const psql=sql=>compose(['exec','-T','postgres','psql','-U','huahuo_bootstrap','-d','postgres','-v','ON_ERROR_STOP=1'],{input:sql,stdio:['pipe','pipe','pipe']});
const envPath=resolve('.local/integration.env');mkdirSync('.local',{recursive:true});
try {
 psql(`CREATE DATABASE ${name} OWNER huahuo_migrator;\nREVOKE ALL ON DATABASE ${name} FROM PUBLIC;\nGRANT CONNECT ON DATABASE ${name} TO huahuo_migrator,huahuo_api,huahuo_admin,huahuo_worker,huahuo_scheduler;\n`);
 const vars={APP_ENV:'test',REDIS_CACHE_URL:'redis://redis:6379/14',REDIS_QUEUE_URL:'redis://redis:6379/15'};
 for(const role of ['MIGRATION','API','ADMIN','WORKER','SCHEDULER']){const url=new URL(env[`DATABASE_${role}_URL`]);url.pathname=`/${name}`;vars[`TEST_DATABASE_${role}_URL`]=url.toString();}
 writeFileSync(envPath,Object.entries(vars).map(([k,v])=>`${k}=${v}`).join('\n'),{mode:0o600});
 docker(['run','--rm','--network',`${project}_backend`,'--env-file',envPath,'-v',`${resolve('.') }:/app`,'huahuo-server-tooling:p01','pnpm','test:integration:inner'],{stdio:'inherit'});
 console.log('Real PG/Redis isolated integration suite passed.');
} finally {
 // Only the randomly generated database created by this invocation is removed.
 psql(`DROP DATABASE IF EXISTS ${name} WITH (FORCE);\n`);
 try{unlinkSync(envPath);}catch{ /* Creation may have failed. */ }
}
