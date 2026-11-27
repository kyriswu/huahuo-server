import type { Env } from './config.js';

export interface RecordingOutlineSettings { url: string; token: string }
export function loadRecordingOutlineConfig(env: Env): RecordingOutlineSettings | undefined {
  const raw = env.RECORDING_OUTLINE_SERVICE_URL?.trim();
  const token = env.RECORDING_OUTLINE_SERVICE_TOKEN;
  if (!raw && !token) return;
  if (!token || !/^[\x21-\x7e]+$/u.test(token)) throw new Error('INVALID_CONFIG:RECORDING_OUTLINE_SERVICE_TOKEN');
  try {
    const url = new URL(raw ?? '');
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error();
    return {url:url.href,token};
  } catch { throw new Error('INVALID_CONFIG:RECORDING_OUTLINE_SERVICE_URL'); }
}
