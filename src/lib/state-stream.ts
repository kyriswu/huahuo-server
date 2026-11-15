import type {FastifyReply,FastifyInstance} from 'fastify';
const streams=new WeakMap<FastifyInstance,Set<()=>void>>();
export function closeStateStreams(app:FastifyInstance){for(const close of streams.get(app)??[])close();}
/** SSE is a shared event-loop socket, with no database/status polling timer. */
export async function streamState<T>(reply:FastifyReply,read:()=>Promise<T>|T,subscribe:(changed:()=>void)=>Promise<()=>void>|(()=>void),terminal:(state:T)=>boolean){
 const initial=await read();reply.hijack();
 reply.raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
 let closed=false,busy=false,dirty=false;let unsubscribe:()=>void=()=>undefined;
 const heartbeat=setInterval(()=>{if(!closed)reply.raw.write(': keepalive\n\n');},15000);heartbeat.unref();
 const group=streams.get(reply.server)??new Set<()=>void>();streams.set(reply.server,group);
 const finish=()=>{close();reply.raw.end();};
 const close=()=>{if(closed)return;closed=true;clearInterval(heartbeat);unsubscribe?.();group.delete(finish);};group.add(finish);reply.raw.on('close',close);
 const send=(value:T)=>{if(closed)return;reply.raw.write('event: update\ndata: '+JSON.stringify(value)+'\n\n');if(terminal(value)){close();reply.raw.end();}};
 const changed=()=>{dirty=true;if(busy||closed)return;busy=true;void(async()=>{while(dirty&&!closed){dirty=false;send(await read());}})().catch(()=>{close();reply.raw.end();}).finally(()=>{busy=false;});};
 unsubscribe=await subscribe(changed);if(closed)unsubscribe();else{send(initial);changed();}
}
