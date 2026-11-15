import {existsSync,lstatSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
const directory=resolve('dist');
if(existsSync(directory)&&lstatSync(directory).isSymbolicLink())throw new Error('BUILD_DIST_SYMLINK_FORBIDDEN');
rmSync(directory,{recursive:true,force:true});
