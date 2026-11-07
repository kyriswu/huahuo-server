import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}

export function seal(value: unknown, secret: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', createHash('sha256').update('idempotency:' + secret).digest(), iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map(item => item.toString('base64url')).join('.');
}

export function unseal<T>(value: string, secret: string): T {
  const [iv, tag, data] = value.split('.').map(item => Buffer.from(item, 'base64url'));
  if (!iv || !tag || !data) throw new Error('INVALID_ENCRYPTED_RESULT');
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update('idempotency:' + secret).digest(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString()) as T;
}
