import { createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { DomainError } from './store.js';
const derive = promisify(scrypt);
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const mac = (secret: string, value: string) => createHmac('sha256', secret).update(value).digest('hex');
export const token = (prefix: string) => prefix + randomBytes(32).toString('base64url');
export const otpCode = () => String(randomInt(0, 1000000)).padStart(6, '0');
export function normalizePhone(value: string) {
  const phone = value.trim();
  if (/^1[3-9]\d{9}$/.test(phone)) return '+86' + phone;
  if (/^\+861[3-9]\d{9}$/.test(phone)) return phone;
  throw new DomainError(400, 'PHONE_INVALID');
}
export const maskedPhone = (phone: string) => phone.slice(3, 6) + '****' + phone.slice(-4);
export function constantEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y);
}
export async function hashPassword(value: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(value, salt, 64) as Buffer;
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
export async function verifyPassword(value: string, stored: string) {
  const [kind, salt, expected] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !expected) return false;
  const hash = await derive(value, salt, 64) as Buffer;
  return constantEqual(hash.toString('hex'), expected);
}
export function seal(value: unknown, secret: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', createHash('sha256').update('idempotency:' + secret).digest(), iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map(x => x.toString('base64url')).join('.');
}
export function unseal<T>(value: string, secret: string): T {
  const [iv, tag, data] = value.split('.').map(x => Buffer.from(x, 'base64url'));
  if (!iv || !tag || !data) throw new Error('INVALID_ENCRYPTED_RESULT');
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update('idempotency:' + secret).digest(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString()) as T;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
