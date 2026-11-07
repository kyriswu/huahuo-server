import { createHash } from 'node:crypto';
/** Role passwords/usernames are deliberately excluded from the database binding. */
export function storeIdentity(databaseUrl:string):string{
  const url=new URL(databaseUrl);
  return 'business-'+createHash('sha256').update(JSON.stringify([url.hostname,url.port||'5432',url.pathname])).digest('hex').slice(0,20);
}
