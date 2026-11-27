import type { Env } from './config.js';

export interface RecorderVerifierConfig { url: string; token: string }

export function loadRecorderVerifier(env: Env): RecorderVerifierConfig | undefined {
  const url = env.RECORDER_VERIFIER_URL?.trim();
  const token = env.RECORDER_VERIFIER_TOKEN?.trim();
  if (!url && !token) return;
  const address = url && URL.canParse(url) ? new URL(url) : undefined;
  if (!token || !address || !['http:', 'https:'].includes(address.protocol) ||
      address.username || address.password || address.search || address.hash) {
    throw new Error('INVALID_CONFIG:RECORDER_VERIFIER');
  }
  return { url: address.href, token };
}
