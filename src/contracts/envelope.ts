import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
export function requestTrace(headers: Record<string, unknown>) {
  const candidate = headers['x-trace-id'] ?? headers['x-request-id'];
  return typeof candidate === 'string' && /^[A-Za-z0-9._:-]{6,96}$/.test(candidate) ? candidate : randomUUID();
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
  stage: Type.Literal('P06'), mode: Type.Literal('asset-knowledge'),
}), traceId: Type.String() });
