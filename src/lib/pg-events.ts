import type pg from 'pg';
type Channel='task_events'|'document_parser_callbacks'|'processing_node_events';
/** One shared LISTEN socket per role; notifications only wake readers of durable state. */
export class PgEvents {
 private client?:pg.PoolClient;private connecting?:Promise<void>;private reconnect?:NodeJS.Timeout;private closed=false;private connectedOnce=false;
 private readonly listeners=new Map<string,Set<()=>void>>();
 constructor(private readonly pool:pg.Pool){}
 private changed=(message:pg.Notification)=>{for(const fn of this.listeners.get(message.channel+':'+message.payload)??[])fn();};
 private disconnected=()=>{const client=this.client;this.client=undefined;client?.removeListener('notification',this.changed);client?.removeListener('error',this.disconnected);client?.release(true);if(!this.closed&&this.listeners.size&&!this.reconnect){this.reconnect=setTimeout(()=>{this.reconnect=undefined;void this.connect().catch(this.disconnected);},3000);this.reconnect.unref();}};
 private connect(){
  if(this.closed)return Promise.reject(new Error('EVENTS_CLOSED'));
  if(this.client)return Promise.resolve();
  return this.connecting??=(async()=>{
   const client=await this.pool.connect();
   try{await client.query('LISTEN task_events');await client.query('LISTEN document_parser_callbacks');await client.query('LISTEN processing_node_events');
    if(this.closed){client.release();return;}
    this.client=client;client.on('notification',this.changed);client.on('error',this.disconnected);
    if(this.connectedOnce)for(const callbacks of this.listeners.values())for(const fn of callbacks)fn();this.connectedOnce=true;
   }catch(error){client.release(true);throw error;}
  })().finally(()=>{this.connecting=undefined;});
 }
 async subscribe(channel:Channel,key:string,fn:()=>void){
  const name=channel+':'+key,callbacks=this.listeners.get(name)??new Set();callbacks.add(fn);this.listeners.set(name,callbacks);
  try{await this.connect();}catch{this.disconnected();}
  return ()=>{callbacks.delete(fn);if(!callbacks.size)this.listeners.delete(name);};
 }
 async close(){this.closed=true;if(this.reconnect)clearTimeout(this.reconnect);await this.connecting?.catch(()=>undefined);this.listeners.clear();const client=this.client;this.client=undefined;if(client){client.removeListener('notification',this.changed);client.removeListener('error',this.disconnected);await client.query('UNLISTEN *').catch(()=>undefined);client.release();}}
}
