import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import {validTraceId} from '../lib/trace.js';
export function requestTrace(headers: Record<string, unknown>,url?:string) {
  // Xberg cannot set callback headers; the opaque callback URL carries the same ID.
  if(url?.startsWith('/internal/v1/document-parser/callbacks/')){
    const trace=new URL(url,'http://internal').searchParams.get('traceId');
    if(validTraceId(trace))return trace;
  }
  const candidate = headers['x-trace-id'];
  return validTraceId(candidate) ? candidate : randomUUID();
}
export const success = <T>(data: T, traceId: string) => ({ success: true as const, data, traceId });
export const failure = (code: string, message: string, traceId: string, retryable = false) => ({
  success: false as const, error: { code, message, userMessageKey: `api.error.${code}`, retryable }, traceId,
});
export const ErrorSchema = Type.Object({ success: Type.Literal(false), error: Type.Object({
  code: Type.String(), message: Type.String(), userMessageKey: Type.String(), retryable: Type.Boolean(),
}), traceId: Type.String() });
export const HealthSchema = Type.Object({ success: Type.Literal(true), data: Type.Object({
  service: Type.String(), status: Type.Union([Type.Literal('live'), Type.Literal('ready')]),
  version: Type.String({ minLength: 1 }),
}), traceId: Type.String() });
