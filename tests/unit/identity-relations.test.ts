import { describe,expect,it } from 'vitest';
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { IdentityService } from '../../src/modules/identity/service.js';
import { config } from '../helpers.js';

describe('identity relation boundaries',()=>{
 it('rejects a refresh record whose session is missing instead of issuing tokens or returning 500',async()=>{
  const calls:string[]=[];
  const client=Object.assign(new EventEmitter(),{
   async query(sql:string){
    calls.push(sql);
    if(sql.includes('FROM refresh_tokens'))return {rows:[{session_id:'missing-session',consumed_at:null,valid:true}],rowCount:1};
    return {rows:[],rowCount:0};
   },release(){},
  });
  const pool={async connect(){return client;}} as unknown as pg.Pool;
  await expect(new IdentityService(pool,config()).refresh(`refresh_${'a'.repeat(43)}`,'trace')).rejects.toMatchObject({statusCode:401,code:'AUTH_SESSION_EXPIRED'});
  expect(calls.some(sql=>sql.startsWith('INSERT'))).toBe(false);
  expect(calls.at(-1)).toBe('ROLLBACK');
 });
});
