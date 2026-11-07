import { createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DomainError } from './store.js';
const derive = promisify(scrypt);
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
