import type { AppConfig, Env } from '../config/config.js';

export interface DiagnosticError {
  [key: string]: unknown;
  type: string;
  message: string;
  stack: string;
  code?: string;
  cause?: DiagnosticError;
  errors?: DiagnosticError[];
}

const sensitiveKey = /password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|credential/i;
const credentialValue = /((?:["']?)(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key(?:[_-]?(?:id|secret))?|security[_-]?token|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie|signature|sig)(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\n,;}\]]+)/gi;
const urlPattern = /\b(?:https?|postgres(?:ql)?|rediss?|mysql|mongodb(?:\+srv)?):\/\/[^\s<>"'`]+/gi;
const censor = '[REDACTED]';

function property(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined;
  try { return Reflect.get(value, key); } catch { return undefined; }
}

function knownSecrets(config: AppConfig, env: Env): string[] {
  const found = new Set<string>(), seen = new WeakSet<object>();
  const add = (value: string) => {
    // Short words would destroy useful stack/file names. Labelled credentials
    // and URL credentials are masked separately, regardless of their length.
    if (value.length >= 8 && found.size < 256) {
      found.add(value);
      try { found.add(encodeURIComponent(value)); } catch { /* Invalid Unicode still has its literal form masked. */ }
      found.add(JSON.stringify(value).slice(1, -1));
    }
  };
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 6) return;
    seen.add(value);
    for (const key of Object.keys(value)) {
      const child = property(value, key);
      if (typeof child === 'string') {
        if (sensitiveKey.test(key)) add(child);
        if (urlPattern.test(child)) {
          try { const url = new URL(child); if (url.password) add(decodeURIComponent(url.password)); } catch { /* Not a connection URL. */ }
        }
        urlPattern.lastIndex = 0;
      } else visit(child, depth + 1);
    }
  };
  visit(config, 0); visit(env, 0);
  return [...found].sort((a, b) => b.length - a.length);
}

/** Only diagnostic fields are allowlisted: never serialize arbitrary driver,
 * request, response, SQL-parameter or configuration properties. */
export function createErrorSerializer(config: AppConfig, env: Env = process.env): (value: unknown) => DiagnosticError {
  const secrets = knownSecrets(config, env);
  const text = (input: string, limit: number): string => {
    // Avoid scanning unbounded provider messages; discard an incomplete final
    // line rather than exposing a credential cut in half at the scan boundary.
    let value = input;
    if (value.length > 65536) {
      const head = value.slice(0, 65536), newline = head.lastIndexOf('\n');
      value = (newline < 0 ? '' : head.slice(0, newline)) + '\n[Diagnostic text truncated]';
    }
    for (const secret of secrets) value = value.split(secret).join(censor);
    value = value.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, censor);
    value = value.replace(urlPattern, raw => {
      try {
        const url = new URL(raw);
        if (url.username || url.password) { url.username = ''; url.password = ''; }
        for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, 'REDACTED');
        if (url.hash) url.hash = 'REDACTED';
        return url.href;
      } catch { return '[REDACTED URL]'; }
    });
    value = value.replace(credentialValue, '$1' + censor)
      .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 ' + censor)
      .replace(/(?<![A-Za-z0-9_])(["']?(?:query|sql|params|parameters|detail|request[_ -]?body|response[_ -]?body|payload)["']?\s*[:=]\s*)[^\n]*/gi, '$1' + censor)
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED EMAIL]')
      .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, '[REDACTED PHONE]')
      .replace(/\p{Cc}/gu, character => ['\n', '\r', '\t'].includes(character) ? character : '');
    return value.length > limit ? value.slice(0, limit) + '\n[truncated]' : value;
  };
  return value => {
    const seen = new WeakSet<object>();
    let remaining = 32768;
    const boundedText = (value: string, limit: number) => {
      if (remaining <= 0) return '';
      const result = text(value, Math.min(limit, remaining));
      remaining -= result.length; return result;
    };
    const serialize = (error: unknown, depth: number): DiagnosticError => {
      if (depth >= 4) return { type: 'Error', message: '[Cause depth limit]', stack: '' };
      if (error && typeof error === 'object') {
        if (seen.has(error)) return { type: 'Error', message: '[Circular error]', stack: '' };
        seen.add(error);
      }
      const name = property(property(error, 'constructor'), 'name'), message = property(error, 'message'), stack = property(error, 'stack'), code = property(error, 'code');
      const result: DiagnosticError = {
        type: boundedText(typeof name === 'string' ? name : 'Error', 120),
        message: boundedText(typeof message === 'string' ? message : typeof error === 'string' ? error : 'Non-Error value thrown', 2048),
        stack: boundedText(typeof stack === 'string' ? stack : '', 16384),
      };
      if (typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(code)) result.code = boundedText(code, 80);
      const cause = property(error, 'cause');
      if (cause !== undefined) result.cause = serialize(cause, depth + 1);
      const errors = property(error, 'errors');
      if (Array.isArray(errors)) result.errors = errors.slice(0, 3).map(child => serialize(child, depth + 1));
      return result;
    };
    try { return serialize(value, 0); }
    catch { return { type: 'Error', message: 'Error serialization failed', stack: '' }; }
  };
}
