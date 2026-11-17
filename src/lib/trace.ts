import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';

const context=new AsyncLocalStorage<string>();
export const validTraceId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9._:-]{6,96}$/.test(value);
export const currentTraceId=()=>context.getStore();
export const resolveTraceId=(value?:unknown)=>validTraceId(value)?value:currentTraceId()??randomUUID();
export function withTraceId<T>(traceId:string,execute:()=>T):T{
 if(!validTraceId(traceId))throw new Error('TRACE_ID_INVALID');
 return context.run(traceId,execute);
}
export function traceHeaders(headers?:HeadersInit):Headers{
 const result=new Headers(headers),id=currentTraceId();
 if(id)result.set('X-Trace-Id',id);
 return result;
}
