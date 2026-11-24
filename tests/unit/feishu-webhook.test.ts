import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTraceId } from '../../src/lib/trace.js';
import { FeishuWebhook, type FeishuWebhookMessage, validateFeishuWebhookUrl } from '../../src/integrations/feishu-webhook.js';

const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture-webhook-token';
const text = { msg_type: 'text', content: { text: '测试消息' } } as const;
const messages: FeishuWebhookMessage[] = [
  text,
  { msg_type: 'post', content: { post: { zh_cn: { title: '标题', content: [[
    { tag: 'text', text: '测试' }, { tag: 'a', text: '详情', href: 'https://example.test/' },
    { tag: 'at', user_id: 'ou_fixture' }, { tag: 'img', image_key: 'img_fixture' },
  ]] } } } },
  { msg_type: 'image', content: { image_key: 'img_fixture' } },
  { msg_type: 'share_chat', content: { share_chat_id: 'oc_fixture' } },
  { msg_type: 'interactive', card: { schema: '2.0', body: { elements: [] } } },
];

afterEach(() => vi.restoreAllMocks());

describe('Feishu custom bot webhook with an injected HTTP transport', () => {
  it.each(messages)('sends $msg_type with the documented envelope and no internal headers', async message => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 0, msg: 'success' }));
    await withTraceId('fixture-trace', () => new FeishuWebhook(url, undefined, request).send(message));
    expect(request).toHaveBeenCalledExactlyOnceWith(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message),
      redirect: 'error', signal: expect.any(AbortSignal),
    });
  });

  it('optionally signs an empty string with the timestamp and secret as the HMAC key', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_599_360_473_999);
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 0 }));
    await new FeishuWebhook(url, 'demo', request).send(text);
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual({
      ...text, timestamp: '1599360473', sign: 'l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=',
    });
  });

  it('only accepts the documented HTTPS origin and hook path', () => {
    expect(validateFeishuWebhookUrl(url)).toBe(url);
    for (const invalid of [
      url.replace('https:', 'http:'), url.replace('open.feishu.cn', 'open.feishu.cn.example.test'),
      url.replace('open.feishu.cn', 'open.feishu.cn:444'), url.replace('https://', 'https://user:pass@'),
      `${url}/extra`, `${url}?x=y`, `${url}#fragment`, 'https://open.feishu.cn/open-apis/bot/v2/hook/',
    ]) expect(() => validateFeishuWebhookUrl(invalid)).toThrow('INVALID_FEISHU_WEBHOOK_URL');
  });

  it('rejects an oversized UTF-8 request before sending', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(new FeishuWebhook(url, undefined, request).send({ msg_type: 'text', content: { text: '界'.repeat(7_000) } }))
      .rejects.toMatchObject({ outcome: 'rejected', message: 'FEISHU_WEBHOOK_REJECTED' });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { status: 200, body: '{"code":19021,"msg":"private response"}', outcome: 'rejected' },
    { status: 429, body: 'private response', outcome: 'rejected' },
    { status: 408, body: 'private response', outcome: 'unknown' },
    { status: 302, body: 'private response', outcome: 'unknown' },
    { status: 503, body: 'private response', outcome: 'unknown' },
    { status: 200, body: 'private response', outcome: 'unknown' },
    { status: 200, body: '{"StatusCode":0}', outcome: 'unknown' },
    { status: 200, body: JSON.stringify({ code: 0, msg: 'x'.repeat(8_192) }), outcome: 'unknown' },
  ])('classifies $status / $outcome with no raw diagnostic data or retries', async ({ status, body, outcome }) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
    const error = await new FeishuWebhook(url, undefined, request).send(text).catch(value => value);
    expect(error).toMatchObject({ name: 'FeishuWebhookError', outcome });
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toMatch(/fixture-webhook-token|private response/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses one deadline and hides raw network errors', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const request = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error(`Sensitive network failure: ${url}`)), { once: true });
    }));
    const result = new FeishuWebhook(url, undefined, request).send(text);
    controller.abort();
    await expect(result).rejects.toMatchObject({ outcome: 'unknown', message: 'FEISHU_WEBHOOK_OUTCOME_UNKNOWN' });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(5_000);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
