import { createHash } from 'node:crypto';

/** Stable identity helpers; splitting lives in lib/document-processing. */
export const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
export const stableUuid = (value: string): string => { const hash = sha256(value); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`; };
