import { createHmac } from 'node:crypto';
import { readJsonResponse } from './http-client.js';

type PostNode =
  | { tag: 'text'; text: string; un_escape?: boolean }
  | { tag: 'a'; text: string; href: string }
  | { tag: 'at'; user_id: string; user_name?: string }
  | { tag: 'img'; image_key: string };
type PostLocale = { title?: string; content: readonly (readonly PostNode[])[] };
type Post = { zh_cn: PostLocale; en_us?: PostLocale } | { zh_cn?: PostLocale; en_us: PostLocale };

export type FeishuWebhookMessage =
  | { msg_type: 'text'; content: { text: string } }
  | { msg_type: 'post'; content: { post: Post } }
  | { msg_type: 'image'; content: { image_key: string } }
  | { msg_type: 'share_chat'; content: { share_chat_id: string } }
  | { msg_type: 'interactive'; card: Readonly<Record<string, unknown>> };

export class FeishuWebhookError extends Error {
  constructor(readonly outcome: 'rejected' | 'unknown') {
    super(outcome === 'rejected' ? 'FEISHU_WEBHOOK_REJECTED' : 'FEISHU_WEBHOOK_OUTCOME_UNKNOWN');
    this.name = 'FeishuWebhookError';
  }
}

const requestMaxBytes = 20 * 1024;
const responseMaxBytes = 8 * 1024;
const timeoutMs = 5_000;

export function validateFeishuWebhookUrl(value: string): string {
  const url = URL.parse(value);
  if (url?.origin !== 'https://open.feishu.cn' || url.href !== url.origin + url.pathname
    || !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
    throw new Error('INVALID_FEISHU_WEBHOOK_URL');
  }
  return url.href;
}

export class FeishuWebhook {
  readonly #url: string;
  readonly #signingSecret?: string;

  constructor(url: string, signingSecret?: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.#url = validateFeishuWebhookUrl(url);
    this.#signingSecret = signingSecret;
  }

  async send(message: FeishuWebhookMessage): Promise<void> {
    let body: string;
    try {
      const payload = message.msg_type === 'interactive'
        ? { msg_type: message.msg_type, card: message.card }
        : { msg_type: message.msg_type, content: message.content };
      if (this.#signingSecret) {
        const timestamp = String(Math.floor(Date.now() / 1_000));
        const sign = createHmac('sha256', `${timestamp}\n${this.#signingSecret}`).digest('base64');
        body = JSON.stringify({ ...payload, timestamp, sign });
      } else body = JSON.stringify(payload);
    } catch { throw new FeishuWebhookError('rejected'); }
    if (Buffer.byteLength(body) > requestMaxBytes) throw new FeishuWebhookError('rejected');

    // This third-party request carries no internal trace or identity headers.
    let response: Response;
    try {
      response = await this.fetchImpl(this.#url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw new FeishuWebhookError('unknown'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const rejected = response.status >= 400 && response.status < 500 && response.status !== 408;
      throw new FeishuWebhookError(rejected ? 'rejected' : 'unknown');
    }
    const result = await readJsonResponse(response, responseMaxBytes).catch(() => undefined);
    const code = result && typeof result === 'object' && 'code' in result ? result.code : undefined;
    if (typeof code !== 'number' || !Number.isSafeInteger(code)) throw new FeishuWebhookError('unknown');
    if (code !== 0) throw new FeishuWebhookError('rejected');
  }
}
