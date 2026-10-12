import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
// Only for a new environment. Never rotate credentials on an existing volume.
if (existsSync('.env.compose.local')) throw new Error('ENV_ALREADY_EXISTS');
const endpoint = execFileSync('docker', ['context','inspect','--format','{{.Endpoints.docker.Host}}'], { encoding:'utf8' }).trim();
if (!endpoint.startsWith('unix://') || (!process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://'))) throw new Error('LOCAL_DOCKER_REQUIRED');
const resources = execFileSync('docker', ['volume','ls','--format','{{.Name}}'], { encoding:'utf8' });
const containers = execFileSync('docker', ['ps','-a','--filter','label=com.docker.compose.project=huahuo-server-dev','--format','{{.ID}}'], { encoding:'utf8' });
if (resources.split('\n').some(x => x.startsWith('huahuo-server-dev_')) || containers.trim()) throw new Error('PROJECT_RESOURCES_EXIST_NO_PASSWORD_RESET');
const env = { COMPOSE_PROJECT_NAME:'huahuo-server-dev',COMPOSE_PROFILES:'local-db',APP_ENV:'development',PROVIDER_MODE:'disabled',
 NODE_IMAGE:'node:24.14.0-bookworm-slim',PNPM_VERSION:'10.15.1',POSTGRES_IMAGE:'postgres:17.9-bookworm',REDIS_IMAGE:'redis:7.4.8-bookworm',
 BACKEND_IMAGE:'huahuo-server:p01',DATABASE_SSL_MODE:'disable',REDIS_CACHE_URL:'redis://redis:6379/0',REDIS_QUEUE_URL:'redis://redis:6379/1',
 API_BIND_HOST:'127.0.0.1',API_HOST_PORT:'3000',ADMIN_BIND_HOST:'127.0.0.1',ADMIN_HOST_PORT:'3001',APP_PUBLIC_BASE_URL:'http://127.0.0.1:3000',ADMIN_PUBLIC_BASE_URL:'http://127.0.0.1:3001' };
for (const role of ['bootstrap','migrator','api','admin','worker','scheduler']) {
 const password=randomBytes(32).toString('hex');env[`POSTGRES_${role.toUpperCase()}_PASSWORD`]=password;
 if(role!=='bootstrap') env[`DATABASE_${role==='migrator'?'MIGRATION':role.toUpperCase()}_URL`]=`postgresql://huahuo_${role}:${password}@postgres:5432/huahuo`;
}
for(const name of ['APP_TOKEN_SECRET','ADMIN_SESSION_SECRET','TOOL_TOKEN_SECRET']) env[name]=randomBytes(32).toString('hex');
writeFileSync('.env.compose.local',Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{flag:'wx',mode:0o600});
console.log('Created .env.compose.local (0600); credentials not printed.');
