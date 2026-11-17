import { createHash } from 'node:crypto';

/** Content digest; splitting lives in lib/document-processing. */
export const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
