import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { expect, it, vi } from 'vitest';
import { buildBase } from '../../src/apps/base.js';
import { registerAssetRoutes } from '../../src/modules/assets/routes.js';
import { AssetService } from '../../src/modules/assets/service.js';
import type { StorageService } from '../../src/modules/storage/service.js';
import { config, dependencies } from '../helpers.js';

it('rejects explicit extraction while disabled after checking ownership, without persisting a task or receipt',async()=>{
 const cfg=config(),id=randomUUID();let session=true,workspace=true,note=true;
 const query=vi.fn(async(sql:string)=>{
  let rows:Record<string,unknown>[]=[];
  if(sql.includes('FROM user_sessions'))rows=session?[{id}]:[];
  else if(sql.startsWith('SELECT id FROM workspaces'))rows=workspace?[{id}]:[];
  else if(sql.startsWith('SELECT * FROM notes'))rows=note?[{note_revision_id:id}]:[];
  else if(!['BEGIN','ROLLBACK'].includes(sql)&&!sql.startsWith('SELECT pg_advisory_xact_lock')&&!sql.startsWith('SELECT request_hash'))throw Error('UNEXPECTED_QUERY:'+sql);
  return {rows,rowCount:rows.length};
 });
 const client={query,on:vi.fn(),removeListener:vi.fn(),release:vi.fn()};
 const assets=new AssetService({connect:async()=>client} as unknown as pg.Pool,cfg.appTokenSecret!,cfg);
 const app=await buildBase({config:cfg,dependencies:dependencies()});
 registerAssetRoutes(app,assets,{} as StorageService);
 const request=()=>app.inject({method:'POST',url:`/api/v1/workspaces/${id}/notes/${id}/tag-extractions`,
  headers:{'x-huahuo-user-id':id,'x-huahuo-session-id':id,'x-huahuo-auth-method':'bearer','x-idempotency-key':randomUUID()},payload:{}});
 try{
  const disabled=await request();expect(disabled.statusCode,disabled.body).toBe(503);
  expect(disabled.json()).toMatchObject({success:false,error:{code:'TAG_PROVIDER_UNAVAILABLE'}});
  note=false;const missing=await request();expect(missing.statusCode).toBe(404);expect(missing.json().error.code).toBe('NOTE_NOT_FOUND');
  workspace=false;const foreign=await request();expect(foreign.statusCode).toBe(404);expect(foreign.json().error.code).toBe('WORKSPACE_NOT_FOUND');
  session=false;expect((await request()).statusCode).toBe(401);
  expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
 }finally{await app.close();}
});
