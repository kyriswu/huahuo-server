import { readdirSync, writeFileSync } from 'node:fs';
const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9_]{2,64}$/.test(name)) throw new Error('Usage: pnpm db:generate descriptive_name');
const versions = readdirSync('migrations').filter(f => /^\d{4}_.*\.sql$/.test(f)).map(f => Number(f.slice(0, 4)));
const version = String(Math.max(0, ...versions) + 1).padStart(4, '0');
const path = `migrations/${version}_${name}.sql`;
writeFileSync(path, '-- Review SQL, role grants and backward compatibility before applying.\n', { flag: 'wx' });
console.log(path);
