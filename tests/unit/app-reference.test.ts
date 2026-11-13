import { describe,it,expect } from 'vitest';
// @ts-expect-error Host tooling deliberately uses portable plain JavaScript.
import { resolveRoots, compare, snapshot } from '../../scripts/app-reference.mjs';
import { mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
describe('read-only App reference',()=>{
 it('resolves from parent and Server; rejects nesting, missing paths, symlinks and permission errors',()=>{
  const temp=mkdtempSync(join(tmpdir(),'huahuo-reference-'));
  try {
   const server=join(temp,'huahuo-server'),app=join(temp,'huahuo-ai');mkdirSync(server);mkdirSync(app);
   expect(resolveRoots(temp)).toEqual(resolveRoots(server));
   expect(()=>resolveRoots(server,'.')).toThrow('UNSAFE_APP_SERVER_PATHS');
   mkdirSync(join(server,'nested'));expect(()=>resolveRoots(server,'nested')).toThrow('UNSAFE_APP_SERVER_PATHS');
   expect(()=>resolveRoots(server,'../missing')).toThrow();
   symlinkSync(server,join(temp,'alias'));expect(()=>resolveRoots(server,'../alias')).toThrow();
   expect(()=>resolveRoots(server,'../huahuo-ai',()=>{throw new Error('EACCES')})).toThrow('EACCES');
   writeFileSync(join(app,'client.dart'),'original');
   const config={localPath:'../huahuo-ai',repoUrl:null};
   const before=snapshot(server,config,['client.dart']);expect(before.mode).toBe('SOURCE_COPY_NO_GIT');
   writeFileSync(join(app,'client.dart'),'user changed');const after=snapshot(server,config,['client.dart']);
   expect(compare(before,after).changedFiles).toEqual(['client.dart']);
   execFileSync('git',['init','--initial-branch=main',app],{stdio:'ignore'});
   const unborn=snapshot(server,config,['client.dart']);
   expect(unborn).toMatchObject({mode:'GIT_UNBORN',head:null,branch:'main'});
   expect(compare(after,unborn).sourceChanged).toBe(true);
  } finally { rmSync(temp,{recursive:true,force:true}); }
 });
});
